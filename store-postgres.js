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
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE lines ADD COLUMN IF NOT EXISTS checkin_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS geo_approx BOOLEAN;
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
CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  line_id INT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  waiter_id INT NOT NULL REFERENCES users(id),
  rate NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_line_idx ON offers(line_id);
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_pending ON offers(line_id, waiter_id) WHERE status = 'pending';
`;

const LINE_SELECT = `
SELECT l.*, o.name AS owner_name, o.avatar AS owner_avatar,
  w.name AS waiter_name, w.look AS waiter_look, w.avatar AS waiter_avatar
FROM lines l
JOIN users o ON o.id = l.owner_id
LEFT JOIN users w ON w.id = l.waiter_id`;

function user(r) {
  return r && { id: r.id, email: r.email, name: r.name, pwHash: r.pw_hash, look: r.look, avatar: r.avatar || "", createdAt: r.created_at };
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
      ownerAvatar: r.owner_avatar || "",
      waiterAvatar: r.waiter_avatar || null,
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
      lat: r.lat,
      lng: r.lng,
      geoApprox: r.geo_approx,
      doneAt: r.done_at,
      outcome: r.outcome,
      approvedHours: r.approved_hours == null ? Number(r.hours) : Number(r.approved_hours),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}

function offer(r) {
  return r ? { id: r.id, lineId: r.line_id, waiterId: r.waiter_id, rate: Number(r.rate), status: r.status, createdAt: r.created_at } : null;
}

const COLS = {
  rate: "rate",
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
  async updateUser(id, fields) {
    const r = await pool.query(
      "UPDATE users SET look = COALESCE($2, look), avatar = COALESCE($3, avatar) WHERE id = $1 RETURNING *",
      [id, fields.look ?? null, fields.avatar ?? null]
    );
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
  async setLineGeo(id, geo) {
    await pool.query("UPDATE lines SET lat = $2, lng = $3, geo_approx = $4 WHERE id = $1", [id, geo.lat, geo.lng, geo.approx]);
  },
  async openLinesMissingGeo() {
    const r = await pool.query("SELECT id, place FROM lines WHERE status = 'open' AND lat IS NULL ORDER BY id LIMIT 200");
    return r.rows;
  },
  // Removes personal details but keeps finished jobs and ratings intact for the other person.
  async deleteUser(id) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM lines WHERE owner_id = $1 AND status = 'open'", [id]);
      await c.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await c.query(
        `UPDATE users SET name = 'Deleted user', email = $2, pw_hash = '', look = '', avatar = '' WHERE id = $1`,
        [id, `deleted-${id}@deleted.invalid`]
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
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
  // ---- rate offers from waiters ----
  async upsertOffer(lineId, waiterId, rate) {
    const u = await pool.query(
      "UPDATE offers SET rate = $3, created_at = now() WHERE line_id = $1 AND waiter_id = $2 AND status = 'pending' RETURNING *",
      [lineId, waiterId, rate]
    );
    if (u.rows[0]) return offer(u.rows[0]);
    const r = await pool.query(
      "INSERT INTO offers (line_id, waiter_id, rate) VALUES ($1, $2, $3) RETURNING *",
      [lineId, waiterId, rate]
    );
    return offer(r.rows[0]);
  },
  async getOffer(id) {
    const r = await pool.query("SELECT * FROM offers WHERE id = $1", [id]);
    return offer(r.rows[0]);
  },
  async pendingOffers(lineIds) {
    if (!lineIds.length) return [];
    const r = await pool.query(
      `SELECT o.*, u.name AS waiter_name, u.avatar AS waiter_avatar FROM offers o JOIN users u ON u.id = o.waiter_id
       WHERE o.status = 'pending' AND o.line_id = ANY($1::int[]) ORDER BY o.created_at`,
      [lineIds]
    );
    return r.rows.map((row) => ({ ...offer(row), waiterName: row.waiter_name, waiterAvatar: row.waiter_avatar || "" }));
  },
  async setOfferStatus(id, status) {
    const r = await pool.query("UPDATE offers SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING *", [id, status]);
    return offer(r.rows[0]);
  },
  async closeOtherOffers(lineId, exceptId) {
    await pool.query("UPDATE offers SET status = 'declined' WHERE line_id = $1 AND id <> $2 AND status = 'pending'", [lineId, exceptId]);
  },
  async withdrawOffer(lineId, waiterId) {
    const r = await pool.query(
      "UPDATE offers SET status = 'withdrawn' WHERE line_id = $1 AND waiter_id = $2 AND status = 'pending'",
      [lineId, waiterId]
    );
    return r.rowCount > 0;
  },
};
