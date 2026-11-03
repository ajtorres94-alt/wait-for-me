// How much a job costs.
//
// Two kinds of request:
//   - "pickup" (Pick it up for me): the waiter waits in line, buys the item with their own
//     money, and hands it over. The booker pays the waiter's time, the item at the receipt
//     price, an optional drop-off fee, and the fees below. The waiter gets their time,
//     the drop-off fee, and the item cost back.
//   - "spot" (Save my spot): the waiter saves a spot where saving one is normal (a parade
//     curb, a lawn seat, a campout) and hands it over with the booker's code.
//
// Time:
// - The clock runs from the waiter's check-in to the handover (for pickups, to the purchase).
// - Billed in 15-minute steps, rounded up, with a 15-minute minimum.
// - Never more than the time the booker approved (the estimate plus any added time).
// - Approved time ran out and the waiter ended the shift: the full approved time.
// - Booker didn't show at the front (older line-swap jobs): time waited, including the
//   30-minute grace period, up to 30 minutes past the approved time.
// - Booker cancelled: free if early, 30 minutes of waiter pay (no fees) if late or once the
//   waiter was on the way, time waited if the waiter was already in line.
//
// Fees (kept by Wait For Me!): 15% of the waiter's time pay, a booking fee ($4.99 for pickups,
// $2.50 for saved spots), and 3% of
// the item price to cover card processing. No fees on a late cancellation or a sold-out pickup.
// ASAP requests add a $4 rush bonus that goes entirely to the waiter.
// Waiters earn at least $8 for their time on any job they're paid for.
// Booker misses a pickup meetup: they pay the waiter's time (and any drop-off fee) and our fees, but
// not the item. The waiter keeps the item.

const FEE = 0.15;
const MIN_HOURS = 0.25; // shortest time billed once a waiter checks in
const LATE_CANCEL_HOURS = 0.5; // a late cancellation pays the waiter for 30 minutes (they may already be on the way)
const BOOKING_FEE = 2.5; // saved spots
const PICKUP_BOOKING_FEE = 4.99;
const bookingFeeFor = (line) => (kindOf(line) === "pickup" ? PICKUP_BOOKING_FEE : BOOKING_FEE);
const ITEM_FEE = 0.03;
const MIN_PAY = 8; // least a waiter earns for their time on a paid job
const RUSH_FEE = 4; // ASAP requests: a bonus paid to the waiter
// Pricing v2 (requests posted from Nov 2026): one service fee of $2.99 + 9% of the waiter's time and the item, at most $12.
const BASE_FEE = 2.99;
const PCT_FEE = 0.09;
const FEE_CAP = 12;
const v2 = (line) => Number(line.pricingV) >= 2;
// Group runs: when a waiter buys several orders at the same stand in one wait, each booker pays 75%
// of the usual time charge (at least $6). The waiter still earns more for that wait than for one order.
// Group-run discount on the waiter-time charge, by how many orders share the wait.
const GROUP_DISCOUNT = { 2: 0.1, 3: 0.15, 4: 0.2, 5: 0.25 };
const groupDiscount = (size) => GROUP_DISCOUNT[Math.min(5, Math.max(2, Number(size) || 2))];
const BUNDLE_RATE = 0.75; // kept for older callers; the discount now depends on group size
const BUNDLE_MIN_PAY = 6;
// On a group run the waiter earns at most $35/hr for the shared wait (or the highest agreed rate, if higher,
// and never less than the $8 job minimum). What bookers pay beyond that stays with Wait For Me!.
const GROUP_MAX_HOURLY = 35;
// Small orders (item limit up to $25, so about a $20 item): a $6 minimum for the waiter's time and a
// $1.49 base fee instead of $8 and $2.99, so a drink or a snack isn't buried in fixed charges.
const SMALL_BUDGET = 25;
const SMALL_MIN_PAY = 6;
const SMALL_BASE_FEE = 1.49;
const isSmall = (line) => kindOf(line) === "pickup" && Number(line.itemBudget) > 0 && Number(line.itemBudget) <= SMALL_BUDGET;
const jobMinPay = (line) => (isSmall(line) ? SMALL_MIN_PAY : MIN_PAY);
// Add-ons: an order a waiter picks up while already in line at that stand for someone else costs them
// almost no extra time, so it's a flat $3 to the waiter and a $1 fee, with no time charge.
const ADDON_PAY = 3;
const ADDON_FEE = 1;
const serviceFeeV2 = (timePay, item, small = false) => roundCents(Math.min(FEE_CAP, (small ? SMALL_BASE_FEE : BASE_FEE) + PCT_FEE * (timePay + item)));
const MAX_ITEM = 150; // most a waiter can be asked to spend on an item, tax included
const HOUR = 3600 * 1000;

const roundCents = (n) => Math.round(n * 100) / 100;
const quarterUp = (h) => Math.ceil(h * 4 - 1e-9) / 4;
function kindOf(line) {
  return line.kind === "pickup" ? "pickup" : "spot";
}

