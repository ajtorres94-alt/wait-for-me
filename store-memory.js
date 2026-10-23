// In-memory store. Used when no DATABASE_URL is set (local testing).
// Data is shared between phones but is lost whenever the server restarts.

const users = [];
const sessions = new Map(); // tokenHash -> { userId, createdAt }
const lines = [];
const ratings = [];
const offers = [];
const messages = [];
const reads = new Map(); // "lineId:userId" -> last read message id
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

  // ---- users and sessions ----
  async createUser({ name, email, pwHash }) {
    if (users.some((u) => u.email === email)) return null;
    const u = { id: nextUser++, name, email, pwHash, look: "", avatar: "", suspended: false, noshows: 0, createdAt: new Date(), lastSeenAt: null };
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
    if (u) for (const k of ["look", "avatar", "suspended", "pwHash"]) if (fields[k] !== undefined) u[k] = fields[k];
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
      checkinVerified: null, checkinDist: null, handoffAt: null, claimedAt: null, createdAt: now, updatedAt: now, ...f,
    };
    lines.push(l);
    return withNames(l);
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
  async setLineGeo(id, geo) {
    const l = lines.find((x) => x.id === id);
    if (l) Object.assign(l, { lat: geo.lat, lng: geo.lng, geoApprox: geo.approx, area: geo.area || l.area || null });
  },
  async linesMissingGeo() {
    return lines.filter((l) => l.lat == null || l.area == null).map((l) => ({ id: l.id, place: l.place })).reverse().slice(0, 500);
  },
  async touchUser(id) {
    const u = users.find((x) => x.id === id);
    if (u) u.lastSeenAt = new Date();
  },
  async deleteLine(id, expectStatus) {
    const i = lines.findIndex((x) => x.id === id && x.status === expectStatus);
    if (i < 0) return false;
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
    lines.splice(i, 1);
    return true;
  },

  // Test-only: move a line's timestamps back (used by automated tests).
  async _shiftCheckin(id, minutes) {
    const l = lines.find((x) => x.id === id);
    if (!l) return false;
    for (const k of ["checkinAt", "doneAt", "handoffAt", "startAt", "claimedAt", "codeResetAt"])
      if (l[k]) l[k] = new Date(new Date(l[k]).getTime() - minutes * 60000);
    return true;
  },
};
