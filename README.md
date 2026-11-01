# Wait For Me!

Book someone to wait in line and pick it up for you, or get paid to wait.

Two kinds of request:

- **Pick it up for me:** the waiter waits in line, buys one item (limit set by the booker, up to $150 with tax), records the receipt total with a photo, and hands it over at a meetup or a drop-off.
- **Save my spot:** the waiter saves a spot where that's normal (parade route, fireworks, outdoor movie lawn, campout) and hands it over with the booker's code. Posting requires confirming it isn't line-cutting; Wait For Me! does not condone or endorse line-cutting.

Real accounts and shared data: a line posted on one phone shows up for waiters on every other phone, and updates (claimed, on the way, place in line, swap) appear within about 5 seconds.

## What's in here

| File | What it does |
| --- | --- |
| `server.js` | Serves the app and the API: sign-up, sign-in, posting, claiming, status updates, swap codes. |
| `store-postgres.js` | Saves everything in Postgres. Used automatically when `DATABASE_URL` is set. |
| `store-memory.js` | Keeps data in memory when there's no database. Data resets on every redeploy. |
| `package.json` | Tells Railway to install the Postgres library and run `npm start`. |
| `public/` | The app itself, its icons, and the install files. |

## Update the repo

Replace everything in the `wait-for-me` GitHub repo with the files in this folder (keep `package.json` at the top level). Commit, and Railway redeploys on its own.

The app works right away, but without a database every redeploy wipes accounts and lines. Add Postgres next.

## Add the database on Railway (one time)

1. Open your Railway project and click **+ Create** (or **New**), then **Database → Add PostgreSQL**.
2. Click your **wait-for-me** service, open **Variables**, and click **New Variable**.
3. Name it `DATABASE_URL`. For the value, type `${{Postgres.DATABASE_URL}}` (or pick it from the reference dropdown). Save.
4. Railway redeploys. Open **Deployments → View logs**; you should see `storage: postgres`.
5. Check it anytime at `/api/health` on your site. It shows `"storage":"postgres"` when the database is connected.

The app creates its own tables on first start.

## How billing works

The clock starts when the waiter checks in and stops at the purchase (pickups) or when the handover code is entered (saved spots). Time is billed in 15-minute steps, rounded up (waiters earn at least $8 per paid job), and never more than the time the booker approved. Each request starts with 2 hours approved; the booker can add 30 minutes at a time. If the approved time runs out, the waiter can end the job and is paid for the full approved time.

Fees (kept by the platform): 15% of the waiter's time, a booking fee ($4.99 pickups, $2.50 spots), 3% of the item price for pickups, and a $1.99 rush fee on ASAP requests. The booker also pays the item at the receipt price and any drop-off fee, which goes to the waiter. No fees on late cancellations or sold-out pickups. The logic lives in `billing.js`.

Pickup rules: the waiter can only record a purchase when the booker's card hold is in place; purchases over the item limit are refused; a bought pickup can't be cancelled; the waiter holds the item for 4 hours after buying (bookers are asked to meet within 30 minutes for food) and gets a reminder 20 minutes before it ends; after it, the waiter can close the job once they've messaged the booker since buying (admins are alerted when a waiter reaches 2 missed meetups): the booker pays time and fees but not the item, and the waiter keeps it (messages stay open 7 days). A waiter can't have more than $200 of unbought item limits claimed at once (`FLOAT_MAX`), and claiming several at once needs 10 finished jobs (`BATCH_MIN_JOBS`; admins exempt). The booker can raise the item limit during the job (the card hold is replaced). Sold out requires a photo. Alcohol, tobacco/vapes, cannabis, prescriptions, weapons, lottery tickets, gift/prepaid cards and money orders are refused when posting. Receipt photos are stored in the `receipts` table and served at `/api/lines/:id/receipt` to the booker, waiter and admins only.

## Ratings

After a job, the booker rates the waiter and the waiter rates the booker (1–5 stars plus optional tags). Ratings stay private for 3 days after the job, and an average only shows once someone has 3 or more. Ratings can be left for 7 days.

## Events, batch claiming and problem reports

- Admins add events (name, venue, start, end) on `/admin`. Bookers can tag a request with a live or upcoming event; the place defaults to the venue.
- Waiters tap **I'm here** on an event in Find jobs; each new request tagged with it sends them a phone alert. Requests can be filtered by event.
- **Claim several at once** claims up to 5 open requests in one call (`POST /api/lines/claim-batch`), each with its own card hold. My jobs offers **I'm there for all N** for jobs at the same event or place.
- **Report a problem** on any job (up to 14 days after) creates a report, alerts admins and emails `SUPPORT_EMAIL`. On `/admin`, resolve it with a note and an optional Stripe refund, either paid by the platform or taken back from the waiter's share and the fee.
- The restricted Stripe key needs write access to Refunds; **Check Stripe** on `/admin` tests it.

## Phone alerts

Web Push with no extra packages (`push.js`). VAPID keys are generated on first start and saved in the `app_settings` table, so there's nothing to set up. Phones subscribe from Account → Alerts (iPhone: after adding the app to the Home Screen). Alerts go out for claims, offers, status changes, purchases, sold out, cancellations, messages, added time, raised limits, and a meetup reminder (checked every 5 minutes). Only Apple, Google, Mozilla and Microsoft push services are accepted as destinations.

