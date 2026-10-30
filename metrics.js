// Numbers for the creator dashboard (/dashboard). Works on plain rows from either
// store, so the same math runs against Postgres and the in-memory test store.

const { billing } = require("./billing");

const DAY = 24 * 3600 * 1000;
const PAID_OUTCOMES = new Set(["swapped", "customer_noshow", "time_up", "delivered", "pickup_noshow", "sold_out"]);
const CANCELLED = new Set(["cancelled_free", "cancelled_late", "cancelled_inline"]);
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const t = (d) => (d ? new Date(d).getTime() : null);
const round = (n, p = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null);
const ratio = (a, b) => (b ? round(a / b, 4) : null);
const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Splits a timestamp into local day / weekday / hour for the chosen time zone.
function zoner(tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23",
    });
  } catch {
    return zoner("America/Los_Angeles");
  }
  return (ms) => {
    const p = {};
    for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { day: `${p.year}-${p.month}-${p.day}`, dow: DOW.indexOf(p.weekday), hour: Number(p.hour) % 24 };
  };
}

// The bucket keys (days, or weeks for long ranges) covering the period, oldest first.
function buckets(start, end, zone, weekly) {
  const keys = [];
  const seen = new Set();
  for (let ms = start; ms <= end + DAY; ms += DAY) {
    if (ms > end && keys.length) break;
    const k = bucketKey(ms, zone, weekly);
    if (!seen.has(k)) seen.add(k), keys.push(k);
  }
  return keys;
}
function bucketKey(ms, zone, weekly) {
  const z = zone(ms);
  if (!weekly) return z.day;
  return zone(ms - z.dow * DAY).day; // the Monday that starts the week
}

const areaOf = (l) => l.area || (l.lat != null ? "Unnamed area" : "Location not found yet");
const venueOf = (l) => String(l.place || "").split(",")[0].trim();

