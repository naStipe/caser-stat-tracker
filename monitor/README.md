# Pulse monitor

Shows whether players on caser.gg get back more or less right now than a few hours ago. It samples other
players' recent upgrades and case drops, and serves its own dashboard page:

- for upgrades and for cases, return per 1 staked in the last hour against the 3 hours before, with a verdict
  ("Higher now", "Lower now", "No clear change", "Not enough data yet") from a significance test;
- an hourly chart of the last 12 hours with 95% ranges, and the two comparison windows as bands;
- an hourly table of the last 24 hours, with the site's own counters of upgrades and case opens per minute.

It stands alone: Node 20.6+ or Docker, no dependencies, no database. It is not part of the userscript in
the parent folder.

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
- A refused login, HTTP 403 or a challenge page stops the collector. The dashboard stays up with what was
  collected, and no more requests go to the site, so the restart policy does not retry in a loop.

Login: the site keeps a short-lived access token and a refresh token in the browser's `localStorage`. The monitor
needs only the refresh token and renews the access token itself (`POST /api/users/auth/refresh`), the way the
site's web app does. The site may hand out a new refresh token on each renewal; the monitor saves the latest one in
`data/state.json`, so restarts keep working.

## Run it

1. In a browser signed in to the account for the monitor, open caser.gg, press F12, and run
   `localStorage.getItem('refresh_token')` in the console. Copy the value without the quotes.
2. Stop using that login in the browser: close the tab without logging out, then clear caser.gg's site data in that
   browser (or do not open caser.gg there again). Logging out may end the token, and a browser renewing the same
   token may end the monitor's session.
3. Copy `.env.example` to `.env` and fill in `CASER_REFRESH_TOKEN` and `VIEW_PASSWORD`. Never commit `.env`.
4. Start it:
   - Docker: `docker compose up -d --build`, logs with `docker compose logs -f`.
   - Plain Node: `node --env-file=.env src/main.js`.
5. Open `http://<host>:8080/` and sign in with any user name and `VIEW_PASSWORD`. Without `VIEW_PASSWORD` the page
   listens on 127.0.0.1 only.

The dashboard uses HTTP Basic auth over plain HTTP. On a remote machine, put it behind HTTPS (a reverse proxy or
a tunnel) or reach it through an SSH tunnel, so the password does not cross the internet in the clear.

When the refresh token stops working, the log and the dashboard say the collector stopped: put a new token in `.env`
and restart. A changed `CASER_REFRESH_TOKEN` replaces the saved tokens.

## Settings

| Variable | Default | |
|---|---|---|
| `CASER_REFRESH_TOKEN` | | refresh token of the monitor's account |
| `VIEW_PASSWORD` | | dashboard password |
| `PORT` | 8080 | dashboard port |
| `HOST` | 0.0.0.0, or 127.0.0.1 without a password | listen address |
| `CASER_BASE` | https://caser.gg | site origin |
| `PULSE_GAP_MS` | 8000 | pause between requests, at least 2000 |
| `DATA_DIR` | ./data | state and collected rows |
| `USER_AGENT` | pulse-collector/… | request User-Agent |

Data: `DATA_DIR/state.json` (tokens, hash salt) and `DATA_DIR/rows/<day>.rows.jsonl` / `<day>.volume.jsonl`, one
JSON line per row, kept for 14 days. The last 26 hours are held in memory.

## Develop

```
npm test
```

Files: `src/parse.js` (history pages to rows), `src/collector.js` (what to read when), `src/stats.js` (return per 1,
ranges, comparison), `src/site.js` (login token and requests), `src/store.js` (rows on disk and in memory),
`src/server.js` (dashboard server), `src/main.js` (settings and wiring), `public/index.html` (dashboard page).
