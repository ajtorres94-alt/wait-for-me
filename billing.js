// How much a line costs, based on time actually spent in line.
//
// - The clock runs from the waiter's check-in ("I'm in line") to the swap.
// - Billed in 15-minute steps, rounded up, with a 1-hour minimum.
// - Never more than the time the booker approved (the estimate plus any added time).
// - Approved time ran out and the waiter ended the shift: the full approved time.
// - Booker didn't show at the front: time waited, including the 30-minute grace
//   period, up to 30 minutes past the approved time.
// - Booker cancelled: free if early, 1 hour of waiter pay (no service fee) if late
//   or once the waiter was on the way, time waited if the waiter was already in line.

const FEE = 0.15;
const HOUR = 3600 * 1000;

const roundCents = (n) => Math.round(n * 100) / 100;
const quarterUp = (h) => Math.ceil(h * 4 - 1e-9) / 4;

function billing(line, now = Date.now()) {
  const approved = Number(line.approvedHours ?? line.hours);
  const checkin = line.checkinAt ? new Date(line.checkinAt).getTime() : null;
  const end = line.doneAt ? new Date(line.doneAt).getTime() : now;
  const waited = checkin ? Math.max(0, (end - checkin) / HOUR) : 0;
  let feeRate = FEE;

  let billed;
  switch (line.outcome) {
    case "cancelled_free":
      billed = 0;
      break;
    case "cancelled_late":
      billed = 1;
      feeRate = 0;
      break;
    case "time_up":
      billed = checkin ? approved : 0;
      break;
    case "customer_noshow":
      billed = checkin ? Math.min(approved + 0.5, Math.max(1, quarterUp(waited))) : 0;
      break;
    default:
      billed = checkin ? Math.min(approved, Math.max(1, quarterUp(waited))) : 0;
  }

  const waiterPay = roundCents(billed * line.rate);
  const fee = roundCents(waiterPay * feeRate);
  return {
    approvedHours: approved,
    waitedHours: Math.round(waited * 100) / 100,
    billedHours: billed,
    waiterPay,
    fee,
    total: roundCents(waiterPay + fee),
    timeUp: checkin ? waited >= approved : false,
  };
}

module.exports = { billing, FEE };
