// Wait For Me! server: serves the app and a small JSON API.
// Uses Postgres when DATABASE_URL is set, otherwise keeps data in memory.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const store = process.env.DATABASE_URL ? require("./store-postgres") : require("./store-memory");
const { billing } = require("./billing");
const { geocode } = require("./geocode");
const { computeMetrics } = require("./metrics");

const STAGES = ["open", "claimed", "enroute", "inline", "nearfront", "handoff", "done"];
const WAITER_STEPS = ["claimed", "enroute", "inline", "nearfront", "handoff"]; // statuses a waiter can move forward from
const CATS = ["Food", "Releases", "Errands", "Events"];
const COOKIE = "wfm_session";
const SESSION_DAYS = 30;

// ---------- helpers ----------
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 20000) {
        reject(new HttpError(413, "That request is too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "The request couldn't be read."));
      }
    });
    req.on("error", reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, "hex");
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

function sessionCookie(req, token, maxAge) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function startSession(req, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await store.createSession(sha256(token), userId);
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const u = await store.userBySession(sha256(token));
  if (!u || u.suspended) return null;
  // Remember when each person last used the app (at most every 10 minutes) for the dashboard.
  if (!u.lastSeenAt || Date.now() - new Date(u.lastSeenAt).getTime() > 10 * 60 * 1000) store.touchUser(u.id).catch(() => {});
  return u;
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const isAdmin = (u) => !!u && ADMIN_EMAILS.includes(String(u.email).toLowerCase());

const publicUser = (u) =>
  u && { id: u.id, name: u.name, email: u.email, look: u.look, avatar: u.avatar || "", isAdmin: isAdmin(u) };
const AVATARS = Array.from({ length: 10 }, (_, i) => `a${i}`);

// What each person may see. Only the booker sees the swap code. Until a waiter is on the
// line, other users don't see the booker's name, avatar, or notes.
function lineFor(viewer, l) {
  const out = { ...l };
  const isOwner = l.ownerId === viewer.id;
  const isWaiter = l.waiterId === viewer.id;
  if (!isOwner) delete out.code;
  if (!isOwner && !isWaiter) {
    delete out.waiterLook;
    delete out.pos;
    delete out.ownerName;
    delete out.ownerAvatar;
    delete out.notes;
    delete out.checkinDist;
  }
  delete out.swapFails;
  if (!isOwner) delete out.codeResetAt;
  return out;
}

// ---- ratings ----
const RATING_DELAY_MS = 3 * 86400 * 1000; // ratings stay hidden until 3 days after the job
const RATE_WINDOW_MS = 7 * 86400 * 1000; // you can leave a rating for 7 days after the job
const MIN_RATINGS_SHOWN = 3; // an average only shows once someone has 3+ public ratings
const TAGS = {
  waiter: ["On time", "Easy to find", "Good updates", "Friendly"],
  booker: ["On time to swap", "Easy to find", "Clear notes", "Friendly"],
};
function summarize(s) {
  if (!s || s.count < MIN_RATINGS_SHOWN) return { avg: null, count: s ? s.count : 0 };
  return { avg: Math.round((s.sum / s.count) * 10) / 10, count: s.count };
}

// ---- timing rules ----
const EXPIRE_MS = 2 * 3600 * 1000; // open lines leave Find lines 2 hours after their start time
const NOSHOW_MS = 15 * 60 * 1000; // a booker can report a no-show 15 minutes after the start time
const GRACE_MS = 30 * 60 * 1000; // waiter can end the shift 30 minutes after reaching the front
const FREE_CANCEL_MS = 2 * 3600 * 1000; // cancelling 2+ hours before the start is free
const CHECKIN_RADIUS_M = 800; // a check-in within about half a mile of the line counts as verified
const SWAP_TRIES = 5;

const startMs = (l) => (l.startAt ? new Date(l.startAt).getTime() : null);
const isExpired = (l, now = Date.now()) => l.status === "open" && startMs(l) != null && startMs(l) + EXPIRE_MS < now;

function noShowAllowedAt(l) {
  if (!["claimed", "enroute"].includes(l.status) || l.checkinAt) return null;
  const s = startMs(l);
  if (s != null) return s + NOSHOW_MS;
  return l.claimedAt ? new Date(l.claimedAt).getTime() + 60 * 60 * 1000 : null;
}

function cancelOutcome(l, now = Date.now()) {
  if (l.checkinAt) return "cancelled_inline";
  const s = startMs(l);
  if (l.status === "enroute" || s == null || s - now < FREE_CANCEL_MS) return "cancelled_late";
  return "cancelled_free";
}

function metersBetween(a, b) {
  const R = 6371000;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Adds billing, ratings, offers, unread messages, and allowed actions for this viewer.
async function decorate(viewer, list) {
  const now = Date.now();
  const openIds = list.filter((l) => l.status === "open").map((l) => l.id);
  const offers = await store.pendingOffers(openIds);
  const ids = [...new Set([...list.flatMap((l) => [l.ownerId, l.waiterId]), ...offers.map((o) => o.waiterId)].filter(Boolean))];
  const sums = await store.ratingSummaries(ids, new Date(now - RATING_DELAY_MS));
  const doneIds = list.filter((l) => l.status === "done").map((l) => l.id);
  const mine = await store.ratingsByRater(viewer.id, doneIds);
  const chatIds = list.filter((l) => l.waiterId && (l.ownerId === viewer.id || l.waiterId === viewer.id)).map((l) => l.id);
  const unread = await store.unreadCounts(viewer.id, chatIds);
  return list.map((l) => {
    const out = lineFor(viewer, l);
    const isOwner = l.ownerId === viewer.id;
    out.bill = billing(l, now);
    out.expired = isExpired(l, now);
    out.ownerRating = summarize(sums[l.ownerId] && sums[l.ownerId].booker);
    if (l.waiterId) out.waiterRating = summarize(sums[l.waiterId] && sums[l.waiterId].waiter);
    if (chatIds.includes(l.id)) out.unread = unread[l.id] || 0;
    if (l.status === "open") {
      const forLine = offers.filter((o) => o.lineId === l.id);
      if (isOwner) {
        out.offers = forLine.map((o) => ({
          id: o.id, rate: o.rate, waiterName: o.waiterName, waiterAvatar: o.waiterAvatar,
          waiterRating: summarize(sums[o.waiterId] && sums[o.waiterId].waiter),
        }));
      } else {
        const mo = forLine.find((o) => o.waiterId === viewer.id);
        out.myOffer = mo ? { id: mo.id, rate: mo.rate } : null;
      }
    }
    if (isOwner && l.waiterId && l.status !== "done") {
      out.cancelAs = cancelOutcome(l, now);
      out.noShowAt = noShowAllowedAt(l);
    }
    if (l.waiterId === viewer.id && l.status === "handoff" && l.handoffAt) {
      out.graceEndsAt = new Date(l.handoffAt).getTime() + GRACE_MS;
    }
    if (l.status === "done" && l.waiterId && (isOwner || l.waiterId === viewer.id)) {
      const r = mine.find((x) => x.lineId === l.id);
      out.myRating = r ? r.stars : null;
      out.canRate = !r && l.outcome !== "cancelled_free" && !!l.doneAt && now - new Date(l.doneAt).getTime() < RATE_WINDOW_MS;
    }
    return out;
  });
}
const one = async (viewer, l) => (await decorate(viewer, [l]))[0];

const text = (v, field, max, { required = true } = {}) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) fail(400, `Add ${field}.`);
  if (s.length > max) fail(400, `Keep ${field} under ${max} characters.`);
  return s;
};
const num = (v, field, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${field} must be between ${min} and ${max}.`);
  return Math.round(n * 100) / 100;
};

// Rates are set between bookers and waiters; these are only sanity limits.
const MIN_RATE = 5;
const MAX_RATE = 200;

// Hours and rates move in quarter steps (15 minutes, 25 cents).
const quarter = (n) => Math.round(n * 4) / 4;

// Theme parks and similar venues don't allow holding places in line for others.
const BLOCKED_VENUES =
  /\b(disney ?land|disney ?world|disney|magic kingdom|epcot|california adventure|universal studios|universal orlando|islands of adventure|epic universe|six flags|magic mountain|knott'?s|legoland|sea ?world|busch gardens|cedar point|kings island|dollywood|theme park|amusement park|water park)\b/i;
function checkVenue(...texts) {
  if (texts.some((t) => BLOCKED_VENUES.test(t || "")))
    fail(400, "Theme parks don't allow holding places in line for others, so we can't post this line.");
}

function parseStart(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) fail(400, "Pick when the waiter should arrive.");
  const now = Date.now();
  if (t < now - 5 * 60 * 1000) fail(400, "The start time has already passed. Pick a time in the future.");
  if (t > now + 60 * 86400 * 1000) fail(400, "Pick a start time within the next 60 days.");
  return new Date(t);
}

function lineFields(b) {
  const place = text(b.place, "where the line is", 120);
  const what = text(b.what, "what it's for", 120);
  const notes = text(b.notes, "notes", 500, { required: false });
  checkVenue(place, what, notes);
  const startAt = parseStart(b.startAt);
  return {
    place, what, notes,
    cat: CATS.includes(b.cat) ? b.cat : "Errands",
    startAt,
    startText: text(b.startText, "the start time", 60, { required: false }) || startAt.toUTCString(),
    hours: quarter(num(b.hours, "Estimated wait", 0.25, 24)),
    rate: quarter(num(b.rate, "Hourly rate", MIN_RATE, MAX_RATE)),
  };
}

// Simple per-key rate limits (sign-in by IP; posting, offers, and messages by user).
const buckets = new Map();
function limit(key, max, windowMs, message) {
  const now = Date.now();
  const rec = buckets.get(key) || { n: 0, start: now };
  if (now - rec.start > windowMs) {
    rec.n = 0;
    rec.start = now;
  }
  rec.n++;
  buckets.set(key, rec);
  if (rec.n > max) fail(429, message);
}
function limitAuth(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  limit(`auth:${ip}`, 20, 15 * 60 * 1000, "Too many attempts. Wait 15 minutes and try again.");
}

const newCode = () => String(crypto.randomInt(1000, 10000));

// ---------- API ----------
async function api(req, res, urlPath, query) {
  const method = req.method;

  if (urlPath === "/api/health") return send(res, 200, { ok: true, storage: store.kind });

  if (method === "POST" && urlPath === "/api/signup") {
    limitAuth(req);
    const b = await readBody(req);
    if (b.adult !== true) fail(400, "You must be 18 or older to use Wait For Me!.");
    const name = text(b.name, "your name", 60);
    const email = text(b.email, "your email", 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < 8) fail(400, "Use a password with at least 8 characters.");
    const u = await store.createUser({ name, email, pwHash: hashPassword(password) });
    if (!u) fail(409, "An account with that email already exists. Sign in instead.");
    return send(res, 201, { user: publicUser(u) }, { "Set-Cookie": await startSession(req, u.id) });
  }

  if (method === "POST" && urlPath === "/api/login") {
    limitAuth(req);
    const b = await readBody(req);
    const email = String(b.email || "").trim().toLowerCase();
    const u = email && (await store.userByEmail(email));
    if (!u || !checkPassword(String(b.password || ""), u.pwHash)) fail(401, "That email and password don't match.");
    if (u.suspended) fail(403, "This account is suspended. Contact support if you think this is a mistake.");
    return send(res, 200, { user: publicUser(u) }, { "Set-Cookie": await startSession(req, u.id) });
  }

  if (method === "POST" && urlPath === "/api/logout") {
    const token = cookies(req)[COOKIE];
    if (token) await store.deleteSession(sha256(token));
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  // Everything below needs a signed-in user.
  const me = await currentUser(req);
  if (urlPath === "/api/me" && method === "GET") {
    if (!me) return send(res, 200, { user: null });
    const sums = await store.ratingSummaries([me.id], new Date(Date.now() - RATING_DELAY_MS));
    const ratings = { waiter: summarize(sums[me.id].waiter), booker: summarize(sums[me.id].booker) };
    return send(res, 200, { user: publicUser(me), ratings, tags: TAGS });
  }
  if (!me) fail(401, "Sign in to continue.");

  if (urlPath === "/api/me/delete" && method === "POST") {
    limitAuth(req);
    const b = await readBody(req);
    if (!checkPassword(String(b.password || ""), me.pwHash)) fail(403, "That password isn't right. Try again.");
    const busy = [...(await store.listLines({ ownerId: me.id })), ...(await store.listLines({ waiterId: me.id }))]
      .filter((l) => !["open", "done"].includes(l.status));
    if (busy.length) fail(409, "Finish or release your lines that are in progress before deleting your account.");
    await store.deleteUser(me.id);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (urlPath === "/api/me" && method === "PATCH") {
    const b = await readBody(req);
    const fields = {};
    if (b.look !== undefined) fields.look = text(b.look, "what you're wearing", 120, { required: false });
    if (b.avatar !== undefined) {
      if (b.avatar !== "" && !AVATARS.includes(b.avatar)) fail(400, "Pick one of the avatars.");
      fields.avatar = b.avatar;
    }
    return send(res, 200, { user: publicUser(await store.updateUser(me.id, fields)) });
  }

  if (urlPath === "/api/lines" && method === "GET") {
    const scope = query.get("scope");
    const filter =
      scope === "mine" ? { ownerId: me.id } : scope === "shifts" ? { waiterId: me.id } : { openExcept: me.id };
    const list = await store.listLines(filter);
    return send(res, 200, { lines: await decorate(me, list), now: Date.now() });
  }

  if (urlPath === "/api/lines" && method === "POST") {
    const b = await readBody(req);
    limit(`post:${me.id}`, 20, 86400 * 1000, "You've posted a lot of lines today. Try again tomorrow.");
    if ((await store.countLines(me.id, { openOnly: true })) >= 10)
      fail(429, "You have 10 open lines already. Cancel or wait for one to be claimed before posting more.");
    const f = lineFields(b);
    const line = await store.createLine({ ownerId: me.id, ...f, code: newCode() });
    // Look up map coordinates in the background so posting stays instant.
    geocode(line.place).then((g) => g && store.setLineGeo(line.id, g)).catch(() => {});
    return send(res, 201, { line: await one(me, line) });
  }

  const mm = urlPath.match(/^\/api\/lines\/(\d+)\/messages$/);
  if (mm) {
    const id = Number(mm[1]);
    const l = await store.getLine(id);
    if (!l || !l.waiterId || (l.ownerId !== me.id && l.waiterId !== me.id)) fail(404, "Messages aren't available for this line.");
    if (method === "POST") {
      if (l.status === "done") fail(409, "This job is finished, so messages are closed.");
      limit(`msg:${me.id}`, 30, 60 * 1000, "You're sending messages too fast. Wait a moment.");
      const b = await readBody(req);
      await store.addMessage(id, me.id, text(b.body, "a message", 500));
    }
    const list = await store.listMessages(id);
    if (list.length) await store.markRead(id, me.id, list[list.length - 1].id);
    return send(res, 200, { messages: list.map((x) => ({ ...x, mine: x.senderId === me.id })) });
  }

  const m = urlPath.match(
    /^\/api\/lines\/(\d+)\/(cancel|edit|claim|advance|position|release|swap|extend|leave|rate|offer|withdraw-offer|accept-offer|decline-offer|cancel-booking|report-noshow)$/
  );
  if (m && method === "POST") {
    const id = Number(m[1]);
    const action = m[2];
    const l = await store.getLine(id);
    if (!l) fail(404, "That line no longer exists.");
    const b = await readBody(req);
    let updated;

    if (action === "cancel") {
      if (l.ownerId !== me.id) fail(403, "Only the person who posted this line can cancel it.");
      if (l.status !== "open") fail(409, "A waiter is already on this line. Use Cancel booking instead.");
      if (!(await store.deleteLine(id, "open"))) fail(409, "A waiter just claimed this line.");
      return send(res, 200, { ok: true });
    }

    if (action === "edit") {
      if (l.ownerId !== me.id) fail(403, "Only the person who posted this line can edit it.");
      if (l.status !== "open") fail(409, "A waiter already claimed this line, so it can't be edited.");
      const f = lineFields(b);
      const fields = { ...f, approvedHours: f.hours };
      if (f.place !== l.place) Object.assign(fields, { lat: null, lng: null, geoApprox: null });
      updated = await store.updateLine(id, "open", fields);
      if (!updated) fail(409, "A waiter just claimed this line.");
      if (f.place !== l.place) geocode(f.place).then((g) => g && store.setLineGeo(id, g)).catch(() => {});
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "claim") {
      if (l.ownerId === me.id) fail(400, "You can't claim your own line.");
      if (isExpired(l)) fail(409, "This line's start time has passed.");
      updated = await store.updateLine(id, "open", { status: "claimed", waiterId: me.id, claimedAt: new Date() });
      if (!updated) fail(409, "Someone else just claimed this line.");
      await store.closeOtherOffers(id, 0);
      return send(res, 200, { line: await one(me, updated) });
    }

    // ---- waiters can offer a different rate; the booker accepts or declines ----
    if (action === "offer") {
      if (l.ownerId === me.id) fail(400, "You can't make an offer on your own line.");
      if (l.status !== "open" || isExpired(l)) fail(409, "This line is no longer open.");
      if ((await store.countOffersSince(me.id, new Date(Date.now() - 3600 * 1000))) >= 30)
        fail(429, "You've sent a lot of offers this hour. Try again later.");
      const rate = quarter(num(b.rate, "Your rate", MIN_RATE, MAX_RATE));
      if (rate === Number(l.rate)) fail(400, "That's the listed rate. Tap Claim to take it at that rate.");
      await store.upsertOffer(id, me.id, rate);
      return send(res, 200, { line: await one(me, l) });
    }
    if (action === "withdraw-offer") {
      if (!(await store.withdrawOffer(id, me.id))) fail(409, "You don't have an open offer on this line.");
      return send(res, 200, { line: await one(me, l) });
    }
    if (action === "accept-offer" || action === "decline-offer") {
      if (l.ownerId !== me.id) fail(403, "Only the person who posted this line can answer offers.");
      const o = await store.getOffer(Number(b.offerId));
      if (!o || o.lineId !== id || o.status !== "pending") fail(409, "That offer is no longer available.");
      if (action === "decline-offer") {
        await store.setOfferStatus(o.id, "declined");
        return send(res, 200, { line: await one(me, l) });
      }
      if (l.status !== "open") fail(409, "This line was already claimed.");
      updated = await store.updateLine(id, "open", { status: "claimed", waiterId: o.waiterId, rate: o.rate, claimedAt: new Date() });
      if (!updated) fail(409, "This line was just claimed.");
      await store.setOfferStatus(o.id, "accepted");
      await store.closeOtherOffers(id, o.id);
      return send(res, 200, { line: await one(me, updated) });
    }

    // ---- booker actions on a booked line ----
    if (action === "extend") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can add time.");
      if (!["claimed", "enroute", "inline", "nearfront", "handoff"].includes(l.status)) fail(409, "Time can only be added while a waiter is on this line.");
      const approved = Number(l.approvedHours ?? l.hours);
      if (approved + 0.5 > 24) fail(400, "A line can't go past 24 hours.");
      updated = await store.updateLine(id, l.status, { approvedHours: approved + 0.5 });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      return send(res, 200, { line: await one(me, updated) });
    }
    if (action === "cancel-booking") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can cancel it.");
      if (!["claimed", "enroute", "inline", "nearfront", "handoff"].includes(l.status)) fail(409, "This line can't be cancelled now.");
      const outcome = cancelOutcome(l);
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      return send(res, 200, { line: await one(me, updated) });
    }
    if (action === "report-noshow") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can report a no-show.");
      const at = noShowAllowedAt(l);
      if (at == null) fail(409, "Your waiter has already checked in at the line.");
      if (Date.now() < at) fail(409, "You can report a no-show 15 minutes after the start time.");
      const waiterId = l.waiterId;
      updated = await store.updateLine(id, l.status, { status: "open", waiterId: null, pos: null, claimedAt: null });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      await store.incNoShows(waiterId);
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "rate") {
      if (l.ownerId !== me.id && l.waiterId !== me.id) fail(403, "Only people on this job can rate it.");
      if (l.status !== "done" || !l.doneAt || !l.waiterId) fail(409, "You can rate once the job is finished.");
      if (l.outcome === "cancelled_free") fail(409, "This booking was cancelled before it started.");
      if (Date.now() - new Date(l.doneAt).getTime() > RATE_WINDOW_MS) fail(409, "Ratings close 7 days after a job.");
      const stars = Number(b.stars);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail(400, "Pick 1 to 5 stars.");
      const rateeRole = l.ownerId === me.id ? "waiter" : "booker";
      const tags = (Array.isArray(b.tags) ? b.tags : []).filter((t) => TAGS[rateeRole].includes(t)).slice(0, 4);
      const added = await store.addRating({
        lineId: id, raterId: me.id, rateeId: rateeRole === "waiter" ? l.waiterId : l.ownerId,
        rateeRole, stars, tags: tags.join(","),
      });
      if (!added) fail(409, "You already rated this job.");
      return send(res, 200, { line: await one(me, l) });
    }

    // The rest are waiter actions on their own claimed line.
    if (l.waiterId !== me.id) fail(403, "Only the waiter on this line can do that.");

    if (action === "advance") {
      if (!WAITER_STEPS.slice(0, -1).includes(l.status)) fail(409, "This line can't move forward from here.");
      const next = STAGES[STAGES.indexOf(l.status) + 1];
      const fields = { status: next };
      if (next === "handoff") Object.assign(fields, { pos: 1, handoffAt: new Date() });
      if (next === "inline") {
        // Check-in: compare the waiter's location with the line's location.
        const lat = Number(b.lat);
        const lng = Number(b.lng);
        const acc = Math.min(Math.max(Number(b.accuracy) || 0, 0), 500);
        const hasPos = Number.isFinite(lat) && Number.isFinite(lng) && b.lat !== null && b.lng !== null;
        const exact = l.lat != null && l.lng != null && !l.geoApprox;
        if (exact && !hasPos) fail(400, "Turn on location for this app so we can confirm you're at the line, then try again.");
        let verified = false;
        let dist = null;
        if (hasPos && l.lat != null) {
          dist = Math.round(metersBetween({ lat, lng }, { lat: l.lat, lng: l.lng }));
          if (exact && dist - acc > CHECKIN_RADIUS_M) {
            const mi = (dist / 1609.34).toFixed(1);
            fail(400, `You're about ${mi} miles from the line. Check in once you're there.`);
          }
          verified = exact && dist - acc <= CHECKIN_RADIUS_M;
        }
        Object.assign(fields, { checkinAt: new Date(), checkinVerified: verified, checkinDist: dist });
      }
      updated = await store.updateLine(id, l.status, fields);
    } else if (action === "position") {
      if (!["inline", "nearfront"].includes(l.status)) fail(409, "Check in at the line before updating your place.");
      const pos = Math.round(num(b.pos, "Place in line", 1, 100000));
      updated = await store.updateLine(id, l.status, { pos });
    } else if (action === "release") {
      if (!["claimed", "enroute"].includes(l.status)) fail(409, "You can only release a line before you're in it.");
      updated = await store.updateLine(id, l.status, { status: "open", waiterId: null, pos: null, claimedAt: null });
    } else if (action === "swap") {
      if (l.status !== "handoff") fail(409, "Mark that you're at the front before completing the swap.");
      if (String(b.code || "").trim() !== l.code) {
        const fails = (l.swapFails || 0) + 1;
        if (fails >= SWAP_TRIES) {
          await store.updateLine(id, "handoff", { swapFails: 0, code: newCode(), codeResetAt: new Date() });
          fail(400, "Too many wrong codes. For safety we gave the booker a new code. Ask them for it.");
        }
        await store.updateLine(id, "handoff", { swapFails: fails });
        fail(400, `That code doesn't match. ${SWAP_TRIES - fails} ${SWAP_TRIES - fails === 1 ? "try" : "tries"} left before the code resets.`);
      }
      updated = await store.updateLine(id, "handoff", { status: "done", doneAt: new Date(), outcome: "swapped", swapFails: 0 });
    } else if (action === "leave") {
      if (!["inline", "nearfront", "handoff"].includes(l.status)) fail(409, "You can only end a shift while you're in line.");
      const graceOver = l.status === "handoff" && l.handoffAt && Date.now() >= new Date(l.handoffAt).getTime() + GRACE_MS;
      if (graceOver) {
        updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: "customer_noshow" });
      } else {
        if (!billing(l).timeUp)
          fail(409, "You can end the shift once the approved time runs out, or 30 minutes after you reach the front if the booker doesn't show.");
        updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: "time_up" });
      }
    }
    if (!updated) fail(409, "This line changed. Refresh and try again.");
    return send(res, 200, { line: await one(me, updated) });
  }

  // ---- admin (only for emails listed in the ADMIN_EMAILS variable) ----
  if (urlPath.startsWith("/api/admin/")) {
    if (!isAdmin(me)) fail(404, "Not found.");
    if (urlPath === "/api/admin/overview" && method === "GET") {
      const [lines, users] = await Promise.all([store.adminLines(), store.adminUsers()]);
      return send(res, 200, {
        lines: lines.map((l) => ({
          id: l.id, place: l.place, what: l.what, status: l.status, outcome: l.outcome, startText: l.startText,
          startAt: l.startAt, rate: l.rate, ownerId: l.ownerId, ownerName: l.ownerName, waiterId: l.waiterId,
          waiterName: l.waiterName, checkinVerified: l.checkinVerified, createdAt: l.createdAt, bill: billing(l),
        })),
        users: users.map((u) => ({
          id: u.id, name: u.name, email: u.email, suspended: u.suspended, noshows: u.noshows,
          posted: u.posted, worked: u.worked, createdAt: u.createdAt,
        })),
      });
    }
    if (urlPath === "/api/admin/metrics" && method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      return send(res, 200, computeMetrics(await store.metricsData(), { days: q.get("days"), tz: q.get("tz") }));
    }
    const am = urlPath.match(/^\/api\/admin\/(lines|users)\/(\d+)\/(remove|suspend|unsuspend|reset-password)$/);
    if (am && method === "POST") {
      const id = Number(am[2]);
      if (am[1] === "lines" && am[3] === "remove") {
        if (!(await store.adminRemoveLine(id))) fail(404, "That line doesn't exist.");
        return send(res, 200, { ok: true });
      }
      if (am[1] === "users") {
        const u = await store.userById(id);
        if (!u) fail(404, "That user doesn't exist.");
        if (am[3] === "suspend" || am[3] === "unsuspend") {
          if (u.id === me.id) fail(400, "You can't suspend your own account.");
          await store.updateUser(id, { suspended: am[3] === "suspend" });
          if (am[3] === "suspend") await store.deleteSessionsFor(id);
          return send(res, 200, { ok: true });
        }
        if (am[3] === "reset-password") {
          const temp = crypto.randomBytes(6).toString("base64url");
          await store.updateUser(id, { pwHash: hashPassword(temp) });
          await store.deleteSessionsFor(id);
          return send(res, 200, { ok: true, tempPassword: temp });
        }
      }
    }
    fail(404, "Not found.");
  }

  if (process.env.WFM_TEST_HOOKS === "1" && process.env.WFM_SEED_FILE && urlPath === "/api/test/seed-metrics" && method === "POST" && store._seedMetrics) {
    return send(res, 200, { users: await store._seedMetrics(require(process.env.WFM_SEED_FILE)()) });
  }
  // Test-only hook for automated tests (never enabled in production).
  if (process.env.WFM_TEST_HOOKS === "1" && urlPath === "/api/test/shift" && method === "POST" && store._shiftCheckin) {
    const b = await readBody(req);
    return send(res, 200, { ok: await store._shiftCheckin(Number(b.id), Number(b.minutes)) });
  }

  fail(404, "Not found.");
}

