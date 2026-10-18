// How much a line costs, based on time actually spent in line.
//
// - The clock runs from the waiter's check-in ("I'm in line") to the swap.
// - Billed in 15-minute steps, rounded up, with a 1-hour minimum.
// - Never more than the time the booker approved (the estimate plus any added time).
// - If the approved time runs out and the waiter ends the shift, the full approved time is billed.

const FEE = 0.15;
const HOUR = 3600 * 1000;

const roundCents = (n) => Math.round(n * 100) / 100;

function billing(line, now = Date.now()) {
  const approved = Number(line.approvedHours ?? line.hours);
  const checkin = line.checkinAt ? new Date(line.checkinAt).getTime() : null;
  const end = line.doneAt ? new Date(line.doneAt).getTime() : now;
  const waited = checkin ? Math.max(0, (end - checkin) / HOUR) : 0;

  let billed;
  if (line.outcome === "time_up") billed = approved;
  else billed = Math.min(approved, Math.max(1, Math.ceil(waited * 4 - 1e-9) / 4));
  if (!checkin) billed = 0;

  const waiterPay = roundCents(billed * line.rate);
  const fee = roundCents(waiterPay * FEE);
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