## How the handover code works

Only the customer can see their 4-digit code. When they meet, the customer reads it to the waiter in person, and the waiter types it in to finish the job. Wrong codes are rejected.

## Near me (waiters)

When a line is posted, the server looks up map coordinates for the "Where is the line?" text using OpenStreetMap's free Nominatim service (`geocode.js`, about one lookup per second). If the full text isn't found, it falls back to the part after the first comma (usually the city) and marks the distance as approximate. Waiters' locations stay on their phones; distances are worked out on the device.

## Privacy, terms, and support pages

`/privacy`, `/terms`, and `/support` are served from `public/`. Set these Railway variables when ready:

- `SUPPORT_EMAIL`: shown as the contact address on all three pages
- `COMPANY_NAME`: your legal business name (defaults to "Wait For Me!")

## Admin page

Visit `/admin` while signed in with an email listed in the `ADMIN_EMAILS` Railway variable (comma-separated). It lists people and recent lines, and lets you remove a line, suspend or restore an account, and give someone a temporary password.

## Payments (Stripe Connect)

Turned on by `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` (use `sk_test_`/`pk_test_` keys to test, then the live keys to go live). Without them, the app runs with no payments, as before.

- **Bookers** save a card, Apple Pay, or Google Pay in Account (Stripe's Payment Element). A card is required to post a line.
- **Waiters** set up payouts in Account through Stripe's hosted Express onboarding. Payouts must be on to claim a line or make an offer.
- **Holds:** when a waiter is booked and the line starts within 5 days, the booker's card gets a manual-capture hold for (approved hours + 0.5) × rate × 1.15 + the booking fee, plus the item limit × 1.03 and any drop-off fee for pickups. A background job places holds as lines come within 5 days, and adding time replaces the hold with a bigger one.
- **Charging:** when the job ends, the app captures the actual bill (`billing.js`) as a destination charge: the waiter's share goes to their Express account, and the 15% fee stays with the platform as the application fee. Free cancellations and waiter no-shows release the hold. Late cancellations charge 30 minutes of waiter time with no fees.
- **Declines:** a declined hold keeps the booking, marks it unsecured, and asks the booker to update their card (updating retries right away). Failed charges are retried every 10 minutes for 6 days.
- Waiter accounts are created with `controller.losses.payments = application`, `controller.fees.payer = application`, and an Express dashboard, so the platform is responsible for refunds and disputes.
- Apple Pay and Google Pay need the domain registered with Stripe; the server registers waitforme.io at startup.
- **Switching test ↔ live keys:** test and live mode have separate customers, cards and payout accounts. On startup the server notices a mode change and clears saved cards, payout setups and unfinished holds, so everyone adds their card and sets up payouts again in the new mode. Finished jobs keep their history.

## Email (password reset)

"Forgot password?" on the sign-in screen emails a one-time link (valid 1 hour) to `/reset`.

Railway blocks outgoing SMTP ports, so on Railway email goes through Resend's web API:

| Variable | Value |
| --- | --- |
| `RESEND_API_KEY` | an API key from resend.com, with waitforme.io verified in Resend |
| `MAIL_FROM` | optional; defaults to `SUPPORT_EMAIL` (support@waitforme.io) |
| `MAIL_REPLY_TO` | optional; defaults to `SUPPORT_EMAIL` |
| `APP_URL` | optional; the address used in links, e.g. `https://waitforme.io` |

On a host that allows SMTP, `SMTP_USER` and `SMTP_PASS` (a Gmail app password) work instead. Without either, the reset screen tells people to email support. Use **Send test email** on the admin page to check the setup. `COMPANY_NAME` (default `ATowers Enterprises LLC`) is the company named on the privacy and terms pages.

`/dashboard` (same admin emails) is the creator dashboard: bookings and revenue, completed jobs, fill rate, new and active users, a per-day chart, a weekday-by-hour heatmap of busy times, a map and table of top cities, top venues, line types, marketplace health, and top waiters and bookers. Pick 7, 30, 90 days, 1 year or all time; it refreshes every minute and shows times in your phone's or computer's time zone. City names come from OpenStreetMap when a line is posted; older lines are filled in when the server starts.

## Safety rules built in

- Swap codes reset after 5 wrong tries, and the booker is told.
- Check-in compares the waiter's location with the line's (about half a mile). Lines whose address could only be found at city level are checked in without verification and marked that way.
- Bookers can report a no-show 15 minutes after the start time; the line reopens and the waiter's no-show count goes up.
- Open lines leave Find lines 2 hours after their start time.
- Theme park lines are refused when posting.
- Limits: 10 open lines per booker, 20 posts a day, 30 offers an hour, 30 messages a minute.

## Not built yet

- Card payments and waiter payouts (planned: Stripe Connect)
- ID checks for waiters
- Push notifications (the app refreshes while it's open)
- Notifications when the app is closed (needs push setup)

## Testing

`WFM_TEST_HOOKS=1` turns on a test-only endpoint for moving the clock in automated tests. Never set it on Railway.
