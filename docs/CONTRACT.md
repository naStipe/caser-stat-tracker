# Module contract

This file is the single source of truth for how the modules talk to each other.
Every module codes against it. Change it here first, then in code.

The product is one Tampermonkey userscript (`dist/caser-tracker.user.js`) built by esbuild
from `src/main.js`. It runs on `caser.gg` and `caser.one`, records case opens and upgrades,
stores them in IndexedDB, and shows a dashboard plus an upgrade overlay on the page.

```
src/
  schema.js          Event typedefs + small helpers (this contract in code)
  capture/           fetch hook, response parsers, history import       (owner: orchestrator)
  store/             IndexedDB wrapper, dedupe, export/import           (owner: orchestrator)
  stats/             pure statistics functions, no DOM, no IndexedDB    (owner: stats agent)
  ui/                dashboard panel + upgrade overlay, Shadow DOM      (owner: UI agent)
  main.js            wiring                                             (owner: orchestrator)
test/                node:test unit tests (`npm test`)
```

Rules for every module:

- Plain modern JavaScript (ES2022, ES modules). No TypeScript, no frameworks, no runtime dependencies.
- `stats/` must be pure: input arrays in, plain objects out. It must run in Node for tests.
- Money values are plain numbers in site currency (the site sends strings like `"79.000"`; capture converts them).
- Percent values are 0-100, not 0-1.
- Timestamps are milliseconds since epoch (`ts`).

## Site facts (from the site's own JS bundles, 2026-11-04)

- API base: `https://<site>/api`. The site's API client calls the global `fetch` at request time.
- Case open: `POST /api/game/cases/{slug}/open` with `{count, gameMode}`. Response has `items[]` (each with `price`) and `case_stats`.
- Case details: `GET /api/game/cases/{slug}`. Case list: `GET /api/game/cases` → `{cases:[{id,slug,title,price,type,...}]}`.
- Custom case details: `GET /api/game/custom-cases/{slug}` → `{id,slug,title,price,items:[{item:{...},chancePercent}]}`. Official case details carry no chances. Both kinds use the page URL `/{locale}/cases/{slug}`; the site tries the official endpoint first and falls back on 404. Read by `src/capture/caseinfo.js` for the case contents panel.
- Upgrade: `POST /api/game/upgrade/bet` with `{betInventoryItemIds[], addedBalance, isMystery, gameMode, targetItemId?}`.
  Response has `bet` with `status: "won" | "lost" | "pending"`, `targetItem`, plus `superDrop {shown, won, item}` and `compensationItems[]`.
- Shown upgrade chance (client code): `min(max(stake / targetPrice * 103, 0), 100)` percent.
  So the shown chance is 1.03 × the fair chance at site prices. The house edge must then sit in item prices.
- Own history: `GET /api/game/upgrade/public-history/{userId}?limit&offset` and `GET /api/users/{userId}/inventory/history?limit&offset`.
- Current user: `GET /api/users/me`. Balance: `GET /api/items/inventory/balance`.
- No provably-fair seeds (server seed / client seed / nonce) appear anywhere in the client code.

## Event schema

Two event kinds are stored. One case event per dropped item (a 5x open makes 5 events sharing a `batchId`).

