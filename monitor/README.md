# Pulse monitor

Shows whether players on caser.gg get back more or less right now than at other times. Two parts:

- **The monitor** (`src/`, runs in Docker): samples other players' upgrades and case drops and writes them to
  Supabase, with an event log and alerts when something goes wrong.
- **The dashboard** (`dashboard/`, a static page): reads them back for a signed-in viewer.

It is not part of the userscript in the parent folder.

## What the dashboard shows

Two measures, for upgrades and for cases:

- **Index**: observed against expected. For upgrades, wins against the wins the shown chances predict. For cases,
  "hits" (an open worth at least the case price) against the hits the case's normal rate predicts (its rate over
  the last 7 days). Each upgrade or open counts once, whatever its size, so this settles quickly. 1 means as
  expected; above 1 is better for players. Its 95% range is binomial: every upgrade or open is a separate draw.
- **Return per 1**: total value received per 1 staked. What players actually got, but a single big win moves it a
  lot, so it needs far more data to show a change. Its 95% range is clustered by player.

Sections:

- the monitor's state and its recent events (problems are listed here too);
- **right now**: the last 30 minutes against the 90 minutes before, or the last hour against the 3 hours before
  (a switch), with a significance test;
- totals for the range (30 minutes to 30 days, opening on the last hour), including the share of players who
  ended up in profit;
- **one chart for upgrades and one for cases, per window** (1 minute to 1 day, depending on the range; index or
  return per 1), with each window's 95% range, a smoothed line, the range average, sample sizes, and the best and
  worst windows;
- a weekday × hour heat map (local time) over the last 7 days, whatever the range;
- upgrades by shown chance (where the shown odds are off the most), cases one by one, stake sizes;
- site activity from the site's public counters.

## How it samples

One request every 8 seconds (`PULSE_GAP_MS`), about 450 an hour. Each turn does the most urgent thing that is due:

1. `GET /api/game/cases` every 6 hours (case prices), `GET /api/live-drops` every 30 s (finds active players; the
   feed shows big wins, so the sample leans towards big spenders), `GET /api/statistics` every 60 s.
2. A newly found player's latest page of upgrades and case drops (`/api/game/upgrade/public-history/{id}`,
   `/api/users/{id}/inventory/history`). The feed wins that found them are left out, or every player would start
   with a big win.
3. Following: one of the two lists of a followed player about every 90 s, for 2 hours after they were found.
4. When nothing above is due:
   - **revisits**: every player the feed has shown is remembered (up to 5,000, for 14 days after they were last
     seen) and checked again for new rows: every 10 minutes while they played in the last 30 minutes (these
     come before anything else here), every 30 minutes if they played in the last 3 hours, every 2 hours within a
     day, else every 6 hours (`REVISIT_HOURS`). The dashboard shows how many known players are playing now.
   - **history**: older pages of each new player's lists, back 7 days (`HISTORY_DAYS`), at most 10 pages each
     (`HISTORY_PAGES`).

Why revisits rather than the drop board alone: the board only shows drops worth about 3,500 or more, so players
who play small never appear there. The site has no way to ask whether a given player is online (it only
publishes the total online count), but a player's own history shows when they last played. So once the board has
shown a player, revisits keep them in the sample whenever they play, small or big. Polling the board every 30 s
already catches nearly every entry (it changes by a few entries per 10 s), so its live websocket would add
little.

Once per installation the monitor also reads one player's profile and logs only its field names (event
`profile-fields`), in case the site adds or shows a last-online time there.

Pages: the site's own pages ask for 50 rows. The monitor asks for 100 once and keeps that if the site sends more
than 50, or falls back to 50; the event log says which.

Players are stored in Supabase only as a salted hash of their site id. The real ids of known players stay in the
monitor's own state file on the server (they are needed for revisits).

## Account and requests

The profile history endpoints need a signed-in account, so the monitor uses one: set one aside for it that you can
lose. The site can see that this account reads many profiles, and may limit or ban it.

- Requests say they come from a script (`User-Agent: pulse-collector/<version> node/<version>`). The monitor
  does not disguise itself or work around blocks.
- HTTP 429 pauses it for 5 minutes, doubling up to 30.
- HTTP 401 (the login is refused) or 403 / a challenge page (blocked) stops the collector. No more requests go to
  the site, so the restart policy does not retry in a loop.

Login: the site keeps a short-lived access token and a refresh token in the browser's `localStorage`. The monitor
needs only the refresh token and renews the access token itself (`POST /api/users/auth/refresh`), the way the
site's web app does. The site may hand out a new refresh token on each renewal; the monitor saves the latest one in
`data/state.json`, so restarts keep working.

## Problems and alerts

Every problem is written to the event log (`monitor_events`, shown on the dashboard) and, with `ALERT_URL` set,
sent to your phone or chat:

| What | Level |
|---|---|
| the site refuses the login (token expired or revoked): collector stops | error |
| the site blocks the account or server (403, challenge page): collector stops | error |
| the site asks to slow down (429) | warning, error once the pause reaches 30 min |
| 5 failed turns in a row (network, site errors), and when it recovers | warning / note |
| writing to Supabase fails 5 times in a row (rows wait on the server), and when it recovers | alert only / note |
| the monitor crashed (it restarts by itself) | error |
| the monitor was killed without shutting down (out of memory, server restart) | error, on the next start |
| **no report for 10 minutes** (container gone, server down): from the database watchdog | error, and a note when it is back |
| still stopped, every 6 hours | reminder |

