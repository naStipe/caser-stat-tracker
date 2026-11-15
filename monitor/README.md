# Pulse monitor

Shows whether players on caser.gg get back more or less right now than at other times. Two parts:

- **The monitor** (`src/`, runs in Docker): samples other players' upgrades and case drops and writes them to
  Supabase, with an event log and alerts when something goes wrong.
- **The dashboard** (`dashboard/`, a static page): reads them back for a signed-in viewer.

It is not part of the userscript in the parent folder.

## What the dashboard shows

Three measures, for upgrades and for cases:

- **Index against normal**: observed against what is usual for the situation. For upgrades, wins against the wins
  the last 7 days' real rate predicts for the same shown-chance band and the same time into the player's session
  (a session starts after 20 minutes without play, usually a deposit). Early in a session low chances win far
  more often than shown and high chances always less, so an index against the shown chance mostly measures
  where players are in their sessions; this one does not. For cases, "hits" (an open worth at least the case
  price) against each case's rate over the last 7 days. Each upgrade or open counts once, whatever its size, so
  this settles quickly. 1 means as usual; above 1 is better for players. Its 95% range is binomial: every upgrade
  or open is a separate draw.
- **Index against the shown odds** (upgrades): wins against what the shown chances promise.
- **Return per 1**: total value received per 1 staked. What players actually got, but a single big win moves it a
  lot, so it needs far more data to show a change. Its 95% range is clustered by player.

Two corrections apply to every number:

- **Rows next to a player's discovery are left out**: from 2 hours before to 30 minutes after the moment the feed
  showed them. Players are found right after a big win, so they had a streak just before it (1.09 to 1.18 times
  the normal win rate on the data of 14 November) and a dip just after (0.85 to 0.89). The page says how many rows
  this leaves out.
- **Windows still filling are marked**: rows arrive minutes to hours after they happen (revisits, history pages).
  The database records when each row arrived, and windows newer than the time by which 80% of rows have arrived
  are shaded as "still arriving", are not ranked, and are not used by "right now".

Both, and the session phase, come from columns the database fills itself (`phase`, `near`, `added` in
`monitor_rows`, see `supabase/migrations/*_monitor_derive.sql`): a `pg_cron` job, `monitor_derive()`, runs every
minute for new rows and refreshes the 7-day normal rates (`monitor_cal`) every 30 minutes. The monitor sends
nothing extra.

Sections:

- **right now**, one card each for upgrades and cases: the last 30 minutes (or hour) up to the settled time against
  normal, described rather than judged: "within normal noise" under 2 standard errors, "slightly high/low, often
  chance" from 2 to 3 (checked every 30 minutes, about 2 a day happen by chance), "unusually high/low" from 3 (about
  once a week by chance), the only case shown in green or red. A line shows the last 6 hours (each point the 30
  minutes or hour before it, with its 95% range; dashed while rows are still arriving), and each card says whether
  such a window has predicted the next one over the last 7 days;
- **does the last 30 minutes predict the next?**: every settled window of the last 7 days against the one after it,
  as a scatter with the correlation and its 95% range. A round cloud means "right now" says nothing about the next
  half hour (that is what the first days of data show);
- **look up a situation**: pick a shown-chance band and a time into the session to see the last 7 days' return per
  1 (95% range clustered by player), win rate and wins against the shown chance. The monitor cannot see deposits,
  so a session here starts after 20 minutes without play; in the account's own history the boost follows every
  completed deposit, top-ups made while playing included;
- **does the pattern hold day by day?**: low chances in the first 5 minutes of a session and high chances at any
  time, against the shown chance, per day;
- the monitor's state and its recent events (problems are listed here too);
- totals for the range (30 minutes to 30 days, opening on the last hour), including the share of players who
  ended up in profit;
- **upgrades by time into the session**: wins against the shown chance per session phase and chance group, next to
  the usual value over 7 days;
- **one chart for upgrades and one for cases, per window** (1 minute to 1 day, depending on the range; against
  normal, against the shown odds, or return per 1), with each window's 95% range, a smoothed line, the range
  average, sample sizes, and the best and worst settled windows;
- a weekday × hour heat map (local time) over the last 7 days, whatever the range;
- upgrades by shown chance (against the shown odds and against normal), cases one by one, stake sizes;
- site activity from the site's public counters.

## What the data says about deposits (November 2026)

The full analysis of the account's own history is in [docs/FINDINGS.md](../docs/FINDINGS.md). What the monitor and a
second look at that history added, as of 2026-11-15:

**The boost restarts with every completed deposit, top-ups included.** The account's own upgrades (normal mode,
without mystery or super-drop upgrades), split by whether the player had played in the 20 minutes before the deposit:

| Deposit | Time after it | Upgrades | Under 15%: wins vs shown | 35% and up: wins vs shown | Return per 1 |
|---|---|---|---|---|---|
| Top-up (played in the 20 min before) | 0–5 min | 10,430 | 1.16 (z +4.8) | 0.91 | 0.93 |
| | 5–15 min | 3,626 | 1.09 | 0.78 | 0.82 |
| | 15–60 min | 1,582 | 0.90 | 0.82 | 0.74 |
| Fresh (no play in the 20 min before) | 0–5 min | 6,401 | 1.12 (z +2.9) | 0.83 | 0.97 |
| | 5–15 min | 2,831 | 1.02 | 0.86 | 0.85 |
| | 15–60 min | 844 | 0.80 | 0.68 | 0.75 |

The clock is the deposit, not a break in play: a top-up made while playing brings the boost back as strongly as a
deposit after a pause. It fades within about 15 minutes. **Return per 1 stays below 1 in every row, the first 5
minutes included**: the boost slows the losses, it does not turn them into gains.

