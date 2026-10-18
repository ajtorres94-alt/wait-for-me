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
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}

const COLS = { status: "status", pos: "pos", waiterId: "waiter_id" };

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
      `INSERT INTO lines (owner_id, place, what, cat, start_text, hours, rate, notes, code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
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
};