```js
/** @typedef {{id:string|null, name:string, price:number, rarity:string|null, image:string|null}} Item */

/** Common fields */
{
  id: string,            // unique key. Server id when known, else a deterministic hash.
  kind: 'case' | 'upgrade',
  ts: number,            // ms epoch. Server Date header when known, else Date.now().
  site: string,          // 'caser.gg' | 'caser.one'
  userId: string | null,
  source: 'live' | 'import',
  balanceBefore: number | null,
  balanceAfter: number | null,
}

/** kind: 'case' */
{
  caseSlug: string,
  caseId: string | null,
  caseName: string,
  casePrice: number,     // cost of ONE open. 0 for free opens.
  free: boolean,
  batchId: string,       // same for all items of one open request
  batchSize: number,     // count sent in the request
  gameMode: string,      // e.g. 'normal', 'fast'
  item: Item,            // the drop
}

/** kind: 'upgrade' */
{
  stake: number,         // sum(betItems.price) + addedBalance
  betItems: Item[],
  addedBalance: number,
  target: Item | null,   // null for mystery upgrades until the result is known
  mystery: boolean,
  gameMode: string,
  chanceShown: number,   // percent the site showed. Server value if the response has one, else min(stake/target.price*103, 100).
  chanceServer: number | null, // percent from the response, if present
  status: 'won' | 'lost' | 'pending',
  won: boolean,
  superDrop: { shown: boolean, won: boolean, item: Item | null } | null,
  compensation: Item[],  // items given back on a loss, if any
  returned: number,      // value received: target.price if won, + superDrop item if won, + compensation
  net: number,           // returned - stake
}
```

Derived values that stats code computes itself (never stored):
`chanceFair = stake / target.price * 100`, `multiplier = target.price / stake`, `hour`, `weekday`, session fields.

## stats API (`src/stats/index.js`)

All functions take `events` (mixed kinds, any order) and ignore events of the other kind.
Upgrades with `status === 'pending'` are ignored by every stat.

Shared metric block, returned for every group row:

```js
/** @typedef {Object} Metrics
 * n            number of events
 * cost         total spent (casePrice or stake)
 * returned     total value received
 * net          returned - cost
 * roi          net / cost (fraction, e.g. -0.12), null when cost = 0
 * roiCI        [lo, hi] 95% interval for roi (normal approximation on per-event return ratio), null when n < 2
 * // upgrade-only:
 * wins, winRate, winRateCI ([lo,hi] Wilson 95%), expectedRate (mean chanceShown/100),
 * z, p          two-sided test of wins vs sum of per-event chanceShown (Poisson-binomial normal approx)
 * significant  boolean, p below alpha after Holm correction across the rows of the same table
 */
```

Functions:

```js
summarize(events) -> { cases: Metrics, upgrades: Metrics, total: Metrics, firstTs, lastTs }

caseRoi(events) -> Array<Metrics & { caseSlug, caseName, casePrice, best: Item|null, median: number, hitRate: number }>
  // one row per caseSlug. hitRate = share of drops with item.price >= casePrice. Sorted by n desc.

upgradeByChance(events, edges = [0, 2, 5, 10, 20, 30, 50, 75, 100]) -> Array<Metrics & { label, lo, hi }>
  // buckets on chanceShown, [lo, hi) except the last which includes hi.

upgradeByStake(events, edges = [0, 100, 500, 1000, 5000, 20000, Infinity]) -> Array<Metrics & { label, lo, hi }>
  // buckets on stake.

factor(events, key, opts?) -> { key, rows: Array<Metrics & { value, label }>, test: { statistic, df, p, significant } }
  // key one of:
  //  'hour' (0-23 local), 'weekday' (0-6, Monday = 0), 'daypart' (night/morning/afternoon/evening),
  //  'sessionPosition' (1st-5th, 6th-20th, 21st+ event in session), 'sessionMinute' (0-15, 15-60, 60+),
  //  'afterLossStreak' (0, 1, 2, 3-4, 5+ losses before this upgrade), 'afterWin' (prev upgrade won / lost / none),
  //  'mode' (normal / mystery), 'gameMode', 'site', 'free' (cases), 'itemCount' (bet items 1..6),
  //  'addedBalance' (none / some), 'balanceBand' (balanceBefore buckets), 'multiplier' (x1.1-2, 2-5, 5-10, 10+)
  // opts.kind 'case' | 'upgrade' | undefined (both). For upgrades the test is a chi-square of
  // observed vs expected wins across rows; for cases a Kruskal-Wallis style test on return ratio is fine,
  // a simpler one-way comparison is acceptable if documented.

sessions(events, gapMinutes = 30) -> Array<{ start, end, n, cost, returned, net, kinds: {case, upgrade} }>
  // a new session starts when the gap between consecutive events exceeds gapMinutes.

calibration(events) -> { n, wins, expectedWins, z, p, verdict: 'consistent' | 'below' | 'above', impliedRtp }
  // impliedRtp = returned / cost over all upgrades.

edgeMap(events, edges = same as upgradeByChance) -> Array<{ label, lo, hi, n, shownRtp, realRtp, realRtpCI, mode }>
  // shownRtp = mean(chanceShown/100 * target.price / stake): what the shown odds promise (about 1.03).
  // realRtp = returned / cost. Rows per bucket and per mode (normal / mystery).

upgradeQuote({ stake, targetPrice, chanceShown? }, events) -> {
  chanceShown, chanceFair, multiplier,
  ev, evPct,                     // ev = chanceShown/100 * targetPrice - stake; evPct = ev / stake
  realEdge,                      // from history in the same chance bucket: realRtp - 1, null if n < 30
  similar: { n, wins, winRate, winRateCI },  // history in the same chance bucket AND stake bucket
  longRun: { tries: 100, mean, p05, p95, probProfit }  // 100 identical upgrades, exact binomial
}

helpers exported too: wilson(k, n, z=1.96), normalCdf(x), holm(pValues, alpha=0.05) -> boolean[]
```

