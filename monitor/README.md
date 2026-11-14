# Pulse monitor

Shows whether players on caser.gg get back more or less right now than a few hours ago. Two parts:

- **The monitor** (`src/`, runs in Docker): samples other players' recent upgrades and case drops and writes
  them to Supabase.
- **The dashboard** (`dashboard/`, a static page): reads them back for a signed-in viewer and shows
  - for upgrades and for cases, return per 1 staked in the last hour against the 3 hours before, with a verdict
    ("Higher now", "Lower now", "No clear change", "Not enough data yet") from a significance test;
  - return per 1 over 6 hours to 30 days, per bucket with 95% ranges;
  - the site's own counters of upgrades and case opens per minute;
  - a table per bucket, and whether the monitor is running.

It is not part of the userscript in the parent folder.

## How it samples

- `GET /api/live-drops` every 30 s finds active players. The feed shows big wins, so the sample leans towards big
  spenders.
- A newly found player's latest page of upgrades and case drops (`/api/game/upgrade/public-history/{id}`,
  `/api/users/{id}/inventory/history`) is read at once. The feed wins that found them are left out, or every
  player would start with a big win. Rows older than 24 hours are left out.
- Then the player is followed for up to 2 hours (one of the two lists about every 90 s), the same for winners and
  losers, and dropped after 40 minutes without new rows. At most 30 players are followed at once.
- `GET /api/statistics` every 60 s for the site-wide counters, `GET /api/game/cases` every 6 hours for case prices.

Return per 1 = total value received / total staked. Its 95% range treats each player's rows as one cluster, since
one player's rows are not independent. Players are stored only as a salted hash of their site id; no names, items
or inventories are kept.

## Account and requests

The profile history endpoints need a signed-in account, so the monitor uses one: set one aside for it that you can
lose. The site can see that this account reads many profiles, and may limit or ban it.

- One request every 8 seconds by default (`PULSE_GAP_MS`), about 450 an hour.
- Requests say they come from a script (`User-Agent: pulse-collector/<version> node/<version>`). The monitor
  does not disguise itself or work around blocks.
- HTTP 429 pauses it for 5 minutes, doubling up to 30.
- A refused login, HTTP 403 or a challenge page stops the collector, and the dashboard shows why. No more requests
  go to the site, so the restart policy does not retry in a loop.

Login: the site keeps a short-lived access token and a refresh token in the browser's `localStorage`. The monitor
needs only the refresh token and renews the access token itself (`POST /api/users/auth/refresh`), the way the
site's web app does. The site may hand out a new refresh token on each renewal; the monitor saves the latest one in
`data/state.json`, so restarts keep working.

## Supabase

Tables and functions: `supabase/migrations/*_monitor*.sql` in the parent folder (already applied to the project).

- `monitor_rows`, `monitor_volume`, `monitor_status`: written only by the monitor, with the project's **secret key**
  (it bypasses row level security, so it stays on the server, in `.env`).
- `monitor_viewers`: Supabase Auth users allowed to read. Everyone else, signed in or not, reads nothing.
- `monitor_agg`, `monitor_volume_agg`: sums per time bucket for the dashboard, for viewers only.
- The monitor deletes rows older than `RETENTION_DAYS` (default 30) once an hour.

## Run the monitor

1. In a browser signed in to the account for the monitor, open caser.gg, press F12, and run
   `localStorage.getItem('refresh_token')` in the console. Copy the value without the quotes.
2. Stop using that login in the browser: close the tab without logging out, then clear caser.gg's site data in that
   browser (or do not open caser.gg there again). Logging out may end the token, and a browser renewing the same
   token may end the monitor's session.
3. Get the secret key: Supabase dashboard, Project Settings, API Keys, "Secret keys" (`sb_secret_…`).
4. Copy `.env.example` to `.env` and fill in `CASER_REFRESH_TOKEN` and `SUPABASE_SECRET_KEY`. Never commit `.env`.
5. Start it:
   - Docker: `docker compose up -d --build`, logs with `docker compose logs -f`.
   - Plain Node (20.6+): `node --env-file=.env src/main.js`.

When the refresh token stops working, the log and the dashboard say the collector stopped: put a new token in `.env`
and run `docker compose up -d`. A changed `CASER_REFRESH_TOKEN` replaces the saved tokens.

| Variable | Default | |
|---|---|---|
| `CASER_REFRESH_TOKEN` | | refresh token of the monitor's account |
| `SUPABASE_SECRET_KEY` | | the project's secret key |
| `SUPABASE_URL` | the project in `dashboard/config.js` | |
| `RETENTION_DAYS` | 30 | rows older than this are deleted |
| `CASER_BASE` | https://caser.gg | site origin |
| `PULSE_GAP_MS` | 8000 | pause between requests, at least 2000 |
| `DATA_DIR` | ./data | state file (tokens, hash salt, rows not yet sent) |
| `USER_AGENT` | pulse-collector/… | request User-Agent |

## The dashboard

`dashboard/` is a static page (HTML and two small modules, plus supabase-js from jsDelivr). Host it anywhere that
serves static files. `dashboard/config.js` holds the Supabase URL and the publishable key, which are public by
design: on their own they read nothing.

Give yourself access once:

1. Supabase dashboard, Authentication, Users, "Add user": your email and a password ("Auto Confirm User" on).
2. Authentication, Sign In / Providers: switch off "Allow new users to sign up", so nobody else can make an account.
3. Sign in on the dashboard. It shows your user id and the line to run in the SQL editor:
   `insert into public.monitor_viewers (user_id) values ('<your user id>');`
4. Reload the page.

## Develop

```
npm test
```

Files: `src/parse.js` (history pages to rows), `src/collector.js` (what to read when), `src/site.js` (login token
and requests), `src/cloud.js` (Supabase writes), `src/main.js` (settings and wiring), `dashboard/stats.js` (return
per 1, ranges, comparison), `dashboard/view.js` (database answers to what the page shows), `dashboard/index.html`.
