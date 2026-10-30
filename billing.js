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

const FEE = 0.15;
const MIN_HOURS = 0.25; // shortest time billed once a waiter checks in
const LATE_CANCEL_HOURS = 0.5; // a late cancellation pays the waiter for 30 minutes (they may already be on the way)
const BOOKING_FEE = 2.5; // saved spots
const PICKUP_BOOKING_FEE = 4.99;
const bookingFeeFor = (line) => (kindOf(line) === "pickup" ? PICKUP_BOOKING_FEE : BOOKING_FEE);
const ITEM_FEE = 0.03;
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

  const timePay = roundCents(billed * line.rate);
  const item = bought ? roundCents(Number(line.itemTotal) || 0) : 0;
  const dropoff = bought && line.handoff === "dropoff" ? roundCents(Number(line.dropoffFee) || 0) : 0;
  const waiterPay = roundCents(timePay + dropoff);
  const serviceFee = roundCents(timePay * feeRate);
  const bookingFee = feeRate > 0 && billed > 0 ? bookingFeeFor(line) : 0;
  const itemFee = roundCents(item * ITEM_FEE);
  const fee = roundCents(serviceFee + bookingFee + itemFee);
  return {
    approvedHours: approved,
    waitedHours: Math.round(waited * 100) / 100,
    billedHours: billed,
    timePay,
    dropoff,
    waiterPay,
    item,
    serviceFee,
    bookingFee,
    itemFee,
    fee,
    payout: roundCents(waiterPay + item), // what the waiter receives
    total: roundCents(waiterPay + item + fee),
    timeUp: checkin ? waited >= approved : false,
  };
}

// The most a job could cost right now (used for the card hold and the "up to" price).
function maxTotal(line) {
  const hours = Number(line.approvedHours ?? line.hours) + 0.5;
  const time = hours * Number(line.rate);
  let total = time * (1 + FEE) + bookingFeeFor(line);
  if (kindOf(line) === "pickup") {
    const budget = Number(line.itemBudget) || 0;
    total += budget * (1 + ITEM_FEE);
    if (line.handoff === "dropoff") total += Number(line.dropoffFee) || 0;
  }
  return total;
}

module.exports = { PICKUP_BOOKING_FEE, bookingFeeFor, MIN_HOURS, billing, maxTotal, kindOf, FEE, BOOKING_FEE, ITEM_FEE, MAX_ITEM };
