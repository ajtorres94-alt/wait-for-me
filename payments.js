// Card payments and waiter payouts through Stripe Connect, using Stripe's REST API
// directly (no extra packages).
//
// How money moves (a "destination charge"):
//   - Bookers save a card (or Apple Pay / Google Pay) to their Wait For Me! account.
//   - When a waiter is booked and the line starts within HOLD_DAYS, the app places a
//     hold on the booker's card for the most the job could cost.
//   - When the job ends, the app charges the actual bill. Stripe sends the waiter's
//     share (their time, any drop-off fee, and the item cost they paid at the register)
//     to the waiter's Express account, and the fees stay with the platform.
//   - If nothing is owed (free cancellation, no-show by the waiter) the hold is released.
//
// Railway variables: STRIPE_SECRET_KEY (sk_test_... or sk_live_...), STRIPE_PUBLISHABLE_KEY.
// Without STRIPE_SECRET_KEY, payments are off and the app works as before.

const crypto = require("crypto");
const { billing, maxTotal } = require("./billing");

const API = () => (process.env.STRIPE_API_URL || "https://api.stripe.com").replace(/\/+$/, "");
const KEY = () => (process.env.STRIPE_SECRET_KEY || "").trim();
const enabled = () => !!KEY();
const publishableKey = () => (process.env.STRIPE_PUBLISHABLE_KEY || "").trim();
const testMode = () => /^(sk|rk)_test_/.test(KEY());

const HOLD_DAYS = 5; // card holds last about 7 days, so they're placed at most 5 days ahead
const cents = (d) => Math.round(Number(d) * 100);

class PaymentError extends Error {
  constructor(message, code, status = 402) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Stripe takes form-encoded bodies with nested keys like a[b][c]=v.
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encode(item, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(item)])));
    else if (typeof v === "object") encode(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}

