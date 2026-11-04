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
  level from your history, EV, and a 100-try projection.
- Outlook on the overlay: "Likely profitable", "Likely losing" or "Unclear" for the selected upgrade, from your
  real win rate at that chance level and at this moment (0-5 min, 5-15 min or 15+ min after your last deposit),
  with how confident the estimate is.
- Suggested stake on the overlay: a half-Kelly stake size for the selected upgrade (a percent of your balance,
  and a money amount when the balance is known), or "skip this one" when the upgrade has no edge.

All data stays in your browser (IndexedDB on the site's origin). Nothing is sent anywhere.
The script only reads the site's API responses; it never changes requests or places bets.

## Install

1. Install the Tampermonkey extension for Chrome, Edge or Firefox.
2. Open the Tampermonkey dashboard, choose "Create a new script", delete the template,
   paste the full contents of `dist/caser-tracker.user.js`, and save.
3. Open caser.gg. A small "Tracker" button appears at the bottom-left.
4. Open the panel, go to Data, and press "Import my history from site". It loads past upgrades, case drops,
   withdrawals and deposits. The site rate-limits these requests, so a large history takes several minutes;
   keep the tab open. Running it again later only fetches what is new.

caser.gg and caser.one keep separate data (browser storage is per site). Use Export JSON on one and
Import file on the other to merge them.

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

Module boundaries and the event schema are in `docs/CONTRACT.md`.
