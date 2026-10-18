// In-memory store. Used when no DATABASE_URL is set (local testing, or before
// Postgres is added on Railway). Data is shared between phones but is lost
// whenever the server restarts or redeploys.

const users = [];
const sessions = new Map(); // tokenHash -> { userId, createdAt }
const lines = [];
let nextUser = 1;
let nextLine = 1;

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

function withNames(l) {
  if (!l) return null;
  const o = users.find((u) => u.id === l.ownerId);
  const w = l.waiterId ? users.find((u) => u.id === l.waiterId) : null;
  return { ...l, ownerName: o ? o.name : "", waiterName: w ? w.name : null, waiterLook: w ? w.look : null };
}

module.exports = {
  kind: "memory",
  async init() {},

  async createUser({ name, email, pwHash }) {
    if (users.some((u) => u.email === email)) return null;
    const u = { id: nextUser++, name, email, pwHash, look: "", createdAt: new Date() };
    users.push(u);
    return u;
  },
  async userByEmail(email) {
    return users.find((u) => u.email === email) || null;
  },
  async updateUserLook(id, look) {
    const u = users.find((x) => x.id === id);
    if (u) u.look = look;
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
    const l = { id: nextLine++, waiterId: null, status: "open", pos: null, createdAt: now, updatedAt: now, ...f };
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
    return r
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(withNames);
  },
  // Changes a line only if it is still in the expected status (prevents two
  // waiters claiming the same line, or double swaps). Returns null otherwise.
  async updateLine(id, expectStatus, fields) {
    const l = lines.find((x) => x.id === id);
    if (!l || l.status !== expectStatus) return null;
    Object.assign(l, fields, { updatedAt: new Date() });
    return withNames(l);
  },
  async deleteLine(id, expectStatus) {
    const i = lines.findIndex((x) => x.id === id && x.status === expectStatus);
    if (i < 0) return false;
    lines.splice(i, 1);
    return true;
  },
};
