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
  return store.userBySession(sha256(token));
}

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, look: u.look, avatar: u.avatar || "" };
const AVATARS = Array.from({ length: 10 }, (_, i) => `a${i}`);

// Only the customer who posted a line ever sees its swap code.
function lineFor(viewer, l) {
  const out = { ...l };
  if (l.ownerId !== viewer.id) delete out.code;
  if (l.ownerId !== viewer.id && l.waiterId !== viewer.id) {
    delete out.waiterLook;
    delete out.pos;
  }
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

// Adds billing, ratings, and "can I rate this?" to lines for this viewer.
async function decorate(viewer, list) {
  const now = Date.now();
  const ids = [...new Set(list.flatMap((l) => [l.ownerId, l.waiterId]).filter(Boolean))];
  const sums = await store.ratingSummaries(ids, new Date(now - RATING_DELAY_MS));
  const doneIds = list.filter((l) => l.status === "done").map((l) => l.id);
  const mine = await store.ratingsByRater(viewer.id, doneIds);
  return list.map((l) => {
    const out = lineFor(viewer, l);
    out.bill = billing(l, now);
    out.ownerRating = summarize(sums[l.ownerId] && sums[l.ownerId].booker);
    if (l.waiterId) out.waiterRating = summarize(sums[l.waiterId] && sums[l.waiterId].waiter);
    if (l.status === "done" && (l.ownerId === viewer.id || l.waiterId === viewer.id)) {
      const r = mine.find((x) => x.lineId === l.id);
      out.myRating = r ? r.stars : null;
      out.canRate = !r && !!l.doneAt && now - new Date(l.doneAt).getTime() < RATE_WINDOW_MS;
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

// Hours and rates move in quarter steps (15 minutes, 25 cents).
const quarter = (n) => Math.round(n * 4) / 4;

// Simple per-IP limit for sign-in and sign-up attempts.
const attempts = new Map();
function limitAuth(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, start: now };
  if (now - rec.start > 15 * 60 * 1000) {
    rec.n = 0;
    rec.start = now;
  }
  rec.n++;
  attempts.set(ip, rec);
  if (rec.n > 20) fail(429, "Too many attempts. Wait 15 minutes and try again.");
}

// ---------- API ----------
async function api(req, res, urlPath, query) {
  const method = req.method;

  if (urlPath === "/api/health") return send(res, 200, { ok: true, storage: store.kind });

  if (method === "POST" && urlPath === "/api/signup") {
    limitAuth(req);
    const b = await readBody(req);
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
    const line = await store.createLine({
      ownerId: me.id,
      place: text(b.place, "where the line is", 120),
      what: text(b.what, "what it's for", 120),
      cat: CATS.includes(b.cat) ? b.cat : "Errands",
      startText: text(b.startText, "when the waiter should arrive", 40),
      hours: quarter(num(b.hours, "Estimated wait", 0.25, 24)),
      rate: quarter(num(b.rate, "Hourly rate", 15, 200)),
      notes: text(b.notes, "notes", 500, { required: false }),
      code: String(crypto.randomInt(1000, 10000)),
    });
    return send(res, 201, { line: await one(me, line) });
  }

  const m = urlPath.match(/^\/api\/lines\/(\d+)\/(cancel|claim|advance|position|release|swap|extend|leave|rate)$/);
  if (m && method === "POST") {
    const id = Number(m[1]);
    const action = m[2];
    const l = await store.getLine(id);
    if (!l) fail(404, "That line no longer exists.");
    const b = await readBody(req);
    let updated;

    if (action === "cancel") {
      if (l.ownerId !== me.id) fail(403, "Only the person who posted this line can cancel it.");
      if (l.status !== "open") fail(409, "A waiter already claimed this line, so it can't be cancelled here yet.");
      if (!(await store.deleteLine(id, "open"))) fail(409, "A waiter just claimed this line.");
      return send(res, 200, { ok: true });
    }

    if (action === "claim") {
      if (l.ownerId === me.id) fail(400, "You can't claim your own line.");
      updated = await store.updateLine(id, "open", { status: "claimed", waiterId: me.id });
      if (!updated) fail(409, "Someone else just claimed this line.");
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "extend") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can add time.");
      if (!["claimed", "enroute", "inline", "nearfront", "handoff"].includes(l.status)) fail(409, "Time can only be added while a waiter is on this line.");
      const approved = Number(l.approvedHours ?? l.hours);
      if (approved + 0.5 > 24) fail(400, "A line can't go past 24 hours.");
      updated = await store.updateLine(id, l.status, { approvedHours: approved + 0.5 });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "rate") {
      if (l.ownerId !== me.id && l.waiterId !== me.id) fail(403, "Only people on this job can rate it.");
      if (l.status !== "done" || !l.doneAt) fail(409, "You can rate once the job is finished.");
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
      if (next === "handoff") fields.pos = 1;
      if (next === "inline") fields.checkinAt = new Date();
      updated = await store.updateLine(id, l.status, fields);
    } else if (action === "position") {
      if (!["inline", "nearfront"].includes(l.status)) fail(409, "Check in at the line before updating your place.");
      const pos = Math.round(num(b.pos, "Place in line", 1, 100000));
      updated = await store.updateLine(id, l.status, { pos });
    } else if (action === "release") {
      if (!["claimed", "enroute"].includes(l.status)) fail(409, "You can only release a line before you're in it.");
      updated = await store.updateLine(id, l.status, { status: "open", waiterId: null, pos: null });
    } else if (action === "swap") {
      if (l.status !== "handoff") fail(409, "Mark that you're at the front before completing the swap.");
      if (String(b.code || "").trim() !== l.code) fail(400, "That code doesn't match. Check it with the customer and try again.");
      updated = await store.updateLine(id, "handoff", { status: "done", doneAt: new Date(), outcome: "swapped" });
    } else if (action === "leave") {
      if (!["inline", "nearfront", "handoff"].includes(l.status)) fail(409, "You can only end a shift while you're in line.");
      if (!billing(l).timeUp) fail(409, "You can end the shift once the approved time runs out. Ask your customer to add time if the line is still moving.");
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: "time_up" });
    }
    if (!updated) fail(409, "This line changed. Refresh and try again.");
    return send(res, 200, { line: await one(me, updated) });
  }

  // Test-only hook for automated tests (never enabled in production).
  if (process.env.WFM_TEST_HOOKS === "1" && urlPath === "/api/test/shift" && method === "POST" && store._shiftCheckin) {
    const b = await readBody(req);
    return send(res, 200, { ok: await store._shiftCheckin(Number(b.id), Number(b.minutes)) });
  }

  fail(404, "Not found.");
}

// ---------- static files ----------
function serveStatic(req, res, urlPath) {
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
  })
  .catch((e) => {
    console.error("Could not connect to the database:", e.message);
    process.exit(1);
  });