// ---------- static files ----------
// Privacy, terms, and support pages. SUPPORT_EMAIL and COMPANY_NAME come from Railway variables.
const PAGES = { "/privacy": "privacy.html", "/terms": "terms.html", "/support": "support.html", "/admin": "admin.html", "/dashboard": "dashboard.html" };
function servePage(res, file) {
  fs.readFile(path.join(ROOT, file), "utf8", (err, html) => {
    if (err) return res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    const email = process.env.SUPPORT_EMAIL || "";
    const contact = email
      ? `<a href="mailto:${email}">${email}</a>`
      : "our support email, which will be listed here before launch";
    const out = html
      .replaceAll("{{CONTACT}}", contact)
      .replaceAll("{{COMPANY}}", process.env.COMPANY_NAME || "Wait For Me!")
      .replaceAll("{{UPDATED}}", "October 17, 2026");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(out);
  });
}

function serveStatic(req, res, urlPath) {
  if (PAGES[urlPath]) return servePage(res, PAGES[urlPath]);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (urlPath === "/" || !path.extname(file)) file = path.join(ROOT, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" || file.endsWith("sw.js") ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let urlPath, query;
  try {
    const u = new URL(req.url, "http://x");
    urlPath = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (!urlPath.startsWith("/api/")) return serveStatic(req, res, urlPath);
  try {
    await api(req, res, urlPath, query);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "Something went wrong on our end. Try again in a moment." });
  }
});

store
  .init()
  .then(() => {
    server.listen(PORT, () => console.log(`Wait For Me! on port ${PORT}, storage: ${store.kind}`));
    // Fill in map coordinates and city names for lines posted before those existed.
    store.linesMissingGeo().then(async (rows) => {
      for (const r of rows) {
        const g = await geocode(r.place);
        if (g) await store.setLineGeo(r.id, g);
      }
    }).catch(() => {});
  })
  .catch((e) => {
    console.error("Could not connect to the database:", e.message);
    process.exit(1);
  });
