// Turns the "Where is the line?" text into map coordinates, so waiters can sort
// lines by distance. Uses OpenStreetMap's free Nominatim service, which allows
// about one lookup per second and asks apps to identify themselves.
//
// If the full text can't be found, it tries just the part after the first comma
// (usually the city) and marks the result as approximate.

const BASE = process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org/search";
const UA = "WaitForMe/1.0 (+https://wait-for-me-production.up.railway.app)";
const cache = new Map();
let last = 0;
let chain = Promise.resolve();

function lookup(q) {
  const run = async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const url = new URL(BASE);
    url.search = new URLSearchParams({ q, format: "jsonv2", limit: "1", countrycodes: "us" }).toString();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: ctl.signal });
      if (!r.ok) return null;
      const j = await r.json();
      return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const p = chain.then(run, run); // one lookup at a time
  chain = p.catch(() => {});
  return p;
}

async function geocode(text) {
  const key = String(text || "").trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let hit = await lookup(text);
  let approx = false;
  if (!hit && text.includes(",")) {
    hit = await lookup(text.slice(text.indexOf(",") + 1).trim());
    approx = !!hit;
  }
  const out = hit ? { ...hit, approx } : null;
  cache.set(key, out);
  return out;
}

module.exports = { geocode };
