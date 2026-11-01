// In-memory store. Used when no DATABASE_URL is set (local testing).
// Data is shared between phones but is lost whenever the server restarts.

const users = [];
const sessions = new Map(); // tokenHash -> { userId, createdAt }
const lines = [];
const receipts = new Map(); // line id -> { mime, data }
const settings = new Map();
const events = []; // { id, name, venue, startsAt, endsAt, lat, lng, createdAt }
const presence = new Map(); // "eventId:userId" -> Date
const reports = [];
let nextEvent = 1;
let nextReport = 1;
const pushSubs = new Map(); // endpoint -> { endpoint, userId, p256dh, auth, at }
const ratings = [];
const offers = [];
const messages = [];
const reads = new Map(); // "lineId:userId" -> last read message id
const resets = new Map(); // tokenHash -> { userId, expiresAt, usedAt, createdAt }
let nextUser = 1;
let nextLine = 1;
let nextRating = 1;
let nextOffer = 1;
let nextMessage = 1;

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OFFER_MS = 12 * 60 * 60 * 1000;
const EXPIRE_MS = 2 * 60 * 60 * 1000;

function withNames(l) {
  if (!l) return null;
  const o = users.find((u) => u.id === l.ownerId);
  const w = l.waiterId ? users.find((u) => u.id === l.waiterId) : null;
  return {
    ...l, ownerName: o ? o.name : "", ownerAvatar: o ? o.avatar : "",
    waiterName: w ? w.name : null, waiterLook: w ? w.look : null, waiterAvatar: w ? w.avatar : null,
  };
}