## v2 additions (2026-11-04, from the user's real history)

Facts learned from 15,846 real upgrades, 17,517 inventory-history rows and 536 payments:

- Upgrade history rows: `{id, status, betItems[], addedBalance, probability ("0.0490" fraction), targetItem, wonItem,
  isMystery, mysteryMultiplier, superDrop {shown, won, item}, multiplier, createdAt, category}`.
  The page also has `featured[]` (best upgrades) next to `items[]`; both are imported.
- `wonItem` is what the user actually received:
  - normal win: the target; super-drop win: a pricier item (the golden card multiplies the win by ~1.2-3x), status is "won";
  - mystery upgrade: the user ALWAYS receives `wonItem`. "won" means `mysteryMultiplier >= 1`, "lost" means < 1.
    `probability` is "0" for mystery (the chance is hidden).
  So `returned` = `wonItem.price` when `wonItem` exists, else 0 (+ compensation). Never add the super-drop item on top.
- Upgrades where the super-drop card was shown win far more often than `probability` (35% vs 21%), so the shown-odds
  tests must exclude them by default and report them separately.
- Deposits: `GET /api/payments/history?limit&offset` → `{items:[{id, methodName, amount, status: completed|failed|expired, createdAt, completedAt}], hasMore}`.
- Withdrawals: no history endpoint. Inventory history rows with `status: "withdrawn"` give the item and value, but their
  `createdAt` is when the item arrived, not when it was withdrawn. Live capture of `POST /api/withdrawals` gives the exact time.
  The live event keys on the inventory item id and the imported one on the history row id, so one withdrawal can arrive
  twice under two ids. `withdrawalTwinIds` pairs them by item name (import arrived at most 7 days before the live
  capture); the import skips the imported copy and stored copies are deleted at startup.
- `GET /api/items/inventory/balance` → `{amount}` is the value of skins held, not the cash balance. Cash balance is `/users/me` `balance`.
- Item replacement: `GET /api/inventory/items/{inventoryId}/replacements?limit=50&offset=0` →
  `{success, data: [{id, item: {id, marketName, price, image, ...}, price, refund}]}`; the modal shows only these 50.
  `POST /api/inventory/items/{inventoryId}/replace {itemId}` swaps and credits `refund` to the balance (the tracker never sends it).
  Modal DOM: `[data-testid="replace-item-modal"]`, cards `[data-testid="replace-item-modal-candidate-{id}"]`.
- CSFloat: `GET https://csfloat.com/api/v1/history/{market_hash_name}/sales` is public (no login, no CORS, so it goes
  through `GM_xmlhttpRequest`). Newest ~40 sales, prices in US cents, each with `sold_at`, `item.float_value` and `reference: {base_price, predicted_price, float_factor, quantity}`
  (`quantity` = active listings). `/api/v1/listings` needs a login and is not used.

