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
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS noshows INT NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS swap_fails INT NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS code_reset_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS checkin_verified BOOLEAN;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS checkin_dist_m INT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS lines_start_idx ON lines(start_at);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  line_id INT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  sender_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_line_idx ON messages(line_id, id);
CREATE TABLE IF NOT EXISTS message_reads (
  line_id INT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  last_id INT NOT NULL DEFAULT 0,
  PRIMARY KEY (line_id, user_id)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS area TEXT;
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_pm TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_label TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_intent TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_held INT NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_status TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_error TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_captured INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item_details TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item_backup TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS qty INT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item_budget NUMERIC(10,2);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS handoff TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS dropoff_fee NUMERIC(10,2);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS dropoff_addr TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item_total NUMERIC(10,2);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS item_note TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS has_receipt BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS meet_within INT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS meet_reminded BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subs(user_id);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_presence (
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
ALTER TABLE lines ADD COLUMN IF NOT EXISTS event_id INT REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS rush BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pay_refunded INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  line_id INT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  reporter_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  refund_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS receipts (
  line_id INT PRIMARY KEY REFERENCES lines(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const LINE_SELECT = `
SELECT l.*, o.name AS owner_name, o.avatar AS owner_avatar,
  w.name AS waiter_name, w.look AS waiter_look, w.avatar AS waiter_avatar
FROM lines l
JOIN users o ON o.id = l.owner_id
LEFT JOIN users w ON w.id = l.waiter_id`;

function user(r) {
  return (
    r && {
      id: r.id, email: r.email, name: r.name, pwHash: r.pw_hash, look: r.look, avatar: r.avatar || "",
      suspended: !!r.suspended, noshows: r.noshows || 0, createdAt: r.created_at, lastSeenAt: r.last_seen_at || null,
      stripeCustomer: r.stripe_customer || null, stripeAccount: r.stripe_account || null, cardPm: r.card_pm || null,
      cardLabel: r.card_label || null, payoutsReady: !!r.payouts_ready,
    }
  );
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
      startAt: r.start_at,
      swapFails: r.swap_fails || 0,
      codeResetAt: r.code_reset_at,
      checkinVerified: r.checkin_verified,
      checkinDist: r.checkin_dist_m,
      handoffAt: r.handoff_at,
      claimedAt: r.claimed_at,
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
      area: r.area || null,
      payIntent: r.pay_intent || null,
      payHeld: r.pay_held || 0,
      payStatus: r.pay_status || null,
      payError: r.pay_error || null,
      payCaptured: r.pay_captured || 0,
      kind: r.kind === "pickup" ? "pickup" : "spot",
      item: r.item || "",
      itemDetails: r.item_details || "",
      itemBackup: r.item_backup || "",
      qty: r.qty || 1,
      itemBudget: r.item_budget == null ? null : Number(r.item_budget),
      handoff: r.handoff || null,
      dropoffFee: r.dropoff_fee == null ? 0 : Number(r.dropoff_fee),
      dropoffAddr: r.dropoff_addr || "",
      itemTotal: r.item_total == null ? null : Number(r.item_total),
      itemNote: r.item_note || "",
      purchasedAt: r.purchased_at || null,
      hasReceipt: !!r.has_receipt,
      meetWithin: r.meet_within || null,
      eventId: r.event_id || null,
      rush: !!r.rush,
      payRefunded: r.pay_refunded || 0,
      meetReminded: !!r.meet_reminded,
      doneAt: r.done_at,
      outcome: r.outcome,
      approvedHours: r.approved_hours == null ? Number(r.hours) : Number(r.approved_hours),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  );
}

function event(r) {
  return r ? { id: r.id, name: r.name, venue: r.venue, startsAt: r.starts_at, endsAt: r.ends_at, lat: r.lat, lng: r.lng } : null;
}
function report(r) {
  return r ? { id: r.id, lineId: r.line_id, reporterId: r.reporter_id, reason: r.reason, details: r.details, status: r.status,
    resolution: r.resolution || "", refundCents: r.refund_cents || 0, createdAt: r.created_at, resolvedAt: r.resolved_at } : null;
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
  code: "code",
  swapFails: "swap_fails",
  codeResetAt: "code_reset_at",
  checkinVerified: "checkin_verified",
  checkinDist: "checkin_dist_m",
  handoffAt: "handoff_at",
  claimedAt: "claimed_at",
  place: "place",
  what: "what",
  cat: "cat",
  startText: "start_text",
  startAt: "start_at",
  hours: "hours",
  notes: "notes",
  lat: "lat",
  lng: "lng",
  geoApprox: "geo_approx",
  payIntent: "pay_intent",
  payHeld: "pay_held",
  payStatus: "pay_status",
  payError: "pay_error",
  payCaptured: "pay_captured",
  kind: "kind",
  item: "item",
  itemDetails: "item_details",
  itemBackup: "item_backup",
  qty: "qty",
  itemBudget: "item_budget",
  handoff: "handoff",
  dropoffFee: "dropoff_fee",
  dropoffAddr: "dropoff_addr",
  itemTotal: "item_total",
  itemNote: "item_note",
  purchasedAt: "purchased_at",
  hasReceipt: "has_receipt",
  meetWithin: "meet_within",
  eventId: "event_id",
  rush: "rush",
  payRefunded: "pay_refunded",
  meetReminded: "meet_reminded",
};
const USER_COLS = {
  look: "look",
  avatar: "avatar",
  suspended: "suspended",
  pwHash: "pw_hash",
  stripeCustomer: "stripe_customer",
  stripeAccount: "stripe_account",
  cardPm: "card_pm",
  cardLabel: "card_label",
  payoutsReady: "payouts_ready",
};

module.exports = {
  kind: "postgres",
  async init() {
    await pool.query(SCHEMA);
  },
  // Stripe test and live mode have separate customers, cards and payout accounts. When the
  // keys switch between them, forget the old mode's links so people set them up again.
  async syncStripeMode(mode) {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = 'stripe_mode'");
    const prev = r.rows[0] ? r.rows[0].value : null;
    if (prev && prev !== mode) {
      await pool.query(
        "UPDATE users SET stripe_customer = NULL, stripe_account = NULL, card_pm = NULL, card_label = NULL, payouts_ready = false"
      );
      await pool.query("UPDATE lines SET pay_intent = NULL, pay_held = 0, pay_status = NULL, pay_error = NULL WHERE status <> 'done'");
      await pool.query(
        "UPDATE lines SET pay_status = 'void', pay_error = 'Started in Stripe ' || $1 || ' mode' WHERE status = 'done' AND pay_status IN ('held', 'charge_failed')",
        [prev]
      );
    }
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ('stripe_mode', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [mode]
    );
    return { previous: prev, changed: !!prev && prev !== mode };
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
    const sets = [];
    const args = [id];
    for (const [k, v] of Object.entries(fields)) {
      if (!USER_COLS[k] || v === undefined) continue;
      args.push(v);
      sets.push(`${USER_COLS[k]} = $${args.length}`);
    }
    if (!sets.length) return this.userById(id);
    const r = await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, args);
    return user(r.rows[0]) || null;
  },
  async userById(id) {
    const r = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return user(r.rows[0]) || null;
  },
  async incNoShows(id) {
    await pool.query("UPDATE users SET noshows = noshows + 1 WHERE id = $1", [id]);
  },
  async deleteSessionsFor(userId) {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
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
      `INSERT INTO lines (owner_id, place, what, cat, start_text, hours, rate, notes, code, approved_hours, start_at,
         kind, item, item_details, item_backup, item_budget, handoff, dropoff_fee, dropoff_addr, meet_within, qty, event_id, rush)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
      [f.ownerId, f.place, f.what, f.cat, f.startText, f.hours, f.rate, f.notes, f.code, f.startAt,
        f.kind || "spot", f.item || null, f.itemDetails || null, f.itemBackup || null, f.itemBudget ?? null,
        f.handoff || null, f.dropoffFee || 0, f.dropoffAddr || null, f.meetWithin || null, f.qty || null, f.eventId || null, !!f.rush]
    );
    return this.getLine(r.rows[0].id);
  },
  // ---- events (venue nights) ----
  async createEvent({ name, venue, startsAt, endsAt }) {
    const r = await pool.query("INSERT INTO events (name, venue, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING *", [name, venue, startsAt, endsAt]);
    return event(r.rows[0]);
  },
  async setEventGeo(id, geo) {
    await pool.query("UPDATE events SET lat = $2, lng = $3 WHERE id = $1", [id, geo.lat, geo.lng]);
  },
  async deleteEvent(id) {
    const r = await pool.query("DELETE FROM events WHERE id = $1", [id]);
    return r.rowCount > 0;
  },
  async eventById(id) {
    const r = await pool.query("SELECT * FROM events WHERE id = $1", [id]);
    return event(r.rows[0]);
  },
  async eventsByIds(ids) {
    if (!ids.length) return [];
    const r = await pool.query("SELECT * FROM events WHERE id = ANY($1::int[])", [ids]);
    return r.rows.map(event);
  },
  // Events that haven't ended and start within a week, with open requests and waiters there.
  async upcomingEvents(userId, { all = false } = {}) {
    const where = all ? "e.ends_at > now() - interval '30 days'" : "e.ends_at > now() AND e.starts_at < now() + interval '7 days'";
    const r = await pool.query(
      `SELECT e.*,
         (SELECT COUNT(*) FROM lines l WHERE l.event_id = e.id AND l.status = 'open')::int AS open_count,
         (SELECT COUNT(*) FROM event_presence p WHERE p.event_id = e.id)::int AS here_count,
         EXISTS (SELECT 1 FROM event_presence p WHERE p.event_id = e.id AND p.user_id = $1) AS me_here
       FROM events e WHERE ${where} ORDER BY e.starts_at ${all ? "DESC" : "ASC"} LIMIT 100`,
      [userId || 0]
    );
    return r.rows.map((row) => ({ ...event(row), open: row.open_count, here: row.here_count, meHere: !!row.me_here }));
  },
  async setPresence(eventId, userId, here) {
    if (here) await pool.query("INSERT INTO event_presence (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [eventId, userId]);
    else await pool.query("DELETE FROM event_presence WHERE event_id = $1 AND user_id = $2", [eventId, userId]);
  },
  async presentUserIds(eventId) {
    const r = await pool.query("SELECT user_id FROM event_presence WHERE event_id = $1", [eventId]);
    return r.rows.map((x) => x.user_id);
  },
  // ---- problem reports ----
  async createReport({ lineId, reporterId, reason, details }) {
    const r = await pool.query("INSERT INTO reports (line_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4) RETURNING *", [lineId, reporterId, reason, details]);
    return report(r.rows[0]);
  },
  async countOpenReports(lineId, reporterId) {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM reports WHERE line_id = $1 AND reporter_id = $2 AND status = 'open'", [lineId, reporterId]);
    return r.rows[0].n;
  },
  async reportsBy(reporterId, lineIds) {
    if (!lineIds.length) return [];
    const r = await pool.query("SELECT * FROM reports WHERE reporter_id = $1 AND line_id = ANY($2::int[]) ORDER BY id", [reporterId, lineIds]);
    return r.rows.map(report);
  },
  async getReport(id) {
    const r = await pool.query("SELECT * FROM reports WHERE id = $1", [id]);
    return report(r.rows[0]);
  },
  async adminReports() {
    const r = await pool.query(
      `SELECT rp.*, u.name AS reporter_name, u.email AS reporter_email FROM reports rp JOIN users u ON u.id = rp.reporter_id
       ORDER BY (rp.status = 'open') DESC, rp.created_at DESC LIMIT 100`
    );
    return r.rows.map((row) => ({ ...report(row), reporterName: row.reporter_name, reporterEmail: row.reporter_email }));
  },
  async resolveReport(id, { resolution, refundCents }) {
    const r = await pool.query(
      "UPDATE reports SET status = 'resolved', resolution = $2, refund_cents = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *",
      [id, resolution, refundCents || 0]
    );
    return report(r.rows[0]);
  },
  async getSetting(key) {
    const r = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
    return r.rows[0] ? r.rows[0].value : null;
  },
  async setSetting(key, value) {
    await pool.query(
      "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value]
    );
  },
  async savePushSub(userId, { endpoint, p256dh, auth }) {
    await pool.query(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [endpoint, userId, p256dh, auth]
    );
    // Keep the 10 newest phones per person.
    await pool.query(
      "DELETE FROM push_subs WHERE user_id = $1 AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10)",
      [userId]
    );
  },
  async pushSubs(userId) {
    const r = await pool.query("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = $1", [userId]);
    return r.rows;
  },
  async deletePushSub(endpoint, userId) {
    if (userId) await pool.query("DELETE FROM push_subs WHERE endpoint = $1 AND user_id = $2", [endpoint, userId]);
    else await pool.query("DELETE FROM push_subs WHERE endpoint = $1", [endpoint]);
  },
  async linesAwaitingMeetup() {
    const r = await pool.query(`${LINE_SELECT} WHERE l.status = 'handoff' AND l.kind = 'pickup' AND l.purchased_at IS NOT NULL AND NOT l.meet_reminded`);
    return r.rows.map(line);
  },
  async saveReceipt(lineId, mime, data) {
    await pool.query(
      "INSERT INTO receipts (line_id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (line_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, created_at = now()",
      [lineId, mime, data]
    );
  },
  async getReceipt(lineId) {
    const r = await pool.query("SELECT mime, data FROM receipts WHERE line_id = $1", [lineId]);
    return r.rows[0] || null;
  },
  async getLine(id) {
    const r = await pool.query(`${LINE_SELECT} WHERE l.id = $1`, [id]);
    return line(r.rows[0]) || null;
  },
  async listLines({ ownerId, waiterId, openExcept }) {
    let where, args;
    if (ownerId) [where, args] = ["l.owner_id = $1", [ownerId]];
    else if (waiterId) [where, args] = ["l.waiter_id = $1", [waiterId]];
    else
      [where, args] = [
        "l.status = 'open' AND l.owner_id <> $1 AND (l.start_at IS NULL OR l.start_at > now() - interval '2 hours')",
        [openExcept],
      ];
    const order = openExcept ? "l.start_at ASC NULLS LAST, l.created_at DESC" : "l.created_at DESC";
    const r = await pool.query(`${LINE_SELECT} WHERE ${where} ORDER BY ${order} LIMIT 200`, args);
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
  // Changes a line whatever its status (used for payment bookkeeping).
  async updateLineAny(id, fields) {
    const sets = [];
    const args = [id];
    for (const [k, v] of Object.entries(fields)) {
      if (!COLS[k]) continue;
      args.push(v);
      sets.push(`${COLS[k]} = $${args.length}`);
    }
    if (!sets.length) return this.getLine(id);
    await pool.query(`UPDATE lines SET ${sets.join(", ")} WHERE id = $1`, args);
    return this.getLine(id);
  },
  // Booked lines that still need a card hold, and finished lines whose charge hasn't gone through.
  async linesForPayments() {
    const r = await pool.query(
      `${LINE_SELECT} WHERE (l.status NOT IN ('open', 'done') AND (l.pay_status IS NULL OR l.pay_status = 'failed'))
         OR (l.status = 'done' AND l.pay_status IN ('held', 'charge_failed') AND l.done_at > now() - interval '6 days')
       ORDER BY l.id LIMIT 200`
    );
    return r.rows.map(line);
  },
  async setLineGeo(id, geo) {
    await pool.query("UPDATE lines SET lat = $2, lng = $3, geo_approx = $4, area = COALESCE($5, area) WHERE id = $1", [
      id, geo.lat, geo.lng, geo.approx, geo.area || null,
    ]);
  },
  // Lines that still need map coordinates or a city name (newest first, so recent activity fills in first).
  async linesMissingGeo() {
    const r = await pool.query("SELECT id, place FROM lines WHERE lat IS NULL OR area IS NULL ORDER BY id DESC LIMIT 500");
    return r.rows;
  },
  // ---- password reset links (only a hash of each link's token is stored) ----
  async createReset(tokenHash, userId, expiresAt) {
    await pool.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, userId, expiresAt]);
  },
  // Uses up a reset link. Returns the user id, or null if the link is unknown, used, or expired.
  async takeReset(tokenHash) {
    const r = await pool.query(
      "UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id",
      [tokenHash]
    );
    return r.rows[0] ? r.rows[0].user_id : null;
  },
  async countResetsSince(userId, since) {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > $2", [userId, since]);
    return r.rows[0].n;
  },
  async clearResets(userId) {
    await pool.query("DELETE FROM password_resets WHERE user_id = $1", [userId]);
  },
  async touchUser(id) {
    await pool.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [id]);
  },
  // Removes personal details but keeps finished jobs and ratings intact for the other person.
  async deleteUser(id) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM lines WHERE owner_id = $1 AND status = 'open'", [id]);
      await c.query("UPDATE offers SET status = 'withdrawn' WHERE waiter_id = $1 AND status = 'pending'", [id]);
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
       WHERE o.status = 'pending' AND o.line_id = ANY($1::int[]) AND o.created_at > now() - interval '12 hours'
       ORDER BY o.created_at`,
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
  async countOffersSince(waiterId, since) {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM offers WHERE waiter_id = $1 AND created_at > $2", [waiterId, since]);
    return r.rows[0].n;
  },

  // ---- limits ----
  async countLines(ownerId, { openOnly, since }) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lines WHERE owner_id = $1 ${openOnly ? "AND status = 'open'" : ""} ${since ? "AND created_at > $2" : ""}`,
      since ? [ownerId, since] : [ownerId]
    );
    return r.rows[0].n;
  },

  // ---- messages between booker and waiter ----
  async addMessage(lineId, senderId, body) {
    const r = await pool.query("INSERT INTO messages (line_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id", [lineId, senderId, body]);
    return r.rows[0].id;
  },
  async listMessages(lineId) {
    const r = await pool.query(
      "SELECT id, sender_id, body, created_at FROM (SELECT * FROM messages WHERE line_id = $1 ORDER BY id DESC LIMIT 200) m ORDER BY id",
      [lineId]
    );
    return r.rows.map((m) => ({ id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at }));
  },
  async markRead(lineId, userId, lastId) {
    await pool.query(
      `INSERT INTO message_reads (line_id, user_id, last_id) VALUES ($1, $2, $3)
       ON CONFLICT (line_id, user_id) DO UPDATE SET last_id = GREATEST(message_reads.last_id, EXCLUDED.last_id)`,
      [lineId, userId, lastId]
    );
  },
  async unreadCounts(userId, lineIds) {
    const out = {};
    if (!lineIds.length) return out;
    const r = await pool.query(
      `SELECT m.line_id, COUNT(*)::int AS n FROM messages m
       LEFT JOIN message_reads r ON r.line_id = m.line_id AND r.user_id = $1
       WHERE m.line_id = ANY($2::int[]) AND m.sender_id <> $1 AND m.id > COALESCE(r.last_id, 0)
       GROUP BY m.line_id`,
      [userId, lineIds]
    );
    for (const row of r.rows) out[row.line_id] = row.n;
    return out;
  },
  async countMessagesSince(senderId, since) {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM messages WHERE sender_id = $1 AND created_at > $2", [senderId, since]);
    return r.rows[0].n;
  },

  // ---- admin ----
  async adminLines() {
    const r = await pool.query(`${LINE_SELECT} ORDER BY l.created_at DESC LIMIT 150`);
    return r.rows.map(line);
  },
  async adminUsers() {
    const r = await pool.query(
      `SELECT u.*, (SELECT COUNT(*) FROM lines WHERE owner_id = u.id)::int AS posted,
         (SELECT COUNT(*) FROM lines WHERE waiter_id = u.id AND status = 'done')::int AS worked
       FROM users u ORDER BY u.created_at DESC LIMIT 300`
    );
    return r.rows.map((row) => ({ ...user(row), posted: row.posted, worked: row.worked }));
  },
  // Test-only: move a line's timestamps back (used by automated tests when WFM_TEST_HOOKS=1).
  async _shiftCheckin(id, minutes) {
    const cols = ["checkin_at", "done_at", "handoff_at", "start_at", "claimed_at", "code_reset_at", "purchased_at"];
    const sets = cols.map((c) => `${c} = ${c} - ($2 || ' minutes')::interval`).join(", ");
    const r = await pool.query(`UPDATE lines SET ${sets} WHERE id = $1`, [id, String(minutes)]);
    return r.rowCount > 0;
  },
  // Everything the creator dashboard needs, in one pass. Personal details are left out.
  async metricsData() {
    const [u, l, r, o, m] = await Promise.all([
      pool.query("SELECT id, created_at, last_seen_at, suspended, noshows, name FROM users WHERE email NOT LIKE '%@deleted.invalid'"),
      pool.query(`SELECT id, owner_id, waiter_id, place, cat, status, outcome, start_at, created_at, claimed_at, checkin_at,
        done_at, hours, approved_hours, rate, lat, lng, area, checkin_verified, kind, item_total, purchased_at, handoff, dropoff_fee FROM lines`),
      pool.query("SELECT stars, ratee_role, created_at FROM ratings"),
      pool.query("SELECT status, created_at FROM offers"),
      pool.query("SELECT created_at FROM messages"),
    ]);
    return {
      users: u.rows.map((x) => ({ id: x.id, name: x.name, createdAt: x.created_at, lastSeenAt: x.last_seen_at, suspended: !!x.suspended, noshows: x.noshows || 0 })),
      lines: l.rows.map((x) => ({
        id: x.id, ownerId: x.owner_id, waiterId: x.waiter_id, place: x.place, cat: x.cat, status: x.status, outcome: x.outcome,
        startAt: x.start_at, createdAt: x.created_at, claimedAt: x.claimed_at, checkinAt: x.checkin_at, doneAt: x.done_at,
        hours: Number(x.hours), approvedHours: x.approved_hours == null ? Number(x.hours) : Number(x.approved_hours),
        rate: Number(x.rate), lat: x.lat, lng: x.lng, area: x.area, checkinVerified: x.checkin_verified,
        kind: x.kind || "spot", itemTotal: x.item_total == null ? null : Number(x.item_total), purchasedAt: x.purchased_at, handoff: x.handoff, dropoffFee: Number(x.dropoff_fee || 0),
      })),
      ratings: r.rows.map((x) => ({ stars: x.stars, rateeRole: x.ratee_role, createdAt: x.created_at })),
      offers: o.rows.map((x) => ({ status: x.status, createdAt: x.created_at })),
      messages: m.rows.map((x) => ({ createdAt: x.created_at })),
    };
  },
  async adminRemoveLine(id) {
    const r = await pool.query("DELETE FROM lines WHERE id = $1", [id]);
    return r.rowCount > 0;
  },
};
