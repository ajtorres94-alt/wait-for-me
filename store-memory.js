// In-memory store. Used when no DATABASE_URL is set (local testing).
// Data is shared between phones but is lost whenever the server restarts.

const users = [];
const sessions = new Map(); // tokenHash -> { userId, createdAt }
const lines = [];
const ratings = [];
let nextUser = 1;
let nextLine = 1;
let nextRating = 1;

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

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

  async createUser({ name, email, pwHash }) {
    if (users.some((u) => u.email === email)) return null;
    const u = { id: nextUser++, name, email, pwHash, look: "", avatar: "", createdAt: new Date() };
    users.push(u);
    return u;
  },
  async userByEmail(email) {
    return users.find((u) => u.email === email) || null;
  },
  async updateUser(id, fields) {
    const u = users.find((x) => x.id === id);
    if (u) for (const k of ["look", "avatar"]) if (fields[k] !== undefined) u[k] = fields[k];
    return u || null;
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

  async createLine(f) {
    const now = new Date();
    const l = {
      id: nextLine++, waiterId: null, status: "open", pos: null, checkinAt: null, doneAt: null,
      outcome: null, approvedHours: f.hours, lat: null, lng: null, geoApprox: null, createdAt: now, updatedAt: now, ...f,
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
    if (openExcept) r = r.filter((l) => l.status === "open" && l.ownerId !== openExcept);
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
    if (l) Object.assign(l, { lat: geo.lat, lng: geo.lng, geoApprox: geo.approx });
  },
  async openLinesMissingGeo() {
    return lines.filter((l) => l.status === "open" && l.lat == null).map((l) => ({ id: l.id, place: l.place }));
  },
  // Removes personal details but keeps finished jobs and ratings intact for the other person.
  async deleteUser(id) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].ownerId === id && lines[i].status === "open") lines.splice(i, 1);
    for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k);
    const u = users.find((x) => x.id === id);
    if (u) Object.assign(u, { name: "Deleted user", email: `deleted-${id}@deleted.invalid`, pwHash: "", look: "", avatar: "" });
  },
  async deleteLine(id, expectStatus) {
    const i = lines.findIndex((x) => x.id === id && x.status === expectStatus);
    if (i < 0) return false;
    lines.splice(i, 1);
    return true;
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

  // Test-only: move a line's check-in time back (used by automated tests).
  async _shiftCheckin(id, minutes) {
    const l = lines.find((x) => x.id === id);
    if (l && l.checkinAt) l.checkinAt = new Date(l.checkinAt.getTime() - minutes * 60000);
    if (l && l.doneAt) l.doneAt = new Date(l.doneAt.getTime() - minutes * 60000);
    return !!l;
  },
};