function billing(line, now = Date.now()) {
  const approved = Number(line.approvedHours ?? line.hours);
  const pickup = kindOf(line) === "pickup";
  const bought = pickup && !!line.purchasedAt && line.outcome !== "sold_out";
  // Booker missed the meetup: they aren't charged for the item; the waiter keeps it.
  const itemCharged = bought && line.outcome !== "pickup_noshow";
  const checkin = line.checkinAt ? new Date(line.checkinAt).getTime() : null;
  const endAt = bought ? line.purchasedAt : line.doneAt;
  const end = endAt ? new Date(endAt).getTime() : now;
  const waited = checkin ? Math.max(0, (end - checkin) / HOUR) : 0;
  let feeRate = FEE;

  let billed;
  switch (line.outcome) {
    case "cancelled_free":
      billed = 0;
      break;
    case "cancelled_late":
      billed = LATE_CANCEL_HOURS;
      feeRate = 0;
      break;
    case "time_up":
      billed = checkin ? approved : 0;
      break;
    case "sold_out": // sold out through no one's fault: the waiter is paid for the time, and we waive our fees
      billed = checkin ? Math.min(approved, Math.max(MIN_HOURS, quarterUp(waited))) : 0;
      feeRate = 0;
      break;
    case "customer_noshow":
      billed = checkin ? Math.min(approved + 0.5, Math.max(MIN_HOURS, quarterUp(waited))) : 0;
      break;
    default:
      billed = checkin ? Math.min(approved, Math.max(MIN_HOURS, quarterUp(waited))) : 0;
  }

  const small = isSmall(line);
  const jobMin = small ? SMALL_MIN_PAY : MIN_PAY;
  const addOn = !!line.addOn && billed > 0 && line.outcome !== "cancelled_late";
  const rawPay = roundCents(billed * line.rate);
  const minApplied = !addOn && billed > 0 && rawPay < jobMin;
  const fullTimePay = addOn ? ADDON_PAY : minApplied ? jobMin : rawPay;
  const grouped = !addOn && !!line.bundled && billed > 0 && line.outcome !== "cancelled_late";
  const discount = grouped ? groupDiscount(line.bundleSize) : 0;
  const groupMin = small ? roundCents(SMALL_MIN_PAY * BUNDLE_RATE) : BUNDLE_MIN_PAY;
  const timePay = grouped ? Math.max(groupMin, roundCents(rawPay * (1 - discount))) : fullTimePay;
  const bundleSaving = grouped ? roundCents(fullTimePay - timePay) : 0;
  const runSize = Math.max(2, Number(line.bundleSize) || 2);
  const runCap = Math.max(jobMin, Math.max(GROUP_MAX_HOURLY, Number(line.rate)) * billed);
  const waiterTimePay = grouped ? Math.min(timePay, roundCents(runCap / runSize)) : timePay;
  const groupMargin = roundCents(timePay - waiterTimePay);
  const item = itemCharged ? roundCents(Number(line.itemTotal) || 0) : 0;
  const dropoff = bought && line.handoff === "dropoff" ? roundCents(Number(line.dropoffFee) || 0) : 0;
  // ASAP requests: the rush fee goes to the waiter as a bonus (not on late cancellations).
  const rushFee = line.rush && billed > 0 && line.outcome !== "cancelled_late" ? RUSH_FEE : 0;
  const waiterPay = roundCents(waiterTimePay + dropoff + rushFee);
  const charged = feeRate > 0 && billed > 0;
  const serviceFee = addOn ? (charged ? ADDON_FEE : 0) : v2(line) ? (charged ? serviceFeeV2(timePay, item, small) : 0) : roundCents(timePay * feeRate);
  const bookingFee = !v2(line) && charged ? bookingFeeFor(line) : 0;
  const itemFee = v2(line) ? 0 : roundCents(item * ITEM_FEE);
  const fee = roundCents(serviceFee + bookingFee + itemFee + groupMargin);
  return {
    approvedHours: approved,
    waitedHours: Math.round(waited * 100) / 100,
    billedHours: billed,
    timePay,
    minApplied,
    small,
    addOn,
    bundled: grouped,
    groupDiscount: discount,
    bundleSaving,
    waiterTimePay,
    groupMargin,
    dropoff,
    waiterPay,
    item,
    serviceFee,
    bookingFee,
    itemFee,
    rushFee,
    fee,
    payout: roundCents(waiterPay + item), // what the waiter receives
    total: roundCents(waiterPay + item + fee),
    timeUp: checkin ? waited >= approved : false,
  };
}

// The most a job could cost right now (used for the card hold and the "up to" price).
function maxTotal(line) {
  const hours = Number(line.approvedHours ?? line.hours) + 0.5;
  const time = Math.max(jobMinPay(line), hours * Number(line.rate));
  if (v2(line)) {
    const budget = kindOf(line) === "pickup" ? Number(line.itemBudget) || 0 : 0;
    return time + budget + serviceFeeV2(time, budget, isSmall(line)) + (line.rush ? RUSH_FEE : 0);
  }
  let total = time * (1 + FEE) + bookingFeeFor(line) + (line.rush ? RUSH_FEE : 0);
  if (kindOf(line) === "pickup") {
    const budget = Number(line.itemBudget) || 0;
    total += budget * (1 + ITEM_FEE);
    if (line.handoff === "dropoff") total += Number(line.dropoffFee) || 0;
  }
  return total;
}

module.exports = { SMALL_BUDGET, SMALL_MIN_PAY, SMALL_BASE_FEE, ADDON_PAY, ADDON_FEE, isSmall, GROUP_DISCOUNT, groupDiscount, GROUP_MAX_HOURLY, BUNDLE_RATE, BUNDLE_MIN_PAY, BASE_FEE, PCT_FEE, FEE_CAP, MIN_PAY, RUSH_FEE, PICKUP_BOOKING_FEE, bookingFeeFor, MIN_HOURS, billing, maxTotal, kindOf, FEE, BOOKING_FEE, ITEM_FEE, MAX_ITEM };
