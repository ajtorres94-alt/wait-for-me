// Wait For Me! server: serves the app and a small JSON API.
// Uses Postgres when DATABASE_URL is set, otherwise keeps data in memory.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const store = process.env.DATABASE_URL ? require("./store-postgres") : require("./store-memory");
const { billing, kindOf, MAX_ITEM } = require("./billing");
const { geocode } = require("./geocode");
const { computeMetrics } = require("./metrics");
const { sendMail, mailEnabled } = require("./mailer");
const pay = require("./payments");
const push = require("./push");

const STAGES = ["open", "claimed", "enroute", "inline", "nearfront", "handoff", "done"];
const WAITER_STEPS = ["claimed", "enroute", "inline", "nearfront", "handoff"]; // statuses a waiter can move forward from
// Each request's type is its kind ("Pickup" or "Spot"). Older requests may still hold
// Food, Releases, Errands, or Events.
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
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
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
  u && {
    id: u.id, name: u.name, email: u.email, look: u.look, avatar: u.avatar || "", isAdmin: isAdmin(u),
    card: u.cardPm ? u.cardLabel || "Card on file" : null,
    payouts: u.payoutsReady ? "ready" : u.stripeAccount ? "started" : "none",
  };
const paymentsInfo = () => ({ enabled: pay.enabled(), publishableKey: pay.publishableKey(), testMode: pay.testMode() });
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
    delete out.dropoffAddr;
    delete out.itemNote;
  }
  delete out.swapFails;
  if (!isOwner) delete out.codeResetAt;
  delete out.payIntent;
  if (!isOwner) {
    delete out.payError;
    delete out.payHeld;
  }
  if (!isOwner && !isWaiter) {
    delete out.payStatus;
    delete out.payCaptured;
    delete out.payRefunded;
  }
  return out;
}

