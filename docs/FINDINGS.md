# Findings: caser.gg upgrades, odds and money flow

Data: the account's own history, read through the site's API on 2026-11-04.
15,846 upgrades (14,913 normal, 933 mystery), 17,517 inventory-history rows, 536 payments.
Period: 2026-09-19 to 2026-11-04 (46 days). Amounts are in the site's currency.

Method: for each upgrade the site records `probability`, the chance it showed. If the shown chance is honest,
wins over many upgrades should equal the sum of those probabilities. The gap is measured as
z = (wins − expected) / √(Σ p(1−p)). |z| above about 3 is very unlikely to be luck (p < 0.003).

## 1. How the site computes the shown chance

From the site's own client code and confirmed on all 14,913 normal upgrades:
shown chance = stake / target price × 1.03 (the ratio sits between 1.0295 and 1.0305 in 98% of rows).
So the shown odds always promise a 3% gain at site prices. Selling a skin pays the full listed price
(the sell-all preview equals the sum of item prices), so the edge is not in the sell price.

## 2. Real win rate differs from the shown chance

Normal upgrades without the super-drop card:

| Shown chance | Upgrades | Wins | Expected | Real rate | Shown rate | z | Return per 1 staked |
|---|---|---|---|---|---|---|---|
| 10–15% | 10,294 | 1,278 | 1,114.7 | 12.4% | 10.8% | +5.18 | 1.16 |
| 15–20% | 139 | 27 | 23.9 | 19.4% | 17.2% | +0.69 | 1.07 |
| 20–30% | 1,323 | 294 | 286.7 | 22.2% | 21.7% | +0.49 | 0.99 |
| 30–50% | 737 | 209 | 232.2 | 28.4% | 31.5% | −1.84 | 0.87 |
| 50–75% | 944 | 438 | 495.3 | 46.4% | 52.5% | −3.73 | 0.83 |
| 75–100% | 326 | 217 | 255.8 | 66.6% | 78.5% | −5.23 | 0.68 |

Low chances win more often than shown and high chances clearly less often. The real odds are compressed
toward the middle. Shown odds promise 1.03 everywhere; the realised return falls from 1.16 to 0.68 as the
chance rises.

## 3. Timing after deposits

Only 10–15% upgrades without super drop, so the chance mix cannot explain it:

| Time since last completed deposit | Upgrades | Wins | Expected | z |
|---|---|---|---|---|
| 0–5 min | 7,434 | 993 | 805.4 | +7.00 |
| 5–60 min | 2,549 | 260 | 275.7 | −1.00 |
| 60 min+ | 311 | 25 | 33.7 | −1.58 |

All chance levels, without super drop, by position after the latest deposit:

| Upgrade number after deposit | Upgrades | Wins | Expected | z |
|---|---|---|---|---|
| 1st | 473 | 74 | 64.6 | +1.34 |
| 2nd–5th | 1,877 | 297 | 250.7 | +3.28 |
| 6th–20th | 5,369 | 1,121 | 1,025.1 | +3.67 |
| 21st+ | 6,062 | 974 | 1,069.4 | −3.47 |

The super-drop card also appears more often right after a deposit (7.9% of upgrades in the first 5 minutes,
2.9–4.1% after an hour or more).

This is a correlation in one account's data, not proof of how the server decides outcomes. It is strong
(z = 7 survives any reasonable multiple-testing correction) and it holds within a single chance level.

## 4. Super drop

The golden card in the win zone multiplies a win by about 1.2–3x.
Shown on 1,132 of 14,913 normal upgrades (7.6%), hit 203 times (18% of shown, 1.4% of all).
Every hit is stored as a win, and the received item is the multiplied one.
When the card was shown, the win rate was 35.2% against 21.2% shown (z = +12.9). So the card's presence
is linked to the outcome. That is why the odds tests above leave these upgrades out.

## 5. Mystery upgrades (933)

