// Phone notifications (Web Push) with no extra packages.
//
// - VAPID keys identify this server to Apple's, Google's and Mozilla's push services. They're
//   made on first start and saved in the database, so nothing needs setting up in Railway.
//   (Optional: set VAPID_PRIVATE_JWK to use your own key.)
// - Each message is encrypted for the phone it goes to (RFC 8291, "aes128gcm"), so the push
//   services can't read it.
// - iPhones get notifications only after the app is added to the Home Screen (iOS 16.4+).

const crypto = require("crypto");

// Push services the app will send to. Anything else is refused, so a made-up subscription
// can't make the server call other sites.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const b64u = (s) => Buffer.from(String(s), "base64url");

let keys = null; // { priv: KeyObject, pub: base64url of the raw 65-byte public key }
let subject = "mailto:support@waitforme.io";

async function initPush(store) {
  let jwk = null;
  if (process.env.VAPID_PRIVATE_JWK) jwk = JSON.parse(process.env.VAPID_PRIVATE_JWK);
  if (!jwk) {
    const saved = await store.getSetting("vapid_jwk");
    if (saved) jwk = JSON.parse(saved);
  }
  if (!jwk) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = privateKey.export({ format: "jwk" });
    await store.setSetting("vapid_jwk", JSON.stringify(jwk));
  }
  keys = {
    priv: crypto.createPrivateKey({ key: jwk, format: "jwk" }),
    pub: Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]).toString("base64url"),
  };
  if (process.env.SUPPORT_EMAIL) subject = `mailto:${process.env.SUPPORT_EMAIL}`;
}

const publicKey = () => (keys ? keys.pub : null);

function allowedEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (process.env.PUSH_TEST_HOST && u.host === process.env.PUSH_TEST_HOST) return true; // tests only
  return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

// The signed token that tells the push service which server is sending (RFC 8292).
function vapidToken(endpoint) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: keys.priv, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${sig.toString("base64url")}`;
}

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// Encrypts a message for one phone (RFC 8291 with RFC 8188 "aes128gcm" framing).
function encrypt(p256dh, auth, plaintext, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = b64u(p256dh);
  const authSecret = b64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Bad subscription keys");
  if (!ecdh) {
    ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Sends one notification. Returns the push service's status code (201 is success; 404 and
// 410 mean the phone unsubscribed).
async function send(sub, message) {
  if (!keys || !allowedEndpoint(sub.endpoint)) return 0;
  const body = encrypt(sub.p256dh, sub.auth, JSON.stringify(message));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${vapidToken(sub.endpoint)}, k=${keys.pub}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body,
      signal: ctl.signal,
    });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// Sends a notification to every phone a person has turned alerts on for. Never throws.
async function notify(store, userId, { title, body, tag }) {
  if (!keys || !userId) return;
  try {
    const subs = await store.pushSubs(userId);
    await Promise.all(
      subs.map(async (s) => {
        const status = await send(s, { title, body: String(body).slice(0, 240), tag: tag || undefined, url: "/" });
        if (status === 404 || status === 410) await store.deletePushSub(s.endpoint);
      })
    );
  } catch (e) {
    console.error("Notification failed:", e.message);
  }
}

module.exports = { initPush, publicKey, allowedEndpoint, notify, encrypt, vapidToken, _send: send };