// ---- ratings ----
const RATING_DELAY_MS = 3 * 86400 * 1000; // ratings stay hidden until 3 days after the job
const RATE_WINDOW_MS = 7 * 86400 * 1000; // you can leave a rating for 7 days after the job
const MIN_RATINGS_SHOWN = 3; // an average only shows once someone has 3+ public ratings
const TAGS = {
  waiter: ["On time", "Easy to find", "Good updates", "Friendly"],
  booker: ["On time", "Easy to find", "Clear notes", "Friendly"],
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
const REPORT_WINDOW_MS = 14 * 86400 * 1000; // problems can be reported up to 14 days after a job
const REPORT_REASONS = ["Waiter didn't show", "Wrong item", "Item missing or damaged", "Charged the wrong amount", "Booker didn't show", "Safety concern", "Something else"];
const BATCH_MAX = 5; // most requests a waiter can claim in one go
// After buying, the waiter holds the item for the meetup window the booker picked; then they can
// close the job. Food can't wait longer than 2 hours.
const MEET_CHOICES = [45, 120, 240]; // minutes
const MAX_QTY = 5; // most of the same item per pickup
const meetMs = (l) => (Number(l.meetWithin) || 120) * 60000;
const meetTxt = (l) => ({ 45: "45 minutes", 120: "2 hours", 240: "4 hours" }[Number(l.meetWithin) || 120] || "2 hours");
const MSG_AFTER_MS = 7 * 86400 * 1000; // messages stay open this long after an uncollected pickup

const startMs = (l) => (l.startAt ? new Date(l.startAt).getTime() : null);
const isExpired = (l, now = Date.now()) => l.status === "open" && startMs(l) != null && startMs(l) + EXPIRE_MS < now;

// A booker can report a no-show 15 minutes after the start time, but never sooner than
// 45 minutes after the claim, so a waiter who claims an ASAP or last-minute job has time to get there.
const TRAVEL_MS = 45 * 60 * 1000;
function noShowAllowedAt(l) {
  if (!["claimed", "enroute"].includes(l.status) || l.checkinAt) return null;
  const s = startMs(l);
  const claimed = l.claimedAt ? new Date(l.claimedAt).getTime() + TRAVEL_MS : null;
  if (s == null) return claimed;
  return Math.max(s + NOSHOW_MS, claimed || 0);
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
  const evIds = [...new Set(list.map((l) => l.eventId).filter(Boolean))];
  const evs = evIds.length ? await store.eventsByIds(evIds) : [];
  const myLines = list.filter((l) => l.waiterId && (l.ownerId === viewer.id || l.waiterId === viewer.id)).map((l) => l.id);
  const myReports = myLines.length ? await store.reportsBy(viewer.id, myLines) : [];
  return list.map((l) => {
    const out = lineFor(viewer, l);
    const isOwner = l.ownerId === viewer.id;
    out.bill = billing(l, now);
    out.expired = isExpired(l, now);
    out.ownerRating = summarize(sums[l.ownerId] && sums[l.ownerId].booker);
    if (l.waiterId) out.waiterRating = summarize(sums[l.waiterId] && sums[l.waiterId].waiter);
    if (chatIds.includes(l.id)) out.unread = unread[l.id] || 0;
    const ev = l.eventId && evs.find((e) => e.id === l.eventId);
    if (ev) out.event = { id: ev.id, name: ev.name, venue: ev.venue };
    if (myLines.includes(l.id)) {
      const mine = myReports.filter((r) => r.lineId === l.id);
      const last = mine[mine.length - 1];
      if (last) out.myReport = { status: last.status, reason: last.reason, resolution: last.resolution, refundCents: last.refundCents };
      out.canReport = l.status !== "done" || (!!l.doneAt && now - new Date(l.doneAt).getTime() < REPORT_WINDOW_MS);
    }
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
    if (kindOf(l) === "pickup" && l.status === "handoff" && l.purchasedAt && (isOwner || l.waiterId === viewer.id)) {
      out.graceEndsAt = new Date(l.purchasedAt).getTime() + meetMs(l);
    } else if (l.waiterId === viewer.id && l.status === "handoff" && l.handoffAt) {
      out.graceEndsAt = new Date(l.handoffAt).getTime() + GRACE_MS;
    }
    if (l.status === "done" && chatIds.includes(l.id)) out.chatOpen = chatStillOpen(l, now);
    if (l.status === "done" && l.waiterId && (isOwner || l.waiterId === viewer.id)) {
      const r = mine.find((x) => x.lineId === l.id);
      out.myRating = r ? r.stars : null;
      out.canRate = !r && l.outcome !== "cancelled_free" && !!l.doneAt && now - new Date(l.doneAt).getTime() < RATE_WINDOW_MS;
    }
    return out;
  });
}
const one = async (viewer, l) => (await decorate(viewer, [l]))[0];
// Messages close when a job ends, except after an uncollected pickup, so the two can arrange a handover.
const chatStillOpen = (l, now = Date.now()) =>
  l.status !== "done" || (l.outcome === "pickup_noshow" && !!l.doneAt && now - new Date(l.doneAt).getTime() < MSG_AFTER_MS);

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
const MIN_RATE = 10;
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

// Things waiters can't be asked to buy: age-restricted or regulated goods, and anything that
// works like cash (a common way to defraud the person paying).
const RESTRICTED =
  /\b(alcohol|alcoholic|liquor|vodka|tequila|whiske?y|bourbon|wine|champagne|six[- ]?pack|tobacco|cigars?|cigarettes?|vapes?|vaping|nicotine|juul|cannabis|marijuana|thc|edibles|dispensary|prescriptions?|rx|firearms?|handguns?|rifles?|shotguns?|ammo|ammunition|lottery|scratchers?|gift ?cards?|prepaid (debit |visa |credit )?cards?|money orders?)\b|(?<!root )\bbeers?\b/i;

function lineFields(b, event = null) {
  const kind = b.kind === "pickup" || b.kind === "spot" ? b.kind : null;
  if (!kind) fail(400, "Choose Pick it up for me or Save my spot.");
  const pickup = kind === "pickup";
  const place = text(b.place || (event ? event.venue : ""), pickup ? "the store or place to buy it" : "where the spot is", 120);
  const notes = text(b.notes, "notes", 500, { required: false });
  const startAt = parseStart(b.startAt);
  const f = {
    kind, place, notes,
    cat: pickup ? "Pickup" : "Spot",
    startAt,
    startText: text(b.startText, "the start time", 60, { required: false }) || startAt.toUTCString(),
    hours: quarter(num(b.hours, "Estimated wait", 0.25, 24)),
    rate: quarter(num(b.rate, "Hourly rate", MIN_RATE, MAX_RATE)),
    item: "", itemDetails: "", itemBackup: "", qty: 1, itemBudget: null, handoff: null, dropoffFee: 0, dropoffAddr: "",
    eventId: event ? event.id : null,
    rush: b.asap === true, // ASAP requests carry a rush fee
  };
  if (!pickup) {
    if (b.spotAgree !== true)
      fail(400, "Confirm this is a spot that's OK to save, not a place in a line. Wait For Me! doesn't allow line-cutting.", "spot_agree");
    f.what = text(b.what, "what the spot is for", 120);
    checkVenue(place, f.what, notes);
    return f;
  }
  f.item = text(b.item, "what to buy", 120);
  f.itemDetails = text(b.itemDetails, "the item details", 200, { required: false });
  f.itemBackup = text(b.itemBackup, "a backup choice", 120, { required: false });
  f.qty = b.qty === undefined ? 1 : Number(b.qty);
  if (!Number.isInteger(f.qty) || f.qty < 1 || f.qty > MAX_QTY) fail(400, `Pick a quantity from 1 to ${MAX_QTY}.`);
  f.itemBudget = num(b.itemBudget, "The most you'll pay for the item", 1, MAX_ITEM);
  f.handoff = b.handoff === "dropoff" ? "dropoff" : "meet";
  if (f.handoff === "dropoff") {
    f.dropoffFee = Math.round(num(b.dropoffFee, "The drop-off fee", 5, 50));
    f.dropoffAddr = text(b.dropoffAddr, "the drop-off address", 200);
  }
  // The waiter holds the item for 4 hours after buying it, so meeting after a show works.
  // (Bookers are asked to meet within 30 minutes for food; the app can't tell what's food.)
  f.meetWithin = b.meetWithin === undefined ? 240 : Number(b.meetWithin);
  if (!MEET_CHOICES.includes(f.meetWithin)) fail(400, "Pick when you'll meet your waiter.");
  f.what = f.item;
  checkVenue(place, f.item, notes);
  if ([f.item, f.itemDetails, f.itemBackup, notes].some((t) => RESTRICTED.test(t || "")))
    fail(400, "Waiters can't buy alcohol, tobacco or vapes, cannabis, prescriptions, weapons, lottery tickets, gift cards, or money orders.");
  return f;
}

// A receipt photo sent as a data URL. Only real JPEG, PNG, or WebP images are kept.
function receiptImage(v, missing = "Add a photo of the receipt.") {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof v === "string" ? v : "");
  if (!m) fail(400, missing);
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 1.2 * 1024 * 1024) fail(413, "That photo is too large. Try again; the app shrinks it automatically.");
  const sig = buf.subarray(0, 12);
  const ok =
    (m[1] === "image/jpeg" && sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) ||
    (m[1] === "image/png" && sig.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (m[1] === "image/webp" && sig.subarray(0, 4).toString() === "RIFF" && sig.subarray(8, 12).toString() === "WEBP");
  if (!ok) fail(400, "That file isn't a photo we can read. Take a picture of the receipt and try again.");
  return { mime: m[1], data: m[2] };
}
const dollars = (n) => "$" + Number(n).toFixed(2);

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

