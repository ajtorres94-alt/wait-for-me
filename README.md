# Wait For Me!

Book someone to hold your spot in line, or get paid to wait.

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

The clock starts when the waiter taps **I'm in line** and stops when the swap code is entered. Time is billed in 15-minute steps, rounded up, with a 1-hour minimum, and never more than the time the booker approved. The estimate is the starting approval; the booker can add 30 minutes at a time. If the approved time runs out, the waiter can end the shift and is paid for the full approved time. The logic lives in `billing.js`.

## Ratings

After a job, the booker rates the waiter and the waiter rates the booker (1–5 stars plus optional tags). Ratings stay private for 3 days after the job, and an average only shows once someone has 3 or more. Ratings can be left for 7 days.

## How the swap code works

Only the customer can see their 4-digit code. At the front of the line, the customer reads it to the waiter in person, and the waiter types it in to finish the job. Wrong codes are rejected.

## Near me (waiters)

When a line is posted, the server looks up map coordinates for the "Where is the line?" text using OpenStreetMap's free Nominatim service (`geocode.js`, about one lookup per second). If the full text isn't found, it falls back to the part after the first comma (usually the city) and marks the distance as approximate. Waiters' locations stay on their phones; distances are worked out on the device.

## Privacy, terms, and support pages

`/privacy`, `/terms`, and `/support` are served from `public/`. Set these Railway variables when ready:

- `SUPPORT_EMAIL`: shown as the contact address on all three pages
- `COMPANY_NAME`: your legal business name (defaults to "Wait For Me!")

## Admin page

Visit `/admin` while signed in with an email listed in the `ADMIN_EMAILS` Railway variable (comma-separated). It lists people and recent lines, and lets you remove a line, suspend or restore an account, and give someone a temporary password.

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
- Waiters can end a shift 30 minutes after reaching the front if the booker doesn't swap in.
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