The chance is hidden. An item is always received; "won" means it is worth at least the stake.
Hit rate 42.3%, overall return 0.964 (457,076 staked, 440,425 received).
By stake: under 100 → 0.96, 100–500 → 1.02, 500–1,000 → 0.96, 1,000–3,000 → 1.07, 3,000+ → 0.74 (only 24 upgrades).

## 6. Money flow

| | Count | Amount |
|---|---|---|
| Deposits completed | 475 | 139,467.60 |
| Deposits failed / expired | 61 | 18,558.94 |
| Skins withdrawn (site prices) | 20 | 101,588.36 |
| Still on the site (cash + skins) | | about 204.85 |
| **Net** | | **about −37,674** |

About 10 completed deposits per day over 46 days.

## 7. Strategy check (CSV export of 2026-11-04)

Source: `caser-tracker-2026-11-04.csv`, 14,996 settled normal upgrades. The CSV has no super-drop flag and no
deposit status, so these tables include super-drop upgrades and every deposit row. The direction matches sections 2-3.

Return per 1 staked by shown chance and time since the last deposit:

| Shown chance | 0-5 min after deposit | 5 min+ after deposit |
|---|---|---|
| 10-12% | 1.53 (n = 7,527, z = +10.3) | 1.10 (n = 3,476, z = +0.5) |
| 20-25% | 1.19 (n = 813, z = +2.7) | 1.08 (n = 625, z = −0.5) |
| 30-40% | 1.08 (n = 516) | 0.88 (n = 301) |
| 50-60% | 0.90 (n = 695, z = −2.4) | 0.78 (n = 360, z = −3.0) |
| 75-90% | 0.79 (n = 243, z = −3.4) | 0.63 (n = 137, z = −4.9) |

- The low-chance boost holds in each of weeks 4-7 (z between +4 and +7 per week). Outside the first 5 minutes,
  low chances win at the shown rate (10.8% real vs 10.8% shown for 10-15% after the 20th upgrade).
- The boost fades with the upgrade count after a deposit: 1-10th upgrade 1.68, 11-30th 1.50, 31st+ 1.27
  (10-15% chance, first 5 minutes).
- High chances (50%+) lose in every week and every window. They cost about −120,000 in total, more than the
  low chances made (+82,000). Big stakes are the same upgrades: stakes of 1,000+ returned 0.72.
- High chances while already 500+ ahead since the deposit returned 0.69 (n = 488, z = −4.9).
- 432 of 537 deposit cycles were ahead at some point. The peaks add up to +452,000; the cycles ended at −50,000.
  The first 20 upgrades of each cycle made +75,000, the rest lost −115,000.
- No usable effect: loss streaks, the previous result, the last 2-3 results (real/shown ratio 1.01-1.09 for every
  W/L pattern, the same as the overall boost), the number of items staked (1, 2, 3, 4+), the target type (gun,
  StatTrak, sticker/charm, knife, gloves) at the same chance, hour of day, repeating the same upgrade, fast mode.
  The next result cannot be predicted from the previous ones; only the shown chance and time since deposit matter.
- Raising the stake against the previous upgrade returned 0.81 (−112,000): that is moving up to high chances.
- Cases return 0.97-0.99 (Магнум 0.981 ± 0.018 over 10,050 opens). No case is above 1 beyond noise.
  Mystery upgrades return 0.964.

What the data supports, if the pattern stays: only low chances (about 10-25%), only in the first minutes and first
few dozen upgrades after a deposit, never high chances, and stop when that window ends. What it does not support:
any way to win without depositing. The boost is tied to deposits, which suggests a retention mechanism the site
controls and can change without notice. Item values are the site's prices, not market prices.

## Limits of this analysis

- One account. The pattern could differ for other accounts, and the site can change its logic at any time.
- Withdrawal times are approximate: the site only keeps when each withdrawn item arrived.
- Skin values are the site's own prices; real market prices for withdrawn skins may differ.
- Nothing here is a strategy. If the deposit-timing pattern is deliberate, its purpose is to keep deposits coming,
  and the overall result for this account is negative.
