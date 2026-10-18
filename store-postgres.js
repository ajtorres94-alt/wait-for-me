// Postgres store. Used automatically when DATABASE_URL is set (Railway sets it
// once you add a Postgres database and link it to this service).

const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  look TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lines (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES users(id),
  waiter_id INT REFERENCES users(id),
  place TEXT NOT NULL,
  what TEXT NOT NULL,
  cat TEXT NOT NULL,
  start_text TEXT NOT NULL,
  hours NUMERIC NOT NULL,
  rate NUMERIC NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  pos INT,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lines_status_idx ON lines(status);
CREATE INDEX IF NOT EXISTS lines_owner_idx ON lines(owner_id);
CREATE INDEX IF NOT EXISTS lines_waiter_idx ON lines(waiter_id);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS checkin_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS approved_hours NUMERIC;
UPDATE lines SET approved_hours = hours WHERE approved_hours IS NULL;
UPDATE lines SET done_at = updated_at WHERE status = 'done' AND done_at IS NULL;
CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  line_id INT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  rater_id INT NOT NULL REFERENCES users(id),
  ratee_id INT NOT NULL REFERENCES users(id),
  ratee_role TEXT NOT NULL,
  stars INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_id, rater_id)
);
CREATE INDEX IF NOT EXISTS ratings_ratee_idx ON ratings(ratee_id);
`;

const LINE_SELECT = `
SELECT l.*, o.name AS owner_name, w.name AS waiter_name, w.look AS waiter_look
FROM lines l
JOIN users o ON o.id = l.owner_id
LEFT JOIN users w ON w.id = l.waiter_id`;

function user(r) {
  return r && { id: r.id, email: r.email, name: r.name, pwHash: r.pw_hash, look: r.look, createdAt: r.created_at };
}
function line(r) {
  return (
    r && {
      id: r.id,
      ownerId: r.owner_id,
      waiterId: r.waiter_id,
      ownerName: r.owner_name,
      waiterName: r.waiter_name,
      waiterLook: r.waiter_look,
      place: r.place,
      what: r.what,
      cat: r.cat,
      startText: r.start_text,
      hours: Number(r.hours),
      rate: Number(r.rate),
      notes: r.notes,
      status: r.status,
      pos: r.pos,
      code: r.code,
      checkinAt: r.checkin_at,
      doneAt: r.done_at,
      outcome: r.outcome,
      approvedHours: r.approved_hours == null ? Number(r.hours) : Number(r.approved_hours),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}

const COLS = {
  status: "status",
  pos: "pos",
  waiterId: "waiter_id",
  checkinAt: "checkin_at",
  doneAt: "done_at",
  outcome: "outcome",
  approvedHours: "approved_hours",
};

module.exports = {
  kind: "postgres",
  async init() {
    await pool.query(SCHEMA);
  },

  async createUser({ name, email, pwHash }) {
    const r = await pool.query(
      "INSERT INTO users (name, email, pw_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING *",
      [name, email, pwHash]
    );
    return user(r.rows[0]) || null;
  },
  async userByEmail(email) {
    const r = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return user(r.rows[0]) || null;
  },
  async updateUserLook(id, look) {
    const r = await pool.query("UPDATE users SET look = $2 WHERE id = $1 RETURNING *", [id, look]);
    return user(r.rows[0]) || null;
  },

  async createSession(tokenHash, userId) {
    await pool.query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)", [tokenHash, userId]);
  },
  async userBySession(tokenHash) {
    const r = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.created_at > now() - interval '30 days'`,
      [tokenHash]
    );
    return user(r.rows[0]) || null;
  },
  async deleteSession(tokenHash) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  },

  async createLine(f) {
    const r = await pool.query(
      `INSERT INTO lines (owner_id, place, what, cat, start_text, hours, rate, notes, code, approved_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6) RETURNING id`,
      [f.ownerId, f.place, f.what, f.cat, f.startText, f.hours, f.rate, f.notes, f.code]
    );
    return this.getLine(r.rows[0].id);
  },
  async getLine(id) {
    const r = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [id]);
    return line(r.rows[0]) || null;
  },
  async listLines({ ownerId, waiterId, openExcept }) {
    let where, args;
    if (ownerId) [where, args] = ["l.owner_id = $1", [ownerId]];
    else if (waiterId) [where, args] = ["l.waiter_id = $1", [waiterId]];
    else [where, args] = ["l.status = 'open' AND l.owner_id <> $1", [openExcept]];
    const r = await pool.query(`${LINE_SELECT} WHERE ${where} ORDER BY l.created_at DESC LIMIT 200`, args);
    return r.rows.map(line);
  },
  async updateLine(id, expectStatus, fields) {
    const sets = [];
    const args = [id, expectStatus];
    for (const [k, v] of Object.entries(fields)) {
      if (!COLS[k]) continue;
      args.push(v);
      sets.push(`${COLS[k]} = $${args.length}`);
    }
    sets.push("updated_at = now()");
    const r = await pool.query(
      `UPDATE lines SET ${sets.join(", ")} WHERE id = $1 AND status = $2 RETURNING id`,
      args
    );
    return r.rows[0] ? this.getLine(id) : null;
  },
  async deleteLine(id, expectStatus) {
    const r = await pool.query("DELETE FROM lines WHERE id = $1 AND status = $2", [id, expectStatus]);
    return r.rowCount > 0;
  },

  // ---- ratings ----
  async addRating(r) {
    const q = await pool.query(
      `INSERT INTO ratings (line_id, rater_id, ratee_id, ratee_role, stars, tags)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (line_id, rater_id) DO NOTHING RETURNING id`,
      [r.lineId, r.raterId, r.rateeId, r.rateeRole, r.stars, r.tags]
    );
    return q.rows[0] || null;
  },
  async ratingsByRater(raterId, lineIds) {
    if (!lineIds.length) return [];
    const q = await pool.query(
      "SELECT line_id, stars FROM ratings WHERE rater_id = $1 AND line_id = ANY($2::int[])",
      [raterId, lineIds]
    );
    return q.rows.map((r) => ({ lineId: r.line_id, stars: r.stars }));
  },
  // Average and count of ratings that are public (job finished 3+ days ago).
  async ratingSummaries(userIds, visibleBefore) {
    const out = {};
    for (const id of userIds) out[id] = { waiter: { sum: 0, count: 0 }, booker: { sum: 0, count: 0 } };
    if (!userIds.length) return out;
    const q = await pool.query(
      `SELECT r.ratee_id, r.ratee_role, SUM(r.stars)::int AS sum, COUNT(*)::int AS count
       FROM ratings r JOIN lines l ON l.id = r.line_id
       WHERE r.ratee_id = ANY($1::int[]) AND l.done_at IS NOT NULL AND l.done_at <= $2
       GROUP BY r.ratee_id, r.ratee_role`,
      [userIds, visibleBefore]
    );
    for (const row of q.rows) out[row.ratee_id][row.ratee_role] = { sum: row.sum, count: row.count };
    return out;
  },
};