function computeMetrics(data, opts = {}) {
  const now = opts.now || Date.now();
  const tz = opts.tz || "America/Los_Angeles";
  const zone = zoner(tz);
  const all = String(opts.days || "30") === "all";
  const firstEver = Math.min(now, ...data.users.map((u) => t(u.createdAt)), ...data.lines.map((l) => t(l.createdAt)));
  const days = all ? Math.max(1, Math.ceil((now - firstEver) / DAY)) : Math.min(365, Math.max(1, Number(opts.days) || 30));
  const start = now - days * DAY;
  const prevStart = start - days * DAY;
  const inP = (ms, a = start, b = now) => ms != null && ms >= a && ms <= b;

  const lines = data.lines.map((l) => {
    const b = l.status === "done" ? billing(l, now) : null;
    return { ...l, _c: t(l.createdAt), _d: t(l.doneAt), _s: t(l.startAt) ?? t(l.createdAt), _cl: t(l.claimedAt), bill: b };
  });
  const names = new Map(data.users.map((u) => [u.id, u.name]));

  // ---- one period's headline numbers (used for this period and the one before, for the change arrows) ----
  function period(a, b) {
    const posted = lines.filter((l) => inP(l._c, a, b));
    const finished = lines.filter((l) => l.status === "done" && inP(l._d, a, b));
    const completed = finished.filter((l) => PAID_OUTCOMES.has(l.outcome));
    const cancelled = finished.filter((l) => CANCELLED.has(l.outcome));
    const charged = finished.filter((l) => l.bill && l.bill.total > 0);
    const gmv = sum(charged, (l) => l.bill.total);
    const fees = sum(charged, (l) => l.bill.fee);
    const decided = posted.filter((l) => l.status !== "open" || l._s < now); // got claimed, or its start time passed
    const claimed = decided.filter((l) => l.status !== "open" || l._cl);
    const claimMins = posted.filter((l) => l._cl).map((l) => (l._cl - l._c) / 60000).filter((m) => m >= 0);
    const signups = data.users.filter((u) => inP(t(u.createdAt), a, b));
    const bookers = new Set(posted.map((l) => l.ownerId));
    const waiters = new Set(lines.filter((l) => l.waiterId && (inP(l._cl, a, b) || inP(l._d, a, b))).map((l) => l.waiterId));
    const known = new Set(data.users.map((u) => u.id));
    const active = new Set([...bookers, ...waiters, ...data.users.filter((u) => inP(t(u.lastSeenAt), a, b)).map((u) => u.id)].filter((id) => known.has(id)));
    return {
      gmv: round(gmv), revenue: round(fees), waiterPayouts: round(sum(charged, (l) => l.bill.waiterPay)),
      posted: posted.length, completed: completed.length, cancelled: cancelled.length,
      fillRate: ratio(claimed.length, decided.length),
      completionRate: ratio(completed.length, finished.length),
      cancelRate: ratio(cancelled.length, finished.length),
      avgJobValue: completed.length ? round(sum(completed, (l) => l.bill.total) / completed.length) : null,
      avgBilledHours: completed.length ? round(sum(completed, (l) => l.bill.billedHours) / completed.length) : null,
      avgRate: posted.length ? round(sum(posted, (l) => l.rate) / posted.length) : null,
      medianClaimMinutes: round(median(claimMins), 0),
      newUsers: signups.length, activeUsers: active.size, activeBookers: bookers.size, activeWaiters: waiters.size,
    };
  }
  const cur = period(start, now);
  const prev = period(prevStart, start);

  // ---- people ----
  const seenWithin = (ms) => data.users.filter((u) => t(u.lastSeenAt) != null && now - t(u.lastSeenAt) <= ms).length;
  const waiterIds = new Set(lines.filter((l) => l.waiterId).map((l) => l.waiterId));
  const ownerCounts = new Map();
  for (const l of lines) ownerCounts.set(l.ownerId, (ownerCounts.get(l.ownerId) || 0) + 1);
  const periodBookers = [...new Set(lines.filter((l) => inP(l._c)).map((l) => l.ownerId))];
  const people = {
    total: data.users.length,
    dau: seenWithin(DAY), wau: seenWithin(7 * DAY), mau: seenWithin(30 * DAY),
    suspended: data.users.filter((u) => u.suspended).length,
    everBooked: new Set(lines.map((l) => l.ownerId)).size,
    everWaited: waiterIds.size,
    repeatBookerRate: ratio(periodBookers.filter((id) => ownerCounts.get(id) > 1).length, periodBookers.length),
  };

  // ---- trend over time ----
  const weekly = days > 92;
  const keys = buckets(start, now, zone, weekly);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const blank = () => keys.map(() => 0);
  const trend = { unit: weekly ? "week" : "day", labels: keys, posted: blank(), completed: blank(), gmv: blank(), revenue: blank(), signups: blank() };
  const put = (series, ms, v = 1) => {
    if (!inP(ms)) return;
    const i = idx.get(bucketKey(ms, zone, weekly));
    if (i != null) trend[series][i] = round(trend[series][i] + v);
  };
  for (const l of lines) {
    put("posted", l._c);
    if (l.status === "done" && PAID_OUTCOMES.has(l.outcome)) put("completed", l._d);
    if (l.bill && l.bill.total > 0) put("gmv", l._d, l.bill.total), put("revenue", l._d, l.bill.fee);
  }
  for (const u of data.users) put("signups", t(u.createdAt));

  // ---- busiest times: when lines happen (start time) and when people book (post time) ----
  const grid = () => Array.from({ length: 7 }, () => Array(24).fill(0));
  const whenLines = grid();
  const whenBooked = grid();
  const periodLines = lines.filter((l) => inP(l._c));
  for (const l of periodLines) {
    const s = zone(l._s);
    whenLines[s.dow][s.hour]++;
    const c = zone(l._c);
    whenBooked[c.dow][c.hour]++;
  }
  const peaks = [];
  whenLines.forEach((row, d) => row.forEach((n, h) => n && peaks.push({ day: DOW[d], hour: h, lines: n })));
  peaks.sort((a, b) => b.lines - a.lines);
  const byDow = whenLines.map((row, d) => ({ day: DOW[d], lines: sum(row) }));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, lines: sum(whenLines, (row) => row[h]) }));

  // ---- where: by city, top venues, and map points ----
  const areas = new Map();
  for (const l of periodLines) {
    const k = areaOf(l);
    const a = areas.get(k) || { area: k, posted: 0, decided: 0, claimed: 0, completed: 0, gmv: 0, rateSum: 0 };
    a.posted++;
    if (l.status !== "open" || l._s < now) a.decided++;
    if (l.status !== "open" || l._cl) a.claimed++;
    if (l.status === "done" && PAID_OUTCOMES.has(l.outcome)) a.completed++;
    if (l.bill) a.gmv += l.bill.total;
    a.rateSum += l.rate;
    areas.set(k, a);
  }
  const byArea = [...areas.values()]
    .map((a) => ({ area: a.area, posted: a.posted, completed: a.completed, gmv: round(a.gmv), fillRate: ratio(a.claimed, a.decided), avgRate: round(a.rateSum / a.posted) }))
    .sort((a, b) => b.posted - a.posted || b.gmv - a.gmv)
    .slice(0, 25);
  const venues = new Map();
  for (const l of periodLines) {
    const v = venueOf(l);
    if (!v) continue;
    const k = v.toLowerCase();
    const x = venues.get(k) || { venue: v, area: l.area || "", lines: 0 };
    x.lines++;
    venues.set(k, x);
  }
  const topVenues = [...venues.values()].sort((a, b) => b.lines - a.lines).slice(0, 10);
  const points = new Map();
  for (const l of periodLines) {
    if (l.lat == null || l.lng == null) continue;
    const k = `${round(l.lat, 3)},${round(l.lng, 3)}`;
    const p = points.get(k) || { lat: round(l.lat, 3), lng: round(l.lng, 3), lines: 0, label: venueOf(l) };
    p.lines++;
    points.set(k, p);
  }

  // ---- what kinds of lines ----
  const cats = new Map();
  for (const l of periodLines) {
    const c = cats.get(l.cat) || { cat: l.cat || "other", lines: 0, gmv: 0 };
    c.lines++;
    if (l.bill) c.gmv += l.bill.total;
    cats.set(l.cat, c);
  }
  const byCategory = [...cats.values()].map((c) => ({ ...c, gmv: round(c.gmv) })).sort((a, b) => b.lines - a.lines);

  // ---- marketplace health ----
  const periodRatings = data.ratings.filter((r) => inP(t(r.createdAt)));
  const avgStars = (role) => {
    const r = periodRatings.filter((x) => x.rateeRole === role);
    return r.length ? round(sum(r, (x) => x.stars) / r.length, 2) : null;
  };
  const checkedIn = lines.filter((l) => l.checkinAt && inP(t(l.checkinAt)) && l.checkinVerified != null);
  const periodOffers = data.offers.filter((o) => inP(t(o.createdAt)));
  const funnel = {
    posted: periodLines.length,
    claimed: periodLines.filter((l) => l.status !== "open" || l._cl).length,
    checkedIn: periodLines.filter((l) => l.checkinAt).length,
    completed: periodLines.filter((l) => l.status === "done" && PAID_OUTCOMES.has(l.outcome)).length,
  };
  const health = {
    openNow: lines.filter((l) => l.status === "open" && l._s >= now - 2 * 3600 * 1000).length,
    openNext24h: lines.filter((l) => l.status === "open" && l._s >= now && l._s <= now + DAY).length,
    inProgressNow: lines.filter((l) => !["open", "done"].includes(l.status)).length,
    waitersSeen24h: data.users.filter((u) => waiterIds.has(u.id) && t(u.lastSeenAt) != null && now - t(u.lastSeenAt) <= DAY).length,
    waiterRating: avgStars("waiter"), bookerRating: avgStars("booker"), ratingsCount: periodRatings.length,
    verifiedCheckinRate: ratio(checkedIn.filter((l) => l.checkinVerified).length, checkedIn.length),
    bookerNoShows: lines.filter((l) => l.outcome === "customer_noshow" && inP(l._d)).length,
    waiterNoShowsAllTime: sum(data.users, (u) => u.noshows || 0),
    offersMade: periodOffers.length,
    offerAcceptRate: ratio(periodOffers.filter((o) => o.status === "accepted").length, periodOffers.filter((o) => o.status !== "pending").length),
    messages: data.messages.filter((m) => inP(t(m.createdAt))).length,
  };

  // ---- leaders ----
  const tally = (key, val) => {
    const m = new Map();
    for (const l of lines) {
      if (l.status !== "done" || !inP(l._d) || !l.bill || !l.bill.total || !l[key]) continue;
      const x = m.get(l[key]) || { name: names.get(l[key]) || "Deleted user", jobs: 0, amount: 0 };
      x.jobs++;
      x.amount = round(x.amount + l.bill[val]);
      m.set(l[key], x);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, 5);
  };

  return {
    generatedAt: new Date(now).toISOString(), tz, days: all ? "all" : days, periodStart: new Date(start).toISOString(),
    kpis: cur, previous: prev, people, trend,
    times: { whenLines, whenBooked, days: DOW, peaks: peaks.slice(0, 5), byDow, byHour },
    places: { byArea, topVenues, points: [...points.values()].sort((a, b) => b.lines - a.lines).slice(0, 1500) },
    byCategory, funnel, health,
    leaders: { waiters: tally("waiterId", "waiterPay"), bookers: tally("ownerId", "total") },
  };
}

module.exports = { computeMetrics };