// ---------- payment checks used by line actions ----------
async function requireCard(u) {
  if (pay.enabled() && !u.cardPm) fail(402, "Add a card in Account before posting. You're only charged after the job, for the actual time and the receipt price.", "card_required");
}
async function requirePayouts(u) {
  if (!pay.enabled()) return;
  if (!u.payoutsReady && u.stripeAccount) await pay.refreshPayouts(store, u).catch(() => {});
  if (!u.payoutsReady) fail(402, "Set up payouts in Account first, so we can pay you for this line.", "payouts_required");
}
// Card holds are placed when a waiter is booked and the line starts within a few days.
async function holdIfDue(line) {
  if (!pay.enabled() || !line || !line.waiterId || !pay.holdDue(line)) return line;
  return (await pay.placeHold(store, line)) || line;
}
async function settleIfPaid(line) {
  if (!pay.enabled() || !line || line.status !== "done") return line;
  return (await pay.settle(store, line)) || line;
}
async function releaseIfHeld(line) {
  if (!pay.enabled() || !line) return line;
  return (await pay.releaseHold(store, line)) || line;
}
// Every 10 minutes: place holds that are now due and retry charges that didn't go through.
async function paymentSweep() {
  try {
    for (const l of await store.linesForPayments()) {
      if (l.status === "done") await pay.settle(store, l);
      else if (pay.holdDue(l)) await pay.placeHold(store, l);
    }
  } catch (e) {
    console.error("Payment sweep failed:", e.message);
  }
}
function startPaymentSweeper() {
  if (!pay.enabled()) return;
  setTimeout(paymentSweep, 15000);
  setInterval(paymentSweep, 10 * 60 * 1000);
}

// ---------- phone notifications ----------
const ping = (userId, title, body) => push.notify(store, userId, { title, body });

const publicEvent = (e) => ({ id: e.id, name: e.name, venue: e.venue, startsAt: e.startsAt, endsAt: e.endsAt,
  live: new Date(e.startsAt).getTime() <= Date.now() + 2 * 3600e3, open: e.open || 0, here: e.here || 0, meHere: !!e.meHere });
async function eventFor(eventId) {
  if (eventId === undefined || eventId === null || eventId === "") return null;
  const ev = await store.eventById(Number(eventId));
  if (!ev || new Date(ev.endsAt).getTime() < Date.now()) fail(400, "That event has ended. Pick another, or post without one.");
  return ev;
}

// Claims one open request for this waiter (used by Claim and by claiming several at once).
async function claimLine(me, l) {
  if (l.ownerId === me.id) fail(400, "You can't claim your own request.");
  if (isExpired(l)) fail(409, "This request's start time has passed.");
  let updated = await store.updateLine(l.id, "open", { status: "claimed", waiterId: me.id, claimedAt: new Date() });
  if (!updated) fail(409, "Someone else just claimed this request.");
  await store.closeOtherOffers(l.id, 0);
  updated = await holdIfDue(updated);
  ping(l.ownerId, "Your request was claimed", `${firstName(me.name)} took your request at ${l.place}.`);
  return updated;
}

// New problem reports: a phone alert to each admin and an email to support.
async function notifyAdmins(title, body, reporter, l, rp) {
  try {
    for (const email of ADMIN_EMAILS) {
      const u = await store.userByEmail(email);
      if (u) ping(u.id, title, body);
    }
    const to = process.env.SUPPORT_EMAIL;
    if (to && mailEnabled()) {
      const lines = [`Report #${rp.id} on request #${l.id} (${l.place})`, `From: ${reporter.name} <${reporter.email}>`, `Reason: ${rp.reason}`, rp.details ? `Details: ${rp.details}` : "", "", "Review it on the admin page."];
      await sendMail({ to, subject: title, text: lines.join("\n"), html: lines.map((x) => `<p>${escHtml(x)}</p>`).join("") });
    }
  } catch (e) {
    console.error("Report alert failed:", e.message);
  }
}
const firstName = (n) => String(n || "Someone").split(" ")[0];
// Every 5 minutes: remind bookers 20 minutes before their pickup meetup window ends.
async function meetupSweep() {
  try {
    for (const l of await store.linesAwaitingMeetup()) {
      const end = new Date(l.purchasedAt).getTime() + meetMs(l);
      if (Date.now() < end - 20 * 60000) continue;
      await store.updateLineAny(l.id, { meetReminded: true });
      ping(l.ownerId, "Meet your waiter soon", `${firstName(l.waiterName)} has your ${l.item || l.what}. Meet up in the next 20 minutes, or they can close the job and you'll still be charged.`);
    }
  } catch (e) {
    console.error("Meetup reminders failed:", e.message);
  }
}

