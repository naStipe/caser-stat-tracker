# Caser Stat Tracker

A Tampermonkey userscript for caser.gg and caser.one. It records your own case opens and upgrades
and shows:

- ROI per case, with a confidence interval, hit rate, best and median drop.
- Upgrade win rate per shown-chance bucket and per stake bucket, compared with the odds the site showed.
- Calibration: do your wins match the shown odds, with a significance test.
- Edge map: what the shown odds promise vs the return you actually got, per chance bucket and mode.
- Factors: hour, weekday, part of day, session position, loss streaks, mode, multiplier and more.
  Every factor carries a significance test with multiple-comparison correction, so random noise
  is labelled as noise.
- Odds: the real win rate at each shown-chance level against the shown odds, and how often the
  super-drop card appears and pays.
- Mystery upgrades: return, hit rate (item worth at least the stake), multiplier spread, results by stake.
- Money: deposits against withdrawals and holdings, over time and per day. Factors also include time
  since the last deposit and the upgrade number after a deposit.
- Upgrade overlay: for the upgrade you have selected, shows shown vs fair chance, the real chance at that
  level from your history, EV, and a 100-try projection. If the upgrade page lags, turn the card off with its ×
  button or in Stats, Data tab, Panels; it then does no work at all.
- Outlook on the overlay: "Likely profitable", "Likely losing" or "Unclear" for the selected upgrade, from your
  real win rate at that chance level and at this moment (0-5 min, 5-15 min or 15+ min after your last deposit),
  with how confident the estimate is.
- Case contents panel: on any case page, a panel on the right lists every item the case can drop with the
  site's price and its multiple of the case price, plus the cheapest and best drop. For custom (player-made)
  cases the site also publishes each item's chance, so the panel shows the chances and the expected value per
  open. Official cases publish prices only, so their EV cannot be shown.
- Suggested stake on the overlay: a half-Kelly stake size for the selected upgrade (a percent of your balance,
  and a money amount when the balance is known), or "skip this one" when the upgrade has no edge.

- Exchange panel: when you open "Change" (item replacement) on an inventory item, a panel on the left ranks the
  offered items by the money you receive selling them on CSFloat. "Typical" is the median of recent CSFloat sales
  (newest 20 of the last 30 days, or newest 10 of the last 90; sales under half or over 1.5x the median are
  dropped as sticker crafts or mistakes). "Fast sale" is the 25th percentile of the same sales, the price that
  sells quickly. Both are shown after CSFloat's 2% seller fee. With fewer than 3 such sales the panel falls back to
  CSFloat's base price (marked *). Each row has a sparkline of recent sales, sales in the last 30 days, the 14-day
  price trend and the gain or loss against your current item. Click a row (or your item's box) for a chart of every
  recent sale with its date, price and float, plus the typical, fast-sale and CSFloat base prices, the active
  listings and a link to the CSFloat listings. Clicking a row also selects that item in the site's list; you still
  confirm on the site. Only the 50 items the site offers are ranked. Float and stickers change a real item's price,
  so check the listing.

- Pulse tab (optional, off by default): how much players across the site get back right now, compared with a few
  hours ago. A collector, switched on in the Pulse tab of one browser, finds active players in the live-drop feed and
  reads their recent upgrades and case drops through the site's profile endpoints, then follows them for up to two
  hours. The tab shows return per 1 staked for the last hour against the 3 hours before (with a significance test),
  an hourly chart with 95% ranges, and the site's own counters of case opens and upgrades per minute. The feed wins
  that brought a player in are left out. Players are stored only as a salted hash. The collector sends about one
  request every 4 seconds with the signed-in account's login, so run it only on an account you can lose: the site can
  see it and may limit or ban that account. It pauses on HTTP 429 and stops on 401/403. With cloud sync on, its rows go
  to the cloud and every browser with the same sync key shows them.

All data stays in your browser (IndexedDB on the site's origin, plus Tampermonkey's own script storage). The only outside request is to CSFloat's
public sales history, and it sends only item names (no cookies, nothing about you). Prices are cached for 6 hours.
The script only reads the site's API responses; it never changes requests or places bets.

## Install

1. Install the Tampermonkey extension for Chrome, Edge or Firefox.
2. Open https://raw.githubusercontent.com/naStipe/caser-stat-tracker/main/dist/caser-tracker.user.js
   and press "Install" on the page Tampermonkey shows.
3. Open caser.gg. A small "Tracker" button appears at the bottom-left.
4. Open the panel, go to Data, and press "Import my history from site". It loads past upgrades, case drops,
   withdrawals and deposits. The site rate-limits these requests, so a large history takes several minutes;
   keep the tab open. Running it again later only fetches what is new.

caser.gg and caser.one share one history (same account). Each domain keeps its own IndexedDB copy, and
the script also keeps every event in Tampermonkey's script storage, which both domains can read. Opening
either domain pulls in what the other recorded and pushes its own events out, so the first visit to a
domain with old data copies that data over. Open tabs on both domains also pick up each other's new events.
"Clear all data" clears both. Export JSON / Import file still works as a manual fallback.

### Updates

The script header has `@updateURL` / `@downloadURL` pointing at the raw file above. Tampermonkey checks it
(once a day by default, or right away with "Check for userscript updates") and installs any build with a higher
`@version`. The panel title shows the running version; Data → Updates checks right away (the tracker also
checks every 6 hours) and "Install" opens Tampermonkey's update page. To ship a change: bump `version` in `package.json`, run `npm run build`, commit `dist/`, push to `main`.

### Several site accounts

Every event keeps the id of the site account that made it. The panel always opens on the signed-in account (also after
logging into another one); once a second account has events, a picker under the title switches to another
account or to all of them until the next page load. When the site does not report who is signed in, the
tracker asks `/api/users/me` itself, once per login token.
Site sync, its "read to the end" flags and the 15-minute auto-sync run per account. Export and "Clear all" cover
every account. Events recorded before 0.9.0 without an account id count for the account with the most events.

### Owner lock

By default the tracker is in guest view: it shows only the signed-in account, exports only that account, and hides
"Clear all" and cloud sync (the sync key opens every account). Enter the owner password in Data → Owner lock (or the
"Unlock" button under the title) to see every account. It locks again on page reload or when another account signs
in, unless "Stay unlocked while … is signed in" is ticked; "Lock now" undoes that for the signed-in account. The
password is built in and stored only as a salted PBKDF2 hash (`OWNER_LOCK` in `src/store/lock.js`). The lock only
hides data in the tracker's panels: the events are not encrypted, and anyone with the browser's developer tools can
still read them.

## Develop

```bash
npm install
npm test          # unit tests for parsers, store helpers and stats
npm run build     # writes dist/caser-tracker.user.js
```

Previews (serve the project root, for example with the `preview` entry in `.claude/launch.json`):

- `docs/ui-preview.html`: UI with stub stats.
- `docs/integration.html`: real UI + real stats on generated data.
- `docs/smoke.html`: the built userscript against a fake site API.
- `docs/smoke-accounts.html`: the built userscript tags live events with the signed-in account, also after a login switch.
- `docs/exchange-smoke.html`: the exchange panel against a fake replacement modal and fake CSFloat prices.

Module boundaries and the event schema are in `docs/CONTRACT.md`.