### Event schema additions

```js
/** kind: 'upgrade' — new fields */
{
  mysteryMultiplier: number | null, // mystery only: wonItem.price / stake as the site reports it
  // chanceShown is null for mystery upgrades (hidden chance). chanceServer is null too.
}

/** kind: 'deposit' */
{ amount: number, method: string, status: 'completed' | 'failed' | 'expired' | string, completedTs: number | null }
  // ts = createdAt. Only 'completed' deposits count as money in.

/** kind: 'withdrawal' */
{ item: Item, value: number, exactTime: boolean }
  // exactTime false for imported rows (ts is when the item arrived); true for live POST /withdrawals captures.
```

All existing stats must keep ignoring kinds they do not know (deposit, withdrawal).

### stats v2 (`src/stats/`)

General rule change: every win-vs-shown-odds test (`calibration`, `upgradeByChance`, `upgradeByStake`, `factor`, `edgeMap`,
`upgradeQuote.similar`) uses NORMAL upgrades only (mystery excluded, they have no chance) and by default EXCLUDES upgrades with
`superDrop.shown === true`. Accept `opts.includeSuperDrop` to turn that off. Money metrics (cost/returned/roi) may include them.

```js
calibrationCurve(events, edges = [0, 10, 15, 20, 30, 50, 75, 100])
  -> Array<{ label, lo, hi, n, wins, expectedRate, winRate, winRateCI, z, p, significant, realRtp }>
  // The key chart: shown chance vs real win rate per bucket (Holm across rows).

superDropStats(events) -> {
  n, shownN, shownRate,                      // how often the card appears
  shown: { n, wins, winRate, expectedRate, z, p, rtp },     // upgrades with the card shown
  notShown: { n, wins, winRate, expectedRate, z, p, rtp },
  hits: { n, avgMultiplier, minMultiplier, maxMultiplier }  // super-drop wins: wonItem.price / target.price
}

mysteryStats(events, stakeEdges = [0, 100, 500, 1000, 3000, Infinity]) -> {
  ...Metrics (n, cost, returned, net, roi, roiCI),
  hitRate, hitRateCI,                        // share with multiplier >= 1
  meanMultiplier, medianMultiplier,
  histogram: Array<{ label, lo, hi, n }>,    // multiplier bins [0,0.25,0.5,0.75,1,1.25,1.5,2,3,Infinity)
  byStake: Array<Metrics & { label, lo, hi, hitRate, meanMultiplier }>,
  test: { method, statistic, df, p }         // does mean multiplier differ by stake bucket (ANOVA on per-event multiplier)
}

moneyFlow(events, { balance = null, inventoryValue = null } = {}) -> {
  deposits: { n, sum, failedN, failedSum, firstTs, lastTs, perDay },   // completed only in n/sum
  withdrawals: { n, value, exactTimeN },
  holdings: balance + inventoryValue (null if both unknown),
  net: withdrawals.value + (holdings ?? 0) - deposits.sum,
  series: Array<{ ts, kind: 'deposit' | 'withdrawal', amount, cumulativeNet }>,  // ordered by ts
  daily: Array<{ day: 'YYYY-MM-DD', deposited, withdrawn }>
}

factor keys added:
  'sinceDeposit'      0-5m, 5-15m, 15-60m, 1-6h, 6h+, no deposit yet   (time since the latest completed deposit)
  'afterDepositOrder' 1st, 2nd-5th, 6th-20th, 21st+ upgrade since the latest completed deposit
  'sinceWithdrawal'   <1h, 1-24h, 24h+ / none                          (uses withdrawal ts as given)
  'superDrop'         shown / not shown (this key ignores the default super-drop exclusion)

factor rows gain an ADJUSTED test, because real odds differ from shown odds by chance level (low chances win more than
shown, high chances less), and a row that simply holds more low-chance bets would look "lucky":
  zAdj, pAdj, significantAdj (Holm)  — expected wins per event = the real win rate of that event's calibrationCurve bucket
  (computed on all events in scope), instead of chanceShown. test gains { statisticAdj, pAdj }.
```