// ---------- password reset emails ----------
const RESET_MS = 60 * 60 * 1000;
// Links in emails always point at a known address, never at whatever Host header a request sent.
const KNOWN_HOSTS = ["waitforme.io", "www.waitforme.io", "wait-for-me-production.up.railway.app"];
function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const host = String(req.headers.host || "").toLowerCase();
  if (KNOWN_HOSTS.includes(host)) return `https://${host}`;
  if (/^localhost(:\d+)?$/.test(host)) return `http://${host}`;
  return "https://waitforme.io";
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function resetEmail(name, link) {
  const first = String(name || "").split(" ")[0] || "there";
  const support = process.env.SUPPORT_EMAIL || "";
  const text = [
    `Hi ${first},`,
    "",
    "Someone asked to reset the password for your Wait For Me! account. To choose a new password, open this link:",
    "",
    link,
    "",
    "The link works once and expires in 1 hour.",
    "",
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
    support ? `Questions? Reply to this email or write to ${support}.` : "",
    "",
    "Wait For Me!",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#EEF0F6;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1A1F3D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF0F6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td><span style="display:inline-block;background:#FFCD44;color:#1A1F3D;font-weight:900;font-size:12px;padding:3px 8px;border-radius:3px">No.1</span>
<span style="font-weight:800;font-size:18px;margin-left:6px">Wait For Me!</span></td></tr>
<tr><td style="padding-top:20px;font-size:16px;line-height:1.5">Hi ${escHtml(first)},<br><br>Someone asked to reset the password for your Wait For Me! account. Tap the button to choose a new one.</td></tr>
<tr><td style="padding:22px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#1A1F3D;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px">Choose a new password</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#5D6485">The link works once and expires in 1 hour. If you didn't ask for this, ignore this email and your password won't change.${
    support ? `<br><br>Questions? Reply to this email or write to ${escHtml(support)}.` : ""
  }</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

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

  // ---- forgot password: email a one-time link that works for 1 hour ----
  if (method === "POST" && urlPath === "/api/password/forgot") {
    limitAuth(req);
    const b = await readBody(req);
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter the email you signed up with.");
    if (!mailEnabled()) {
      const help = process.env.SUPPORT_EMAIL ? ` Email ${process.env.SUPPORT_EMAIL} and we'll help you get back in.` : "";
      fail(503, `Password reset emails aren't available yet.${help}`);
    }
    limit(`forgot:${email}`, 3, 60 * 60 * 1000, "We've already sent a few reset emails. Check your inbox and spam folder, or try again in an hour.");
    const u = await store.userByEmail(email);
    // Same answer whether or not the account exists, so this can't be used to look up who has signed up.
    if (u && !u.suspended && (await store.countResetsSince(u.id, new Date(Date.now() - 60 * 60 * 1000))) < 3) {
      const token = crypto.randomBytes(32).toString("base64url");
      await store.createReset(sha256(token), u.id, new Date(Date.now() + RESET_MS));
      const link = `${appUrl(req)}/reset#${token}`;
      sendMail({ to: u.email, subject: "Reset your Wait For Me! password", ...resetEmail(u.name, link) }).catch((e) =>
        console.error("Reset email failed:", e.message)
      );
    }
    return send(res, 200, { ok: true });
  }
  if (method === "POST" && urlPath === "/api/password/reset") {
    limitAuth(req);
    const b = await readBody(req);
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < 8) fail(400, "Use a password with at least 8 characters.");
    const userId = typeof b.token === "string" && b.token.length > 20 ? await store.takeReset(sha256(b.token)) : null;
    const u = userId && (await store.userById(userId));
    if (!u) fail(400, "This reset link has expired or was already used. Request a new one from the sign-in screen.");
    await store.updateUser(u.id, { pwHash: hashPassword(password) });
    await store.deleteSessionsFor(u.id); // signs out every other device
    await store.clearResets(u.id);
    if (u.suspended) return send(res, 200, { ok: true, signedIn: false });
    return send(res, 200, { ok: true, signedIn: true }, { "Set-Cookie": await startSession(req, u.id) });
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
    return send(res, 200, { user: publicUser(me), ratings, tags: TAGS, payments: paymentsInfo() });
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
    await store.clearResets(me.id);
    for (const s of await store.pushSubs(me.id)) await store.deletePushSub(s.endpoint);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  // ---- payments (Stripe) ----
  if (urlPath.startsWith("/api/payments/")) {
    if (!pay.enabled()) fail(404, "Payments aren't switched on yet.");
    if (urlPath === "/api/payments/card/start" && method === "POST") {
      limit(`card:${me.id}`, 10, 60 * 60 * 1000, "Too many card attempts. Try again in an hour.");
      return send(res, 200, await pay.startCardSetup(store, me));
    }
    if (urlPath === "/api/payments/card/finish" && method === "POST") {
      const b = await readBody(req);
      const label = await pay.finishCardSetup(store, me, b.setupIntentId);
      // Retry any holds that failed on this booker's lines now that the card changed.
      for (const l of await store.listLines({ ownerId: me.id })) {
        if (!["open", "done"].includes(l.status) && l.payStatus === "failed" && pay.holdDue(l)) await pay.placeHold(store, l);
      }
      return send(res, 200, { user: publicUser(await store.userById(me.id)), card: label });
    }
    if (urlPath === "/api/payments/payouts/link" && method === "POST") {
      limit(`payout:${me.id}`, 20, 60 * 60 * 1000, "Too many tries. Try again in an hour.");
      if (me.stripeAccount && !me.payoutsReady) await pay.refreshPayouts(store, me);
      return send(res, 200, await pay.payoutLink(store, me, appUrl(req)));
    }
    if (urlPath === "/api/payments/payouts/refresh" && method === "POST") {
      const st = await pay.refreshPayouts(store, me);
      return send(res, 200, { user: publicUser(await store.userById(me.id)), status: st });
    }
    fail(404, "Not found.");
  }

  // ---- phone notifications ----
  if (urlPath === "/api/push/key" && method === "GET") return send(res, 200, { key: push.publicKey() });
  if (urlPath === "/api/push/subscribe" && method === "POST") {
    limit(`push:${me.id}`, 20, 60 * 60 * 1000, "Too many tries. Try again later.");
    const b = await readBody(req);
    const endpoint = String(b.endpoint || "");
    const k = b.keys || {};
    if (endpoint.length > 1000 || !push.allowedEndpoint(endpoint)) fail(400, "This browser's notification service isn't supported.");
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(String(k.p256dh || "")) || !/^[A-Za-z0-9_-]{16,32}$/.test(String(k.auth || ""))) fail(400, "That notification setup couldn't be read.");
    await store.savePushSub(me.id, { endpoint, p256dh: k.p256dh, auth: k.auth });
    return send(res, 200, { ok: true });
  }
  if (urlPath === "/api/push/unsubscribe" && method === "POST") {
    const b = await readBody(req);
    await store.deletePushSub(String(b.endpoint || ""), me.id);
    return send(res, 200, { ok: true });
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

  // ---- events: venue nights where waiters say they're inside ----
  if (urlPath === "/api/events" && method === "GET") {
    return send(res, 200, { events: (await store.upcomingEvents(me.id)).map(publicEvent) });
  }
  const em = urlPath.match(/^\/api\/events\/(\d+)\/here$/);
  if (em && method === "POST") {
    const ev = await store.eventById(Number(em[1]));
    if (!ev || new Date(ev.endsAt).getTime() < Date.now()) fail(404, "That event has ended.");
    const b = await readBody(req);
    await store.setPresence(ev.id, me.id, b.here !== false);
    const now = (await store.upcomingEvents(me.id)).find((e) => e.id === ev.id);
    return send(res, 200, { event: now ? publicEvent(now) : null });
  }

  // ---- claim several open requests at once (one trip to the same stand) ----
  if (urlPath === "/api/lines/claim-batch" && method === "POST") {
    const b = await readBody(req);
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) fail(400, "Pick the requests to claim.");
    if (ids.length > BATCH_MAX) fail(400, `You can claim up to ${BATCH_MAX} at a time.`);
    await requirePayouts(me);
    const results = [];
    for (const id of ids) {
      try {
        const l = await store.getLine(id);
        if (!l) fail(404, "That request no longer exists.");
        results.push({ id, ok: true, line: await one(me, await claimLine(me, l)) });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    return send(res, 200, { results });
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
    const event = await eventFor(b.eventId);
    const f = lineFields(b, event);
    await requireCard(me);
    const line = await store.createLine({ ownerId: me.id, ...f, code: newCode() });
    if (event) {
      // Tell waiters who said they're at this event.
      const who = (await store.presentUserIds(event.id)).filter((id) => id !== me.id);
      const what = f.kind === "pickup" ? `${f.qty > 1 ? `${f.qty} × ` : ""}${f.item}` : f.what;
      for (const id of who) ping(id, `New request at ${event.name}`, `${what} · $${f.rate.toFixed(2)}/hr`);
    }
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
      if (!chatStillOpen(l)) fail(409, "This job is finished, so messages are closed.");
      limit(`msg:${me.id}`, 30, 60 * 1000, "You're sending messages too fast. Wait a moment.");
      const b = await readBody(req);
      const body = text(b.body, "a message", 500);
      await store.addMessage(id, me.id, body);
      const to = l.ownerId === me.id ? l.waiterId : l.ownerId;
      ping(to, `Message from ${firstName(me.name)}`, body);
    }
    const list = await store.listMessages(id);
    if (list.length) await store.markRead(id, me.id, list[list.length - 1].id);
    return send(res, 200, { messages: list.map((x) => ({ ...x, mine: x.senderId === me.id })) });
  }

  const rm = urlPath.match(/^\/api\/lines\/(\d+)\/receipt$/);
  if (rm && method === "GET") {
    const l = await store.getLine(Number(rm[1]));
    if (!l || (l.ownerId !== me.id && l.waiterId !== me.id && !isAdmin(me))) fail(404, "There's no receipt for this job.");
    const r = await store.getReceipt(l.id);
    if (!r) fail(404, "There's no receipt for this job.");
    res.writeHead(200, {
      "Content-Type": r.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    return res.end(Buffer.from(r.data, "base64"));
  }

  const m = urlPath.match(
    /^\/api\/lines\/(\d+)\/(cancel|edit|claim|advance|position|release|swap|extend|leave|rate|offer|withdraw-offer|accept-offer|decline-offer|cancel-booking|report-noshow|purchase|soldout|raise-limit|report)$/
  );
  if (m && method === "POST") {
    const id = Number(m[1]);
    const action = m[2];
    const l = await store.getLine(id);
    if (!l) fail(404, "That line no longer exists.");
    const b = await readBody(req, action === "purchase" || action === "soldout" ? 1800000 : 20000);
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
      const f = lineFields(b, await eventFor(b.eventId));
      const fields = { ...f, approvedHours: f.hours };
      if (f.place !== l.place) Object.assign(fields, { lat: null, lng: null, geoApprox: null });
      updated = await store.updateLine(id, "open", fields);
      if (!updated) fail(409, "A waiter just claimed this line.");
      if (f.place !== l.place) geocode(f.place).then((g) => g && store.setLineGeo(id, g)).catch(() => {});
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "claim") {
      await requirePayouts(me);
      return send(res, 200, { line: await one(me, await claimLine(me, l)) });
    }

    // ---- waiters can offer a different rate; the booker accepts or declines ----
    if (action === "offer") {
      if (l.ownerId === me.id) fail(400, "You can't make an offer on your own line.");
      if (l.status !== "open" || isExpired(l)) fail(409, "This line is no longer open.");
      if ((await store.countOffersSince(me.id, new Date(Date.now() - 3600 * 1000))) >= 30)
        fail(429, "You've sent a lot of offers this hour. Try again later.");
      await requirePayouts(me);
      const rate = quarter(num(b.rate, "Your rate", MIN_RATE, MAX_RATE));
      if (rate === Number(l.rate)) fail(400, "That's the listed rate. Tap Claim to take it at that rate.");
      await store.upsertOffer(id, me.id, rate);
      ping(l.ownerId, "New rate offer", `${firstName(me.name)} offered $${rate.toFixed(2)}/hr for ${l.place}.`);
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
      updated = await holdIfDue(updated);
      ping(o.waiterId, "Your offer was accepted", `You're booked for ${l.place} at $${Number(o.rate).toFixed(2)}/hr.`);
      return send(res, 200, { line: await one(me, updated) });
    }

    // ---- booker actions on a booked line ----
    if (action === "extend") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can add time.");
      if (!["claimed", "enroute", "inline", "nearfront", "handoff"].includes(l.status)) fail(409, "Time can only be added while a waiter is on this line.");
      if (l.purchasedAt) fail(409, "Your waiter already bought the item, so there's no more waiting time to add.");
      const approved = Number(l.approvedHours ?? l.hours);
      if (approved + 0.5 > 24) fail(400, "A line can't go past 24 hours.");
      // If a card hold is in place and doesn't cover the extra time, replace it with a bigger one first.
      if (pay.enabled() && l.payStatus === "held" && pay.maxCharge({ ...l, approvedHours: approved + 0.5 }) > l.payHeld) {
        await pay.placeHold(store, { ...l, approvedHours: approved + 0.5 }, { replace: true });
      }
      updated = await store.updateLine(id, l.status, { approvedHours: approved + 0.5 });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      ping(l.waiterId, "Time added", `${firstName(me.name)} added 30 minutes at ${l.place}.`);
      return send(res, 200, { line: await one(me, updated) });
    }
    if (action === "cancel-booking") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can cancel it.");
      if (!["claimed", "enroute", "inline", "nearfront", "handoff"].includes(l.status)) fail(409, "This line can't be cancelled now.");
      if (l.purchasedAt) fail(409, "Your waiter already bought the item, so this can't be cancelled. Message them to arrange the handover.");
      const outcome = cancelOutcome(l);
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      updated = await settleIfPaid(updated);
      ping(l.waiterId, "Booking cancelled", `${firstName(me.name)} cancelled ${l.place}.${outcome === "cancelled_free" ? "" : " You'll still be paid for it."}`);
      return send(res, 200, { line: await one(me, updated) });
    }
    if (action === "report-noshow") {
      if (l.ownerId !== me.id) fail(403, "Only the person who booked this line can report a no-show.");
      const at = noShowAllowedAt(l);
      if (at == null) fail(409, "Your waiter has already checked in at the line.");
      if (Date.now() < at) fail(409, "You can report a no-show 15 minutes after the start time (and at least 45 minutes after your waiter claimed it).");
      const waiterId = l.waiterId;
      updated = await store.updateLine(id, l.status, { status: "open", waiterId: null, pos: null, claimedAt: null });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      await store.incNoShows(waiterId);
      updated = await releaseIfHeld(updated);
      ping(waiterId, "Removed from a job", `You didn't check in at ${l.place} on time, so the booker reopened it.`);
      return send(res, 200, { line: await one(me, updated) });
    }

    if (action === "report") {
      if (!l.waiterId || (l.ownerId !== me.id && l.waiterId !== me.id)) fail(403, "Only the booker and waiter on this job can report a problem.");
      if (l.status === "done" && (!l.doneAt || Date.now() - new Date(l.doneAt).getTime() > REPORT_WINDOW_MS))
        fail(409, "Problems can be reported up to 14 days after a job. Email support for anything older.");
      const reason = REPORT_REASONS.includes(b.reason) ? b.reason : fail(400, "Pick what went wrong.");
      const details = text(b.details, "what happened", 1000, { required: reason === "Something else" || reason === "Safety concern" });
      if ((await store.countOpenReports(id, me.id)) >= 3) fail(429, "You already have reports open on this job. We'll get back to you soon.");
      limit(`report:${me.id}`, 10, 86400 * 1000, "You've sent a lot of reports today. Email support if it's urgent.");
      const rp = await store.createReport({ lineId: id, reporterId: me.id, reason, details });
      notifyAdmins(`Problem reported on #${id}`, `${firstName(me.name)}: ${reason}${details ? " · " + details.slice(0, 120) : ""}`, me, l, rp);
      return send(res, 200, { line: await one(me, l) });
    }

    if (action === "raise-limit") {
      if (l.ownerId !== me.id) fail(403, "Only the person who posted this can change the item limit.");
      if (kindOf(l) !== "pickup") fail(400, "Only pickups have an item limit.");
      if (l.status === "open") fail(409, "Use Edit to change the limit before a waiter claims it.");
      if (!["claimed", "enroute", "inline", "nearfront"].includes(l.status) || l.purchasedAt) fail(409, "The item was already bought.");
      const budget = num(b.itemBudget, "The new item limit", 1, MAX_ITEM);
      if (budget <= Number(l.itemBudget)) fail(400, `Enter more than the current ${dollars(l.itemBudget)} limit.`);
      // A bigger limit needs a bigger card hold before the waiter can spend it.
      if (pay.enabled() && l.payStatus === "held" && pay.maxCharge({ ...l, itemBudget: budget }) > l.payHeld) {
        await pay.placeHold(store, { ...l, itemBudget: budget }, { replace: true });
      }
      updated = await store.updateLine(id, l.status, { itemBudget: budget });
      if (!updated) fail(409, "This line changed. Refresh and try again.");
      ping(l.waiterId, "Item limit raised", `${firstName(me.name)} raised the limit for ${l.item || l.what} to ${dollars(budget)}.`);
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

    const pickup = kindOf(l) === "pickup";
    if (action === "advance") {
      if (pickup && l.status === "nearfront") fail(409, "Record the purchase with a photo of the receipt to move on.");
      // Saved spots go straight from "saving your spot" to the handover.
      if (!pickup && l.status === "inline") fail(409, "Hand over the spot with the booker's code when they arrive.");
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
      const who = firstName(me.name);
      const say = { enroute: `${who} is on the way to ${l.place}.`, inline: pickup ? `${who} is in line at ${l.place}.` : `${who} is saving your spot.`,
        nearfront: pickup ? `${who} is almost at the register.` : `${who} is almost at the front.`, handoff: `${who} is at the front.` }[next];
      if (updated && say) ping(l.ownerId, "Update on your request", say);
    } else if (action === "position") {
      if (!["inline", "nearfront"].includes(l.status)) fail(409, "Check in at the line before updating your place.");
      const pos = Math.round(num(b.pos, "Place in line", 1, 100000));
      updated = await store.updateLine(id, l.status, { pos });
    } else if (action === "release") {
      if (!["claimed", "enroute"].includes(l.status)) fail(409, "You can only release a line before you're in it.");
      updated = await store.updateLine(id, l.status, { status: "open", waiterId: null, pos: null, claimedAt: null });
    } else if (action === "purchase") {
      if (!pickup) fail(400, "Only pickups have a purchase to record.");
      if (!["inline", "nearfront"].includes(l.status)) fail(409, "Check in at the store before recording the purchase.");
      if (pay.enabled() && l.payStatus !== "held")
        fail(409, "The booker's payment isn't secured yet, so don't buy the item. We've asked them to update their card.", "not_secured");
      const total = Number(b.total);
      if (!Number.isFinite(total) || total < 0.5) fail(400, "Enter the receipt total.");
      if (total > Number(l.itemBudget))
        fail(400, `That's over the ${dollars(l.itemBudget)} limit for this item. Message ${l.ownerName || "the booker"} before buying anything over the limit.`);
      const img = receiptImage(b.receipt);
      await store.saveReceipt(id, img.mime, img.data);
      updated = await store.updateLine(id, l.status, {
        status: "handoff", handoffAt: new Date(), purchasedAt: new Date(), pos: null, hasReceipt: true,
        itemTotal: Math.round(total * 100) / 100, itemNote: text(b.note, "the note", 200, { required: false }),
      });
      if (updated) ping(l.ownerId, "Your item was bought", `${firstName(me.name)} bought ${l.qty > 1 ? `${l.qty} × ` : ""}${l.item || l.what} for ${dollars(total)}. Meet up within ${meetTxt(l)}.`);
    } else if (action === "soldout") {
      if (!pickup) fail(400, "Only pickups can be marked sold out.");
      if (!["inline", "nearfront"].includes(l.status)) fail(409, "Check in at the store first.");
      const img = receiptImage(b.photo, "Add a photo showing it's sold out, like the empty shelf or a sold-out sign.");
      await store.saveReceipt(id, img.mime, img.data);
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: "sold_out", hasReceipt: true });
      if (updated) ping(l.ownerId, "Sold out", `${l.item || l.what} was sold out at ${l.place}. You're only charged for your waiter's time.`);
    } else if (action === "swap") {
      const ready = l.status === "handoff" || (!pickup && ["inline", "nearfront"].includes(l.status));
      if (!ready) fail(409, pickup ? "Record the purchase before handing over the item." : "Check in at the spot first.");
      if (String(b.code || "").trim() !== l.code) {
        const fails = (l.swapFails || 0) + 1;
        if (fails >= SWAP_TRIES) {
          await store.updateLine(id, l.status, { swapFails: 0, code: newCode(), codeResetAt: new Date() });
          fail(400, "Too many wrong codes. For safety we gave the booker a new code. Ask them for it.");
        }
        await store.updateLine(id, l.status, { swapFails: fails });
        fail(400, `That code doesn't match. ${SWAP_TRIES - fails} ${SWAP_TRIES - fails === 1 ? "try" : "tries"} left before the code resets.`);
      }
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: pickup ? "delivered" : "swapped", swapFails: 0 });
    } else if (action === "leave" && pickup && l.purchasedAt) {
      if (Date.now() < new Date(l.purchasedAt).getTime() + meetMs(l))
        fail(409, `If the booker hasn't met you, you can close the job ${meetTxt(l)} after the purchase.`);
      updated = await store.updateLine(id, l.status, { status: "done", doneAt: new Date(), outcome: "pickup_noshow" });
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
    if (action === "release") updated = await releaseIfHeld(updated);
    if (updated.status === "done") updated = await settleIfPaid(updated);
    return send(res, 200, { line: await one(me, updated) });
  }

  // ---- admin (only for emails listed in the ADMIN_EMAILS variable) ----
  if (urlPath.startsWith("/api/admin/")) {
    if (!isAdmin(me)) fail(404, "Not found.");
    if (urlPath === "/api/admin/overview" && method === "GET") {
      const [lines, users] = await Promise.all([store.adminLines(), store.adminUsers()]);
      return send(res, 200, {
        lines: lines.map((l) => ({
          id: l.id, kind: l.kind, place: l.place, what: l.what, status: l.status, outcome: l.outcome, startText: l.startText,
          itemTotal: l.itemTotal, hasReceipt: l.hasReceipt,
          startAt: l.startAt, rate: l.rate, ownerId: l.ownerId, ownerName: l.ownerName, waiterId: l.waiterId,
          waiterName: l.waiterName, checkinVerified: l.checkinVerified, createdAt: l.createdAt, bill: billing(l),
          payStatus: l.payStatus, payCaptured: l.payCaptured, payError: l.payError,
        })),
        users: users.map((u) => ({
          id: u.id, name: u.name, email: u.email, suspended: u.suspended, noshows: u.noshows,
          posted: u.posted, worked: u.worked, createdAt: u.createdAt,
        })),
      });
    }
    if (urlPath === "/api/admin/events" && method === "GET") {
      return send(res, 200, { events: (await store.upcomingEvents(me.id, { all: true })).map(publicEvent) });
    }
    if (urlPath === "/api/admin/events" && method === "POST") {
      const b = await readBody(req);
      const name = text(b.name, "the event name", 100);
      const venue = text(b.venue, "the venue and city", 120);
      const startsAt = Date.parse(b.startsAt), endsAt = Date.parse(b.endsAt);
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) fail(400, "Add when the event starts and ends.");
      if (endsAt <= startsAt) fail(400, "The end has to be after the start.");
      if (endsAt < Date.now()) fail(400, "That event has already ended.");
      if (endsAt - startsAt > 4 * 86400e3) fail(400, "Keep an event under 4 days. Add each day of a fair separately.");
      const ev = await store.createEvent({ name, venue, startsAt: new Date(startsAt), endsAt: new Date(endsAt) });
      geocode(venue).then((g) => g && store.setEventGeo(ev.id, g)).catch(() => {});
      return send(res, 201, { event: publicEvent(ev) });
    }
    const aem = urlPath.match(/^\/api\/admin\/events\/(\d+)\/delete$/);
    if (aem && method === "POST") {
      if (!(await store.deleteEvent(Number(aem[1])))) fail(404, "That event doesn't exist.");
      return send(res, 200, { ok: true });
    }
    if (urlPath === "/api/admin/reports" && method === "GET") {
      const reps = await store.adminReports();
      const out = [];
      for (const r of reps) {
        const l = await store.getLine(r.lineId);
        out.push({ ...r, line: l && { id: l.id, kind: l.kind, place: l.place, what: l.what, status: l.status, outcome: l.outcome,
          ownerName: l.ownerName, waiterName: l.waiterName, ownerId: l.ownerId, waiterId: l.waiterId, bill: billing(l),
          payStatus: l.payStatus, payCaptured: l.payCaptured, payRefunded: l.payRefunded, hasReceipt: l.hasReceipt } });
      }
      return send(res, 200, { reports: out });
    }
    const arm = urlPath.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
    if (arm && method === "POST") {
      const rp = await store.getReport(Number(arm[1]));
      if (!rp || rp.status !== "open") fail(404, "That report is already resolved.");
      const b = await readBody(req);
      const note = text(b.note, "a note for the person who reported it", 500);
      const cents = Math.round(Number(b.refund || 0) * 100);
      if (!Number.isFinite(cents) || cents < 0) fail(400, "Enter a refund amount, or 0.");
      if (cents > 0) {
        if (!pay.enabled()) fail(400, "Payments aren't switched on, so refunds can't be made here.");
        const l = await store.getLine(rp.lineId);
        await pay.refund(store, l, cents, { fromWaiter: b.fromWaiter === true, key: `refund-report-${rp.id}` });
      }
      const done = await store.resolveReport(rp.id, { resolution: note, refundCents: cents });
      if (!done) fail(409, "That report was just resolved.");
      ping(rp.reporterId, "Your report was reviewed", cents > 0 ? `We refunded $${(cents / 100).toFixed(2)}. ${note}` : note);
      return send(res, 200, { report: done });
    }
    if (urlPath === "/api/admin/stripe-check" && method === "POST") {
      if (!pay.enabled()) fail(400, "Stripe isn't set up. Add STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in Railway.");
      const r = await pay.checkKey();
      return send(res, 200, { ...r, publishableMode: pay.publishableKey().startsWith("pk_live_") ? "live" : "test" });
    }
    if (urlPath === "/api/admin/test-email" && method === "POST") {
      if (!mailEnabled()) fail(400, "Email isn't set up yet. Add RESEND_API_KEY in Railway, then redeploy.");
      try {
        await sendMail({
          to: me.email,
          subject: "Wait For Me! test email",
          text: "This is a test from your Wait For Me! admin page. Email sending works.",
          html: "<p>This is a test from your Wait For Me! admin page. Email sending works.</p>",
        });
      } catch (e) {
        fail(502, `The email didn't send: ${e.message}`);
      }
      return send(res, 200, { ok: true, to: me.email });
    }
    if (urlPath === "/api/admin/metrics" && method === "GET") {
      const q = new URL(req.url, "http://x").searchParams;
      return send(res, 200, computeMetrics(await store.metricsData(), { days: q.get("days"), tz: q.get("tz") }));
    }
    const am = urlPath.match(/^\/api\/admin\/(lines|users)\/(\d+)\/(remove|suspend|unsuspend|reset-password)$/);
    if (am && method === "POST") {
      const id = Number(am[2]);
      if (am[1] === "lines" && am[3] === "remove") {
        const gone = await store.getLine(id);
        if (gone && gone.status !== "done") await releaseIfHeld(gone).catch(() => {});
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
          await store.clearResets(id);
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
  if (process.env.WFM_TEST_HOOKS === "1" && urlPath === "/api/test/sweep" && method === "POST") {
    await paymentSweep();
    await meetupSweep();
    return send(res, 200, { ok: true });
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
const PAGES = { "/privacy": "privacy.html", "/terms": "terms.html", "/support": "support.html", "/admin": "admin.html", "/dashboard": "dashboard.html", "/reset": "reset.html" };
function servePage(res, file) {
  fs.readFile(path.join(ROOT, file), "utf8", (err, html) => {
    if (err) return res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    const email = process.env.SUPPORT_EMAIL || "";
    const contact = email
      ? `<a href="mailto:${email}">${email}</a>`
      : "our support email, which will be listed here before launch";
    const out = html
      .replaceAll("{{CONTACT}}", contact)
      .replaceAll("{{COMPANY}}", process.env.COMPANY_NAME || "ATowers Enterprises LLC")
      .replaceAll("{{UPDATED}}", "October 30, 2026");
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
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    if (e instanceof pay.PaymentError) return send(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    send(res, 500, { error: "Something went wrong on our end. Try again in a moment." });
  }
});

store
  .init()
  .then(() => {
    server.listen(PORT, () =>
      console.log(`Wait For Me! on port ${PORT}, storage: ${store.kind}, payments: ${pay.enabled() ? (pay.testMode() ? "Stripe test mode" : "Stripe live") : "off"}`)
    );
    if (pay.enabled()) {
      store
        .syncStripeMode(pay.testMode() ? "test" : "live")
        .then((m) => m.changed && console.log(`Stripe switched from ${m.previous} to ${pay.testMode() ? "test" : "live"} mode: saved cards and payout setups were cleared.`))
        .catch((e) => console.error("Couldn't check Stripe mode:", e.message))
        .finally(startPaymentSweeper);
    }
    if (pay.enabled()) pay.registerDomains(["waitforme.io", "www.waitforme.io"]);
    push.initPush(store).catch((e) => console.error("Couldn't set up notifications:", e.message));
    setInterval(meetupSweep, 5 * 60 * 1000);
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