async function stripe(method, path, params, { idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${KEY()}`, "Stripe-Version": "2024-06-20" };
  let url = API() + path;
  let body;
  if (params && method === "GET") url += "?" + new URLSearchParams(encode(params)).toString();
  else if (params) {
    body = new URLSearchParams(encode(params)).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try {
    r = await fetch(url, { method, headers, body, signal: ctl.signal });
  } catch (e) {
    throw new PaymentError("We couldn't reach our payment processor. Try again in a minute.", "stripe_unreachable", 503);
  } finally {
    clearTimeout(timer);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    const err = new PaymentError(e.message || `Payment processor error (${r.status}).`, e.decline_code || e.code || "stripe_error", r.status === 402 ? 402 : 502);
    err.stripe = e;
    throw err;
  }
  return j;
}

// ---------- bookers: saved card ----------
async function ensureCustomer(store, user) {
  if (user.stripeCustomer) return user.stripeCustomer;
  const c = await stripe("POST", "/v1/customers", { email: user.email, name: user.name, metadata: { wfm_user: user.id } }, { idempotencyKey: `cust-${user.id}` });
  await store.updateUser(user.id, { stripeCustomer: c.id });
  user.stripeCustomer = c.id;
  return c.id;
}

async function startCardSetup(store, user) {
  const customer = await ensureCustomer(store, user);
  const si = await stripe("POST", "/v1/setup_intents", {
    customer,
    usage: "off_session",
    automatic_payment_methods: { enabled: true },
    metadata: { wfm_user: user.id },
  });
  return { clientSecret: si.client_secret };
}

function cardLabel(pm) {
  const w = pm.card && pm.card.wallet && pm.card.wallet.type;
  const wallet = w === "apple_pay" ? "Apple Pay " : w === "google_pay" ? "Google Pay " : "";
  if (pm.card) {
    const brand = { visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover" }[pm.card.brand] || pm.card.brand;
    return `${wallet}${brand} •••• ${pm.card.last4}`;
  }
  if (pm.type === "us_bank_account" && pm.us_bank_account) return `Bank •••• ${pm.us_bank_account.last4}`;
  if (pm.type === "link") return "Link";
  if (pm.type === "cashapp") return "Cash App Pay";
  return pm.type;
}

// Called after the browser confirms a SetupIntent. Checks it belongs to this user before saving.
async function finishCardSetup(store, user, setupIntentId) {
  if (!/^seti_[A-Za-z0-9]+$/.test(String(setupIntentId || ""))) throw new PaymentError("That card setup wasn't found.", "bad_setup", 400);
  const si = await stripe("GET", `/v1/setup_intents/${setupIntentId}`);
  if (si.customer !== user.stripeCustomer) throw new PaymentError("That card setup wasn't found.", "bad_setup", 400);
  if (si.status !== "succeeded" || !si.payment_method) throw new PaymentError("The card wasn't confirmed. Try adding it again.", "setup_incomplete", 400);
  const pm = await stripe("GET", `/v1/payment_methods/${si.payment_method}`);
  await stripe("POST", `/v1/customers/${user.stripeCustomer}`, { invoice_settings: { default_payment_method: pm.id } });
  const label = cardLabel(pm);
  await store.updateUser(user.id, { cardPm: pm.id, cardLabel: label });
  return label;
}

// ---------- waiters: Express accounts for payouts ----------
async function ensureAccount(store, user) {
  if (user.stripeAccount) return user.stripeAccount;
  const a = await stripe(
    "POST",
    "/v1/accounts",
    {
      country: "US",
      email: user.email,
      business_type: "individual",
      controller: {
        fees: { payer: "application" },
        losses: { payments: "application" },
        stripe_dashboard: { type: "express" },
        requirement_collection: "stripe",
      },
      capabilities: { transfers: { requested: true } },
      business_profile: {
        mcc: "7299",
        url: "https://waitforme.io",
        product_description: "Waits in line to pick up items, and saves spots, for customers through the Wait For Me! app.",
      },
      metadata: { wfm_user: user.id },
    },
    { idempotencyKey: `acct-${user.id}` }
  );
  await store.updateUser(user.id, { stripeAccount: a.id });
  user.stripeAccount = a.id;
  return a.id;
}

async function payoutLink(store, user, baseUrl) {
  const account = await ensureAccount(store, user);
  if (user.payoutsReady) {
    const l = await stripe("POST", `/v1/accounts/${account}/login_links`);
    return { url: l.url, kind: "dashboard" };
  }
  const l = await stripe("POST", "/v1/account_links", {
    account,
    type: "account_onboarding",
    refresh_url: `${baseUrl}/?payouts=refresh`,
    return_url: `${baseUrl}/?payouts=return`,
    collection_options: { fields: "currently_due" },
  });
  return { url: l.url, kind: "onboarding" };
}

// Asks Stripe whether this waiter can receive money yet, and saves the answer.
async function refreshPayouts(store, user) {
  if (!user.stripeAccount) return { ready: false, started: false };
  const a = await stripe("GET", `/v1/accounts/${user.stripeAccount}`);
  const ready = !!(a.capabilities && a.capabilities.transfers === "active");
  const due = (a.requirements && a.requirements.currently_due) || [];
  if (ready !== !!user.payoutsReady) await store.updateUser(user.id, { payoutsReady: ready });
  user.payoutsReady = ready;
  return { ready, started: true, needsInfo: due.length > 0, detailsSubmitted: !!a.details_submitted };
}

// ---------- holds and charges on a line ----------
// The most a job can cost right now: approved time plus 30 minutes at the line's rate,
// the fees, and for pickups the item budget and any drop-off fee.
function maxCharge(line) {
  return Math.ceil(maxTotal(line) * 100) + 1;
}

const holdDue = (line, now = Date.now()) => {
  const start = line.startAt ? new Date(line.startAt).getTime() : now;
  return start - now <= HOLD_DAYS * 86400 * 1000;
};

// Places (or replaces) the card hold for a booked line. Records the outcome on the line
// instead of throwing, so a declined card doesn't undo the booking; the booker is asked
// to update their card and the app retries.
async function placeHold(store, line, { replace = false } = {}) {
  const owner = await store.userById(line.ownerId);
  const waiter = line.waiterId && (await store.userById(line.waiterId));
  if (!owner || !waiter) return line;
  const amount = maxCharge(line);
  if (!replace && line.payIntent && line.payHeld >= amount) return line;
  if (!owner.cardPm || !owner.stripeCustomer) {
    return store.updateLineAny(line.id, { payStatus: "failed", payError: "No card on file." });
  }
  if (!waiter.stripeAccount) {
    return store.updateLineAny(line.id, { payStatus: "failed", payError: "The waiter hasn't set up payouts." });
  }
  try {
    const pi = await stripe(
      "POST",
      "/v1/payment_intents",
      {
        amount,
        currency: "usd",
        customer: owner.stripeCustomer,
        payment_method: owner.cardPm,
        capture_method: "manual",
        confirm: true,
        off_session: true,
        transfer_data: { destination: waiter.stripeAccount },
        transfer_group: `line_${line.id}`,
        description: `Wait For Me! #${line.id}: ${String(line.place).slice(0, 80)}`,
        metadata: { wfm_line: line.id, wfm_waiter: waiter.id, wfm_booker: owner.id },
      },
      { idempotencyKey: `hold-${line.id}-${crypto.randomUUID()}` }
    );
    if (pi.status !== "requires_capture") throw new PaymentError("The card needs extra confirmation.", "requires_action");
    const old = line.payIntent;
    const updated = await store.updateLineAny(line.id, { payIntent: pi.id, payHeld: amount, payStatus: "held", payError: null });
    if (old && old !== pi.id) await stripe("POST", `/v1/payment_intents/${old}/cancel`).catch(() => {});
    return updated;
  } catch (e) {
    const msg = e.code === "authentication_required" || e.code === "requires_action"
      ? "Your bank wants you to confirm this card. Add it again in Account."
      : e.message;
    if (replace) throw new PaymentError(`We couldn't hold the added time on your card: ${msg}`, e.code || "card_declined");
    return store.updateLineAny(line.id, { payStatus: "failed", payError: msg });
  }
}