### UI v2

- New tab "Odds": calibration curve chart (x = shown chance bucket, y = real win rate with CI whiskers, diagonal = shown odds),
  table from calibrationCurve, and the super-drop card from superDropStats. This is the headline finding; put it second after Overview.
- New tab "Mystery": mysteryStats (RTP with CI, hit rate, multiplier histogram bars, by-stake table, test note).
- New tab "Money": moneyFlow (deposited, withdrawn, holdings, net; cumulative net line with deposit and withdrawal marks;
  daily table). Note under withdrawals when exactTime is false: "Withdrawal times are approximate for imported items."
  The dashboard receives `getHoldings: () => ({ balance, inventoryValue })` in opts for this tab.
- Factors: add the new keys; show both "vs shown odds" and "adjusted for the real odds curve" (zAdj) columns and use the
  adjusted test for the plain-language note when available.
- Overlay: when calibrationCurve has ≥ 100 events in the selection's bucket, show "Real chance at this level: X% (n = N)"
  and base the verdict on it.

## UI API (`src/ui/index.js`)

```js
mountDashboard({
  getEvents: () => Promise<Event[]>,
  stats,                          // the stats module namespace
  currency: () => string,         // label to show next to money, e.g. '₽'
  onExport: (format: 'json' | 'csv') => void,
  onImportFile: (file: File) => Promise<{ added: number }>,
  onImportHistory: () => Promise<{ added: number }>,   // pulls the user's own history from the site API
  onClear: () => Promise<void>,
  getStatus: () => { capturing: boolean, lastEventTs: number|null, unknownResponses: number, version: string },
}) -> { refresh(): void, destroy(): void }

mountUpgradeOverlay({
  getSelection: () => { stake: number, targetPrice: number, chanceShown: number|null } | null,
  getEvents: () => Promise<Event[]>,
  stats,
  currency: () => string,
}) -> { refresh(): void, destroy(): void }
```

UI rules: everything inside one Shadow DOM root so site CSS cannot leak in or out.
Flat solid backgrounds, no gradients, no glow, no grid or dot patterns. Short subtle fades only.
Charts are hand-written inline SVG. Respect `prefers-reduced-motion`.

### upgradeOutlook (2026-11-04)

```js
upgradeOutlook({ stake, targetPrice, chanceShown? }, events, { now? }) -> null | {
  chanceShown, band,             // band: '0-15%' | '15-30%' | '30-50%' | '50-75%' | '75-100%'
  window: { key: 'hot' | 'warm' | 'cold', label },   // 0-5 min / 5-15 min / 15+ min (or none) since last completed deposit
  context: { minutesSinceDeposit, upgradesSinceDeposit, netSinceDeposit },   // null when no deposit before now
  ratio,                         // posterior mean of real/shown win rate for this band and window
  realChance, ev, evPct,         // realChance = min(1, chanceShown/100 * ratio); ev = realChance * targetPrice - stake
  breakEvenRatio,                // ratio above which ev > 0 (stake / (shown * targetPrice), about 0.971)
  probProfitable,                // posterior P(ratio > breakEvenRatio); null when the band has < 30 upgrades
  verdict: 'likely-profit' | 'likely-loss' | 'unclear' | 'unknown',   // P >= 0.8 / P <= 0.2 / between / no data
  kelly: { full, half } | null,  // stake as a fraction of bankroll (half-Kelly is the one shown); null when band < 30
  cell, bandStats,               // { n, wins, expected, variance }
  windows: [{ key, label, n, ratio, realChance }],   // same band, every window
}
```

Model: per band and window, wins vs expected wins (sum of shown chances). The band ratio is shrunk toward 1 and
each cell toward its band with a prior worth 20 expected wins. The posterior is Gamma, with both parameters scaled
by expected / Σp(1-p) so high chances are not given Poisson-sized noise. Deposit time = `completedTs`, else `ts`.
Super-drop-shown upgrades are left out of history; EV ignores super-drop bonuses.