**Other players show the same shape.** The monitor cannot see other players' deposits, so it starts a session after
20 minutes without play (which misses top-ups made while playing, so the real effect is likely a little sharper).
Over the 7 days to 2026-11-15, with the rows next to each player's discovery left out, wins against the shown
chance were:

| Time into session | Under 15% | 35% and up |
|---|---|---|
| First 5 minutes | 1.21 | 0.84 |
| 5–15 minutes | 0.94 | 0.79 |
| 15–60 minutes | 1.03 | 0.86 |
| After an hour | 0.93 | 0.78 |

High chances win less than shown in every phase; only low chances early in a session win more.

**There is no "good time" for the site as a whole.** Whether a 30-minute or 1-hour window went better or worse than
normal said nothing about the next one: the correlation between consecutive windows was +0.09 (30 minutes, 60
pairs) and −0.07 (1 hour, 49 pairs), and windows swung by 1.10 and 1.13 standard errors, where pure chance gives
1.00. That is only the first 1.5 days of data, enough to rule out a large effect, not a small one; the dashboard's
"Does the last 30 minutes predict the next?" section keeps checking.

What this adds up to: the only pattern found is tied to the player's own deposits, not to the time of day or to
how the site is treating everyone right now, and even at its best it loses money. That is what a mechanism made to
encourage the next deposit would look like. All of it is correlation in observed data, not knowledge of how the
site decides outcomes, and the site can change it at any time (the dashboard's day-by-day chart shows that first).

## How it samples

One request every 8 seconds (`PULSE_GAP_MS`), about 450 an hour. Each turn does the most urgent thing that is due:

1. On a clock: `GET /api/game/cases` every 6 hours (case prices), `GET /api/live-drops` every 30 to 90 s (finds
   active players; the feed shows big wins, so the sample leans towards big spenders), `GET /api/statistics` every
   60 s. The feed holds the last 20 drops worth about 3,500 or more and replaces 15 to 20 of them in 30 s (measured
   November 2026), so no interval catches every drop. Since the feed only finds players, its interval follows how
   many it brings: a read that adds 2 or more players to the look queue (new, or known and not looked at in the
   last 2 hours) sets 30 s; a read that adds none makes the next wait 1.5 times longer, up to 90 s
   (`FEED_MAX_SECONDS`). The requests saved go to revisits and history. The cost: a player who reaches the feed
   only once, during a long wait, can be missed, and a known player's return is seen up to a minute later.
2. Every other turn goes to the next kind of work in a fixed rotation, so each gets its share of the requests even
   when another always has work (a kind with nothing to do passes its turn on). Per 8 turns:
   - 2 × **first look**: a newly found player's latest page of upgrades and case drops
     (`/api/game/upgrade/public-history/{id}`, `/api/users/{id}/inventory/history`). The feed wins that found
     them are left out, or every player would start with a big win.
   - 2 × **follow**: one of the two lists of a followed player about every 90 s, for 2 hours after they were found.
   - 1 × **revisit a player playing now**, 1 × **any revisit that is due**: every player the feed has shown is
     remembered (up to 5,000, for 14 days after they were last seen) and checked again for new rows: every 10
     minutes while they played in the last 30 minutes (these come first), every 30 minutes if they played in the
     last 3 hours, every 2 hours within a day, every 6 hours within 3 days (`REVISIT_HOURS`), else every 24 hours
     (`REVISIT_STALE_HOURS`). When more checks are due than requests allow, the most overdue for their tier go
     first, so the backlog delays every tier alike. The dashboard shows how many known players are playing now.
     A player who is not playing now is checked through their counters first (`/api/users/{id}/stats`:
     `upgradesMade`, `casesOpened`): one request for both lists, and a list is read only when its counter moved.
     The first counter check of a player only records the counters. If a list later shows rows from before a
     check that said "no new play", the counters lag: the monitor reports it (`counters` event, `counterMisses`
     in the status), and `COUNTER_CHECKS=0` turns the counter checks off.
   - 2 × **history**: older pages of each known player's lists, back 7 days (`HISTORY_DAYS`), at most 10 pages
     each (`HISTORY_PAGES`). This is what fills the time before the monitor ran. Where each player's history
     stands is saved with the monitor's state, so a restart carries on instead of losing it.

Before 1.4 history came last, after following, and following 30 players took every free turn, so older pages
were hardly ever read (and their queue was capped and lost on restart). A state saved by an older version
reads the history of players who played in the last 7 days again.

Why revisits rather than the drop board alone: the board only shows drops worth about 3,500 or more, so players
who play small never appear there. The site has no way to ask whether a given player is online (it only
publishes the total online count), but a player's own history shows when they last played. So once the board has
shown a player, revisits keep them in the sample whenever they play, small or big. The board's live websocket
would catch every entry, but most entries are players already known, whose rows revisits read anyway.

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
- `monitor_derive`, `monitor_cal`, `monitor_derive_state`: the every-minute job that fills each row's session phase
  and discovery flag, and the 7-day normal rates it keeps; no one else can read or call them.
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
| `REVISIT_HOURS` | 6 | how often known players who last played 1 to 3 days ago are checked again |
| `REVISIT_STALE_HOURS` | 24 | how often known players who last played more than 3 days ago are checked again |
| `FEED_MAX_SECONDS` | 90 | longest drop feed interval while it brings no players to look at (30: always 30 s) |
| `COUNTER_CHECKS` | 1 | 0: check quiet players by reading both lists instead of their counters (2 requests instead of 1) |
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