module.exports = {
  kind: "memory",
  async init() {},
  async syncStripeMode(mode) {
    const prev = this._stripeMode || null;
    if (prev && prev !== mode) {
      for (const u of users) Object.assign(u, { stripeCustomer: null, stripeAccount: null, cardPm: null, cardLabel: null, payoutsReady: false });
      for (const l of lines) {
        if (l.status !== "done") Object.assign(l, { payIntent: null, payHeld: 0, payStatus: null, payError: null });
        else if (["held", "charge_failed"].includes(l.payStatus)) Object.assign(l, { payStatus: "void", payError: `Started in Stripe ${prev} mode` });
      }
    }
    this._stripeMode = mode;
    return { previous: prev, changed: !!prev && prev !== mode };
  },

  // ---- users and sessions ----
  async createUser({ name, email, pwHash, birthDate = null }) {
    if (users.some((u) => u.email === email)) return null;
    const u = { id: nextUser++, name, email, pwHash, look: "", avatar: "", suspended: false, noshows: 0, createdAt: new Date(), lastSeenAt: null,
      stripeCustomer: null, stripeAccount: null, cardPm: null, cardLabel: null, payoutsReady: false, birthDate };
    users.push(u);
    return u;
  },
  async userByEmail(email) {
    return users.find((u) => u.email === email) || null;
  },
  async userById(id) {
    return users.find((u) => u.id === id) || null;
  },
  async updateUser(id, fields) {
    const u = users.find((x) => x.id === id);
    if (u) for (const k of ["look", "avatar", "suspended", "pwHash", "stripeCustomer", "stripeAccount", "cardPm", "cardLabel", "payoutsReady", "birthDate"]) if (fields[k] !== undefined) u[k] = fields[k];
    return u || null;
  },
  async incNoShows(id) {
    const u = users.find((x) => x.id === id);
    if (u) u.noshows++;
  },
  async createSession(tokenHash, userId) {
    sessions.set(tokenHash, { userId, createdAt: Date.now() });
  },
  async userBySession(tokenHash) {
    const s = sessions.get(tokenHash);
    if (!s || Date.now() - s.createdAt > SESSION_MS) return null;
    return users.find((u) => u.id === s.userId) || null;
  },
  async deleteSession(tokenHash) {
    sessions.delete(tokenHash);
  },
  async deleteSessionsFor(userId) {
    for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k);
  },
  // Removes personal details but keeps finished jobs and ratings intact for the other person.
  async deleteUser(id) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].ownerId === id && lines[i].status === "open") lines.splice(i, 1);
    for (const o of offers) if (o.waiterId === id && o.status === "pending") o.status = "withdrawn";
    await this.deleteSessionsFor(id);
    const u = users.find((x) => x.id === id);
    if (u) Object.assign(u, { name: "Deleted user", email: `deleted-${id}@deleted.invalid`, pwHash: "", look: "", avatar: "" });
  },

  // ---- lines ----
  async createLine(f) {
    const now = new Date();
    const l = {
      id: nextLine++, waiterId: null, status: "open", pos: null, checkinAt: null, doneAt: null, outcome: null,
      approvedHours: f.hours, lat: null, lng: null, geoApprox: null, area: null, swapFails: 0, codeResetAt: null,
      checkinVerified: null, checkinDist: null, handoffAt: null, claimedAt: null, createdAt: now, updatedAt: now,
      payIntent: null, payHeld: 0, payStatus: null, payError: null, payCaptured: 0,
      kind: "spot", item: "", itemDetails: "", qty: 1, itemBackup: "", itemBudget: null, handoff: null, dropoffFee: 0, dropoffAddr: "",
      itemTotal: null, itemNote: "", purchasedAt: null, hasReceipt: false, meetWithin: null, meetReminded: false, eventId: null, rush: false, payRefunded: 0, ...f,
    };
    lines.push(l);
    return withNames(l);
  },
  // ---- events ----
  async createEvent({ name, venue, startsAt, endsAt }) {
    const e = { id: nextEvent++, name, venue, startsAt: new Date(startsAt), endsAt: new Date(endsAt), lat: null, lng: null, createdAt: new Date() };
    events.push(e);
    return { ...e };
  },
  async setEventGeo(id, geo) {
    const e = events.find((x) => x.id === id);
    if (e) Object.assign(e, { lat: geo.lat, lng: geo.lng });
  },
  async deleteEvent(id) {
    const i = events.findIndex((x) => x.id === id);
    if (i < 0) return false;
    events.splice(i, 1);
    for (const k of [...presence.keys()]) if (k.startsWith(id + ":")) presence.delete(k);
    for (const l of lines) if (l.eventId === id) l.eventId = null;
    return true;
  },
  async eventById(id) {
    const e = events.find((x) => x.id === id);
    return e ? { ...e } : null;
  },
  async eventsByIds(ids) {
    return events.filter((e) => ids.includes(e.id)).map((e) => ({ ...e }));
  },
  async upcomingEvents(userId, { all = false } = {}) {
    const now = Date.now();
    const list = events.filter((e) => (all ? +e.endsAt > now - 30 * 86400e3 : +e.endsAt > now && +e.startsAt < now + 7 * 86400e3));
    list.sort((a, b) => (all ? b.startsAt - a.startsAt : a.startsAt - b.startsAt));
    return list.map((e) => {
      const here = [...presence.keys()].filter((k) => k.startsWith(e.id + ":"));
      return { ...e, open: lines.filter((l) => l.eventId === e.id && l.status === "open").length, here: here.length, meHere: presence.has(`${e.id}:${userId}`) };
    });
  },
  async setPresence(eventId, userId, here) {
    if (here) presence.set(`${eventId}:${userId}`, new Date());
    else presence.delete(`${eventId}:${userId}`);
  },
  async presentUserIds(eventId) {
    return [...presence.keys()].filter((k) => k.startsWith(eventId + ":")).map((k) => Number(k.split(":")[1]));
  },
  // ---- problem reports ----
  async createReport({ lineId, reporterId, reason, details }) {
    const r = { id: nextReport++, lineId, reporterId, reason, details, status: "open", resolution: "", refundCents: 0, createdAt: new Date(), resolvedAt: null };
    reports.push(r);
    return { ...r };
  },
  async countOpenReports(lineId, reporterId) {
    return reports.filter((r) => r.lineId === lineId && r.reporterId === reporterId && r.status === "open").length;
  },
  async reportsBy(reporterId, lineIds) {
    return reports.filter((r) => r.reporterId === reporterId && lineIds.includes(r.lineId)).map((r) => ({ ...r }));
  },
  async getReport(id) {
    const r = reports.find((x) => x.id === id);
    return r ? { ...r } : null;
  },
  async adminReports() {
    return reports
      .slice()
      .sort((a, b) => (b.status === "open") - (a.status === "open") || b.createdAt - a.createdAt)
      .map((r) => {
        const u = users.find((x) => x.id === r.reporterId) || {};
        return { ...r, reporterName: u.name, reporterEmail: u.email };
      });
  },
  async resolveReport(id, { resolution, refundCents }) {
    const r = reports.find((x) => x.id === id && x.status === "open");
    if (!r) return null;
    Object.assign(r, { status: "resolved", resolution, refundCents: refundCents || 0, resolvedAt: new Date() });
    return { ...r };
  },
  async getSetting(key) {
    return settings.get(key) ?? null;
  },
  async setSetting(key, value) {
    settings.set(key, value);
  },
  async savePushSub(userId, { endpoint, p256dh, auth }) {
    pushSubs.set(endpoint, { endpoint, userId, p256dh, auth, at: Date.now() });
    const mine = [...pushSubs.values()].filter((s) => s.userId === userId).sort((a, b) => b.at - a.at);
    mine.slice(10).forEach((s) => pushSubs.delete(s.endpoint));
  },
  async pushSubs(userId) {
    return [...pushSubs.values()].filter((s) => s.userId === userId).map(({ endpoint, p256dh, auth }) => ({ endpoint, p256dh, auth }));
  },
  async deletePushSub(endpoint, userId) {
    const s = pushSubs.get(endpoint);
    if (s && (!userId || s.userId === userId)) pushSubs.delete(endpoint);
  },
  async linesAwaitingMeetup() {
    return lines.filter((l) => l.status === "handoff" && l.kind === "pickup" && l.purchasedAt && !l.meetReminded).map(withNames);
  },
  async saveReceipt(lineId, mime, data) {
    receipts.set(lineId, { mime, data });
  },
  async getReceipt(lineId) {
    return receipts.get(lineId) || null;
  },
  async getLine(id) {
    return withNames(lines.find((l) => l.id === id));
  },
  async listLines({ ownerId, waiterId, openExcept }) {
    let r = lines;
    if (ownerId) r = r.filter((l) => l.ownerId === ownerId);
    if (waiterId) r = r.filter((l) => l.waiterId === waiterId);
    if (openExcept) {
      const cutoff = Date.now() - EXPIRE_MS;
      r = r.filter((l) => l.status === "open" && l.ownerId !== openExcept && (!l.startAt || new Date(l.startAt) > cutoff));
      return r
        .slice()
        .sort((a, b) => (a.startAt ? +new Date(a.startAt) : Infinity) - (b.startAt ? +new Date(b.startAt) : Infinity) || b.createdAt - a.createdAt)
        .map(withNames);
    }
    return r.slice().sort((a, b) => b.createdAt - a.createdAt).map(withNames);
  },
  // Changes a line only if it is still in the expected status. Returns null otherwise.
  async updateLine(id, expectStatus, fields) {
    const l = lines.find((x) => x.id === id);
    if (!l || l.status !== expectStatus) return null;
    Object.assign(l, fields, { updatedAt: new Date() });
    return withNames(l);
  },
  async updateLineAny(id, fields) {
    const l = lines.find((x) => x.id === id);
    if (!l) return null;
    Object.assign(l, fields);
    return withNames(l);
  },
  async linesForPayments() {
    const cutoff = Date.now() - 6 * 86400 * 1000;
    return lines
      .filter(
        (l) =>
          (!["open", "done"].includes(l.status) && (!l.payStatus || l.payStatus === "failed")) ||
          (l.status === "done" && ["held", "charge_failed"].includes(l.payStatus) && l.doneAt && new Date(l.doneAt) > cutoff)
      )
      .map(withNames);
  },
  async setLineGeo(id, geo) {
    const l = lines.find((x) => x.id === id);
    if (l) Object.assign(l, { lat: geo.lat, lng: geo.lng, geoApprox: geo.approx, area: geo.area || l.area || null });
  },
  async linesMissingGeo() {
    return lines.filter((l) => l.lat == null || l.area == null).map((l) => ({ id: l.id, place: l.place })).reverse().slice(0, 500);
  },
  async createReset(tokenHash, userId, expiresAt) {
    resets.set(tokenHash, { userId, expiresAt: new Date(expiresAt), usedAt: null, createdAt: new Date() });
  },
  async takeReset(tokenHash) {
    const r = resets.get(tokenHash);
    if (!r || r.usedAt || r.expiresAt <= new Date()) return null;
    r.usedAt = new Date();
    return r.userId;
  },
  async countResetsSince(userId, since) {
    return [...resets.values()].filter((r) => r.userId === userId && r.createdAt > since).length;
  },
  async clearResets(userId) {
    for (const [k, r] of resets) if (r.userId === userId) resets.delete(k);
  },
  // Test-only: make every reset link for a user look expired.
  async _expireResets(userId) {
    for (const r of resets.values()) if (r.userId === userId) r.expiresAt = new Date(Date.now() - 1000);
  },
  async touchUser(id) {
    const u = users.find((x) => x.id === id);
    if (u) u.lastSeenAt = new Date();
  },
  async deleteLine(id, expectStatus) {
    const i = lines.findIndex((x) => x.id === id && x.status === expectStatus);
    if (i < 0) return false;
    receipts.delete(id);
    lines.splice(i, 1);
    for (let k = offers.length - 1; k >= 0; k--) if (offers[k].lineId === id) offers.splice(k, 1);
    return true;
  },
  async countLines(ownerId, { openOnly, since }) {
    return lines.filter((l) => l.ownerId === ownerId && (!openOnly || l.status === "open") && (!since || l.createdAt > since)).length;
  },

  // ---- ratings ----
  async addRating(r) {
    if (ratings.some((x) => x.lineId === r.lineId && x.raterId === r.raterId)) return null;
    const row = { id: nextRating++, createdAt: new Date(), ...r };
    ratings.push(row);
    return row;
  },
  async ratingsByRater(raterId, lineIds) {
    return ratings.filter((r) => r.raterId === raterId && lineIds.includes(r.lineId));
  },
  // Average and count of ratings that are public (job finished 3+ days ago).
  async ratingSummaries(userIds, visibleBefore) {
    const out = {};
    for (const id of userIds) out[id] = { waiter: { sum: 0, count: 0 }, booker: { sum: 0, count: 0 } };
    for (const r of ratings) {
      if (!out[r.rateeId]) continue;
      const l = lines.find((x) => x.id === r.lineId);
      if (!l || !l.doneAt || l.doneAt > visibleBefore) continue;
      const s = out[r.rateeId][r.rateeRole];
      s.sum += r.stars;
      s.count++;
    }
    return out;
  },

  // ---- rate offers from waiters ----
  async upsertOffer(lineId, waiterId, rate) {
    let o = offers.find((x) => x.lineId === lineId && x.waiterId === waiterId && x.status === "pending");
    if (o) Object.assign(o, { rate, createdAt: new Date() });
    else offers.push((o = { id: nextOffer++, lineId, waiterId, rate, status: "pending", createdAt: new Date() }));
    return o;
  },
  async getOffer(id) {
    return offers.find((x) => x.id === id) || null;
  },
  async pendingOffers(lineIds) {
    const cutoff = Date.now() - OFFER_MS;
    return offers
      .filter((o) => o.status === "pending" && lineIds.includes(o.lineId) && o.createdAt > cutoff)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => {
        const w = users.find((u) => u.id === o.waiterId);
        return { ...o, waiterName: w ? w.name : "", waiterAvatar: w ? w.avatar : "" };
      });
  },
  async setOfferStatus(id, status) {
    const o = offers.find((x) => x.id === id && x.status === "pending");
    if (o) o.status = status;
    return o || null;
  },
  async closeOtherOffers(lineId, exceptId) {
    for (const o of offers) if (o.lineId === lineId && o.id !== exceptId && o.status === "pending") o.status = "declined";
  },
  async withdrawOffer(lineId, waiterId) {
    const o = offers.find((x) => x.lineId === lineId && x.waiterId === waiterId && x.status === "pending");
    if (o) o.status = "withdrawn";
    return !!o;
  },
  async countOffersSince(waiterId, since) {
    return offers.filter((o) => o.waiterId === waiterId && o.createdAt > since).length;
  },

  // ---- messages between booker and waiter ----
  async addMessage(lineId, senderId, body) {
    const m = { id: nextMessage++, lineId, senderId, body, createdAt: new Date() };
    messages.push(m);
    return m.id;
  },
  async listMessages(lineId) {
    return messages.filter((m) => m.lineId === lineId).slice(-200).map(({ id, senderId, body, createdAt }) => ({ id, senderId, body, createdAt }));
  },
  async markRead(lineId, userId, lastId) {
    const k = `${lineId}:${userId}`;
    reads.set(k, Math.max(reads.get(k) || 0, lastId));
  },
  async unreadCounts(userId, lineIds) {
    const out = {};
    for (const m of messages) {
      if (!lineIds.includes(m.lineId) || m.senderId === userId) continue;
      if (m.id > (reads.get(`${m.lineId}:${userId}`) || 0)) out[m.lineId] = (out[m.lineId] || 0) + 1;
    }
    return out;
  },
  async countMessagesSince(senderId, since) {
    return messages.filter((m) => m.senderId === senderId && m.createdAt > since).length;
  },

  // ---- admin ----
  async adminLines() {
    return lines.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 150).map(withNames);
  },
  async adminUsers() {
    return users
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 300)
      .map((u) => ({
        ...u,
        posted: lines.filter((l) => l.ownerId === u.id).length,
        worked: lines.filter((l) => l.waiterId === u.id && l.status === "done").length,
      }));
  },
  async metricsData() {
    return {
      users: users.filter((u) => !u.email.endsWith("@deleted.invalid")).map(({ id, name, createdAt, lastSeenAt, suspended, noshows }) => ({ id, name, createdAt, lastSeenAt, suspended, noshows })),
      lines: lines.map((l) => ({ ...l })),
      ratings: ratings.map(({ stars, rateeRole, createdAt }) => ({ stars, rateeRole, createdAt })),
      offers: offers.map(({ status, createdAt }) => ({ status, createdAt })),
      messages: messages.map(({ createdAt }) => ({ createdAt })),
    };
  },
  // Test-only: add made-up history for the dashboard (used by automated tests).
  async _seedMetrics(d) {
    const base = nextUser;
    const map = new Map();
    for (const u of d.users) {
      const id = nextUser++;
      map.set(u.id, id);
      users.push({ look: "", avatar: "", pwHash: "", email: `seed${id}@t.dev`, ...u, id, createdAt: new Date(u.createdAt), lastSeenAt: u.lastSeenAt && new Date(u.lastSeenAt) });
    }
    const dates = ["startAt", "createdAt", "claimedAt", "checkinAt", "doneAt"];
    for (const l of d.lines) {
      const row = { what: "Thing", notes: "", code: "0000", pos: null, swapFails: 0, ...l, id: nextLine++, ownerId: map.get(l.ownerId), waiterId: l.waiterId && map.get(l.waiterId), startText: "" };
      for (const k of dates) if (row[k]) row[k] = new Date(row[k]);
      row.updatedAt = row.createdAt;
      lines.push(row);
    }
    for (const r of d.ratings) ratings.push({ id: nextRating++, ...r, createdAt: new Date(r.createdAt) });
    for (const o of d.offers) offers.push({ id: nextOffer++, lineId: 0, waiterId: 0, rate: 20, ...o, createdAt: new Date(o.createdAt) });
    for (const m of d.messages) messages.push({ id: nextMessage++, lineId: 0, senderId: 0, body: "x", createdAt: new Date(m.createdAt) });
    return nextUser - base;
  },
  async adminRemoveLine(id) {
    const i = lines.findIndex((x) => x.id === id);
    if (i < 0) return false;
    receipts.delete(id);
    lines.splice(i, 1);
    return true;
  },

  // Test-only: move a line's timestamps back (used by automated tests).
  async _shiftCheckin(id, minutes) {
    const l = lines.find((x) => x.id === id);
    if (!l) return false;
    for (const k of ["checkinAt", "doneAt", "handoffAt", "startAt", "claimedAt", "codeResetAt", "purchasedAt"])
      if (l[k]) l[k] = new Date(new Date(l[k]).getTime() - minutes * 60000);
    return true;
  },
};