The same problem is sent at most once per 30 minutes. A stopped collector reports `running: false` and the
watchdog leaves it alone (it already alerted).

`ALERT_URL` formats:

- **ntfy** (easiest): install the ntfy app, subscribe to a long random topic name, use `https://ntfy.sh/<topic>`.
  Anyone who knows the topic name can read it, so make it hard to guess.
- **Discord**: a channel's webhook URL, `https://discord.com/api/webhooks/...`.
- **Telegram**: `https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>`.

When `ALERT_URL` is set or changed, the monitor sends "alerts are set up" once, so you know it works. It also
saves the URL in Supabase (`monitor_private`, readable only by the secret key and the database) for the
watchdog, a `pg_cron` job that runs every 5 minutes.

## Supabase

Tables and functions: `supabase/migrations/*_monitor*.sql` in the parent folder (already applied to the project).

- `monitor_rows`, `monitor_volume`, `monitor_status`, `monitor_events`: written only by the monitor, with the
  project's **secret key** (it bypasses row level security, so it stays on the server, in `.env`).
- `monitor_viewers`: Supabase Auth users allowed to read. Everyone else, signed in or not, reads nothing.
- `monitor_report`, `monitor_volume_agg`: what the dashboard reads, for viewers only.
- `monitor_private`, `monitor_watchdog`, `monitor_send_alert`: the alert URL and the watchdog; no one else can
  read or call them.
- The monitor deletes rows and events older than `RETENTION_DAYS` (default 30) once an hour.

## Run the monitor

1. In a browser signed in to the account for the monitor, open caser.gg, press F12, and run
   `localStorage.getItem('refresh_token')` in the console. Copy the value without the quotes.
2. Stop using that login in the browser: close the tab without logging out, then clear caser.gg's site data in that
   browser (or do not open caser.gg there again). Logging out may end the token, and a browser renewing the same
   token may end the monitor's session.
3. Get the secret key: Supabase dashboard, Project Settings, API Keys, "Secret keys" (`sb_secret_…`).
4. Copy `.env.example` to `.env` and fill in `CASER_REFRESH_TOKEN`, `SUPABASE_SECRET_KEY` and `ALERT_URL`. Never
   commit `.env`.
5. Start it:
   - Docker: `docker compose up -d --build`, logs with `docker compose logs -f`.
   - Plain Node (20.6+): `node --env-file=.env src/main.js`.

When the refresh token stops working, you get an alert and the dashboard says why: put a new token in `.env` and
run `docker compose up -d`. A changed `CASER_REFRESH_TOKEN` replaces the saved tokens.

## Update the monitor

On the server, in this folder:

```
sh update.sh
```

It pulls the latest code, builds the new image while the old container keeps collecting, then swaps them. The old
one stops gracefully (it sends its unsent rows and saves its state first), and the new one continues with the same
login, player hashes and known players. Downtime is a few seconds. Keep settings in `.env` only; changes to tracked
files on the server make `git pull` refuse.

Database changes for a new version are applied to Supabase before the code is pushed, and are additive, so the
running monitor keeps working until it is updated.

## Settings

| Variable | Default | |
|---|---|---|
| `CASER_REFRESH_TOKEN` | | refresh token of the monitor's account |
| `SUPABASE_SECRET_KEY` | | the project's secret key |
| `ALERT_URL` | | ntfy, Discord or Telegram webhook for alerts |
| `SUPABASE_URL` | the project in `dashboard/config.js` | |
| `RETENTION_DAYS` | 30 | rows and events older than this are deleted |
| `HISTORY_DAYS` | 7 | how far back a found player's history is read |
| `HISTORY_PAGES` | 10 | older pages read per list per player (0: only the latest page) |
| `REVISIT_HOURS` | 6 | how often known players who have not played for a day are checked again |
| `CASER_BASE` | https://caser.gg | site origin |
| `PULSE_GAP_MS` | 8000 | pause between requests, at least 2000 |
| `DATA_DIR` | ./data | state file (tokens, hash salt, known players, rows and events not yet sent) |
| `USER_AGENT` | pulse-collector/… | request User-Agent |

## The dashboard

`dashboard/` is a static page (HTML and two small modules, plus supabase-js from jsDelivr), hosted on Vercel.
Redeploy after changes with `vercel deploy --prod` in that folder, or connect the Vercel project to the GitHub repo
(root directory `monitor/dashboard`) so every push deploys it. `dashboard/config.js` holds the Supabase URL and the
publishable key, which are public by design: on their own they read nothing.

Give someone access once:

1. Supabase dashboard, Authentication, Users, "Add user": email and password ("Auto Confirm User" on).
2. Authentication, Sign In / Providers: switch off "Allow new users to sign up", so nobody else can make an account.
3. They sign in on the dashboard. It shows their user id and the line to run in the SQL editor:
   `insert into public.monitor_viewers (user_id) values ('<user id>');`

## Develop

```
npm test
```

Files: `src/parse.js` (history pages to rows), `src/collector.js` (what to read when), `src/site.js` (login token
and requests), `src/cloud.js` (Supabase writes), `src/notify.js` (alerts), `src/main.js` (settings, events, crash
handling), `dashboard/stats.js` (return per 1, index, ranges, comparisons), `dashboard/view.js` (database answers to
what the page shows), `dashboard/index.html`.