async function releaseHold(store, line) {
  if (line.payIntent && ["held", "failed"].includes(line.payStatus)) {
    await stripe("POST", `/v1/payment_intents/${line.payIntent}/cancel`).catch(() => {});
  }
  if (line.payIntent || line.payStatus) {
    return store.updateLineAny(line.id, { payIntent: null, payHeld: 0, payStatus: null, payError: null });
  }
  return line;
}

// Charges the final bill once a job is done. Uses the hold when there is one; otherwise
// charges the saved card directly.
async function settle(store, line) {
  if (["captured", "released"].includes(line.payStatus)) return line;
  const b = billing(line);
  const total = cents(b.total);
  const fee = cents(b.fee);
  if (total <= 0) {
    if (line.payIntent) await stripe("POST", `/v1/payment_intents/${line.payIntent}/cancel`).catch(() => {});
    return store.updateLineAny(line.id, { payStatus: "released", payCaptured: 0, payError: null });
  }
  try {
    if (line.payIntent && line.payStatus === "held") {
      const amount = Math.min(total, line.payHeld || total);
      await stripe("POST", `/v1/payment_intents/${line.payIntent}/capture`, {
        amount_to_capture: amount,
        application_fee_amount: Math.min(fee, amount),
      });
      return store.updateLineAny(line.id, { payStatus: "captured", payCaptured: amount, payError: null });
    }
    const owner = await store.userById(line.ownerId);
    const waiter = line.waiterId && (await store.userById(line.waiterId));
    if (!owner || !owner.cardPm || !waiter || !waiter.stripeAccount) throw new PaymentError("No card on file.", "no_card");
    const pi = await stripe(
      "POST",
      "/v1/payment_intents",
      {
        amount: total,
        currency: "usd",
        customer: owner.stripeCustomer,
        payment_method: owner.cardPm,
        confirm: true,
        off_session: true,
        application_fee_amount: fee,
        transfer_data: { destination: waiter.stripeAccount },
        transfer_group: `line_${line.id}`,
        description: `Wait For Me! #${line.id}: ${String(line.place).slice(0, 80)}`,
        metadata: { wfm_line: line.id, wfm_waiter: waiter.id, wfm_booker: owner.id },
      },
      { idempotencyKey: `charge-${line.id}` }
    );
    if (pi.status !== "succeeded") throw new PaymentError("The charge didn't go through.", "charge_failed");
    return store.updateLineAny(line.id, { payIntent: pi.id, payStatus: "captured", payCaptured: total, payError: null });
  } catch (e) {
    console.error(`Charge for line ${line.id} failed:`, e.message);
    return store.updateLineAny(line.id, { payStatus: "charge_failed", payError: e.message });
  }
}

// Registers the site with Apple Pay / Google Pay (safe to repeat).
async function registerDomains(hosts) {
  for (const domain_name of hosts) {
    await stripe("POST", "/v1/payment_method_domains", { domain_name }).catch(() => {});
  }
}

// Tries a harmless read for each kind of Stripe object the app uses, so a restricted key
// missing a permission shows up before a real booking fails.
async function checkKey() {
  const checks = [
    ["Customers", "/v1/customers", { limit: 1 }],
    ["Setup Intents (saving cards)", "/v1/setup_intents", { limit: 1 }],
    ["Payment Intents (holds and charges)", "/v1/payment_intents", { limit: 1 }],
    ["Payment Methods", "/v1/payment_methods", { limit: 1, type: "card", customer: "cus_check" }],
    ["Connected accounts (waiter payouts)", "/v1/accounts", { limit: 1 }],
    ["Payment method domains (Apple Pay / Google Pay)", "/v1/payment_method_domains", { limit: 1 }],
  ];
  const out = [];
  for (const [name, path, params] of checks) {
    try {
      await stripe("GET", path, params);
      out.push({ name, ok: true });
    } catch (e) {
      const missing = e.stripe && /permission|restricted/i.test(e.message || "");
      const notFound = e.stripe && e.stripe.code === "resource_missing";
      out.push({ name, ok: notFound, error: notFound ? null : missing ? "This key doesn't have permission." : e.message });
    }
  }
  return { mode: testMode() ? "test" : "live", keyType: KEY().slice(0, 3) === "rk_" ? "restricted" : "standard", checks: out };
}

module.exports = {
  checkKey,
  enabled, publishableKey, testMode, PaymentError, HOLD_DAYS,
  startCardSetup, finishCardSetup, payoutLink, refreshPayouts,
  placeHold, releaseHold, settle, holdDue, maxCharge, registerDomains,
};
