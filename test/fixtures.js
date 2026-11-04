// Seeded synthetic events (schema-exact) and small builders for hand-written tests.
import { shownChance } from '../src/schema.js';

/** Small deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (x) => Math.round(x * 100) / 100;
const MINUTE = 60000;

const CASES = [
  { slug: 'starter', name: 'Starter', price: 10 },
  { slug: 'classic', name: 'Classic', price: 50 },
  { slug: 'premium', name: 'Premium', price: 250 },
  { slug: 'elite', name: 'Elite', price: 1000 },
  { slug: 'legend', name: 'Legend', price: 5000 },
];

// Drop value as a multiple of case price: [probability, multiplier]. Mean about 0.84.
const DROP_TABLE = [[0.6, 0.3], [0.25, 0.8], [0.1, 1.5], [0.04, 4], [0.01, 15]];

function item(id, name, price) {
  return { id, name, price: cents(price), rarity: null, image: null };
}

/** Item with a price and generated name; handy in hand-written tests. */
export function makeItem(price, name = `Item ${price}`) {
  return item(`item-${price}`, name, price);
}

let builderSeq = 0;

/** Build one case event. `drop` is the dropped item price, `price` the case price. */
export function caseEvent({ ts = 0, caseSlug = 'starter', caseName, price = 10, drop = 5, free = false, ...rest } = {}) {
  const id = `c-${++builderSeq}`;
  return {
    id,
    kind: 'case',
    ts,
    site: 'caser.gg',
    userId: 'u1',
    source: 'live',
    balanceBefore: null,
    balanceAfter: null,
    caseSlug,
    caseId: null,
    caseName: caseName ?? caseSlug,
    casePrice: free ? 0 : price,
    free,
    batchId: id,
    batchSize: 1,
    gameMode: 'normal',
    item: makeItem(drop),
    ...rest,
  };
}

/**
 * Build one upgrade event. chanceShown defaults to the site formula; status/returned/net follow `won`.
 * Pass status: 'pending' to build a pending upgrade.
 */
export function upgradeEvent({ ts = 0, stake = 100, targetPrice = 200, chanceShown, won = false, mystery = false, ...rest } = {}) {
  const status = rest.status ?? (won ? 'won' : 'lost');
  const isWon = status === 'won';
  const returned = isWon ? targetPrice : 0;
  const id = `u-${++builderSeq}`;
  return {
    id,
    kind: 'upgrade',
    ts,
    site: 'caser.gg',
    userId: 'u1',
    source: 'live',
    balanceBefore: null,
    balanceAfter: null,
    stake,
    betItems: [makeItem(stake)],
    addedBalance: 0,
    target: makeItem(targetPrice),
    mystery,
    gameMode: 'normal',
    chanceShown: chanceShown !== undefined ? chanceShown : mystery ? null : shownChance(stake, targetPrice),
    chanceServer: null,
    mysteryMultiplier: mystery ? returned / stake : null,
    won: isWon,
    superDrop: null,
    compensation: [],
    returned,
    net: returned - stake,
    ...rest,
    status,
  };
}

function pickDrop(rand) {
  let r = rand();
  for (const [p, m] of DROP_TABLE) {
    if (r < p) return m;
    r -= p;
  }
  return DROP_TABLE[0][1];
}

function makeCaseEvents(rand, count, ts, tag, seq, balance) {
  const c = CASES[Math.floor(rand() * rand() * CASES.length)]; // cheap cases are more popular
  const size = rand() < 0.7 ? 1 : 5;
  const batchId = `batch-${tag}-${seq}`;
  const out = [];
  for (let i = 0; i < Math.min(size, count); i++) {
    const drop = item(`d-${tag}-${seq}-${i}`, `${c.name} drop`, c.price * pickDrop(rand) * (0.8 + rand() * 0.4));
    const before = balance.value;
    balance.value = cents(balance.value - c.price + drop.price);
    out.push({
      id: `case-${tag}-${seq}-${i}`, kind: 'case', ts, site: 'caser.gg', userId: 'u1', source: 'live',
      balanceBefore: before, balanceAfter: balance.value,
      caseSlug: c.slug, caseId: `id-${c.slug}`, caseName: c.name, casePrice: c.price, free: false,
      batchId, batchSize: size, gameMode: 'normal', item: drop,
    });
  }
  return out;
}

const PIVOT = 0.3;

// Standard normal draw (Box-Muller) from two uniforms.
function normal(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

// Hidden win probability for a shown chance (as a fraction): compress pulls it towards PIVOT
// (low chances win more than shown, high chances less), edge scales the result.
function hiddenWinProb(shown, cfg) {
  return (shown + cfg.compress * (PIVOT - shown)) * cfg.edge;
}

function mysteryOutcome(rand, stake) {
  const multiplier = cents(Math.exp(-0.35 + 0.8 * normal(rand)));
  const returned = cents(stake * multiplier);
  return { multiplier, returned };
}

function makeUpgradeEvent(rand, ts, tag, seq, cfg, balance) {
  const chance = Math.exp(Math.log(1.2) + rand() * (Math.log(89) - Math.log(1.2))); // log-uniform 1.2..89
  const stake = cents(Math.exp(Math.log(10) + rand() * (Math.log(5000) - Math.log(10))));
  const targetPrice = cents((stake * 103) / chance);
  const shown = cents(shownChance(stake, targetPrice));
  const parts = rand() < 0.7 ? 1 : rand() < 0.5 ? 2 : 3;
  const added = rand() < 0.2 ? cents(stake * 0.3) : 0;
  const itemTotal = cents(stake - added);
  const betItems = Array.from({ length: parts }, (_, i) => item(`b-${tag}-${seq}-${i}`, 'Bet item', itemTotal / parts));
  const realStake = cents(betItems.reduce((s, it) => s + it.price, 0) + added);
  const cardShown = cfg.superDropRate > 0 && rand() < cfg.superDropRate;
  let p = hiddenWinProb(shown / 100, cfg);
  if (cardShown) p = Math.min(1, p * cfg.superBoost);
  let won = rand() < p;
  const mystery = rand() < cfg.mysteryRate;
  const gameMode = rand() < 0.85 ? 'normal' : 'fast';
  let returned = won ? targetPrice : 0;
  let target = item(`t-${tag}-${seq}`, 'Target', targetPrice);
  let superDrop = null;
  let mysteryMultiplier = null;
  if (mystery) {
    const out = mysteryOutcome(rand, realStake);
    mysteryMultiplier = out.multiplier;
    returned = out.returned;
    won = out.multiplier >= 1;
    target = item(`t-${tag}-${seq}`, 'Mystery prize', out.returned);
  } else if (cardShown) {
    const hit = won && rand() < 0.5;
    if (hit) returned = cents(targetPrice * (1.2 + rand() * 1.8));
    superDrop = { shown: true, won: hit, item: hit ? item(`sd-${tag}-${seq}`, 'Super drop', returned) : null };
  }
  const before = balance.value;
  balance.value = cents(balance.value - realStake + returned);
  return {
    id: `upgrade-${tag}-${seq}`, kind: 'upgrade', ts, site: 'caser.gg', userId: 'u1', source: 'live',
    balanceBefore: before, balanceAfter: balance.value,
    stake: realStake, betItems, addedBalance: added, target,
    mystery, gameMode,
    chanceShown: mystery ? null : shown, chanceServer: null, status: won ? 'won' : 'lost', won,
    superDrop, compensation: [], returned, net: returned - realStake, mysteryMultiplier,
  };
}

function makeDeposit(rand, tag, i, ts) {
  const amount = [500, 1000, 2000, 5000][Math.floor(rand() * 4)];
  const status = rand() < 0.85 ? 'completed' : rand() < 0.5 ? 'failed' : 'expired';
  return {
    id: `deposit-${tag}-${i}`, kind: 'deposit', ts, site: 'caser.gg', userId: 'u1', source: 'import',
    balanceBefore: null, balanceAfter: null,
    amount, method: 'card', status, completedTs: status === 'completed' ? ts + MINUTE : null,
  };
}

function makeWithdrawal(rand, tag, i, ts) {
  const price = cents(50 + rand() * 2000);
  return {
    id: `withdrawal-${tag}-${i}`, kind: 'withdrawal', ts, site: 'caser.gg', userId: 'u1', source: 'import',
    balanceBefore: null, balanceAfter: null,
    item: item(`w-${tag}-${i}`, 'Withdrawn item', price), value: price, exactTime: rand() < 0.5,
  };
}

/**
 * Generate a realistic event history, sorted by ts.
 * @param {{seed?:number, days?:number, cases?:number, upgrades?:number, edge?:number, start?:number,
 *   mysteryRate?:number, superDropRate?:number, superBoost?:number, compress?:number,
 *   deposits?:number, withdrawals?:number}} [o]
 *   cases: number of case drop events, upgrades: number of upgrade events (mystery ones included),
 *   edge: hidden multiplier on the win probability (0.92 = house edge, 1 = fair),
 *   compress: 0..1 pulls the hidden win probability towards 30% (0 = none; 0.3 = low chances win much
 *   more than shown, high chances less), mysteryRate: share of mystery upgrades (chanceShown null),
 *   superDropRate: share of normal upgrades showing the super-drop card (win probability x superBoost),
 *   deposits / withdrawals: number of such events spread over the period (drawn from a separate PRNG).
 */
export function generateEvents({
  seed = 1, days = 30, cases = 600, upgrades = 400, edge = 0.92, start = new Date(2026, 0, 1, 0).getTime(),
  mysteryRate = 0, superDropRate = 0, superBoost = 1.7, compress = 0, deposits = 0, withdrawals = 0,
} = {}) {
  const cfg = { edge, compress, mysteryRate, superDropRate, superBoost };
  const rand = mulberry32(seed);
  const tag = `s${seed}`;
  const balance = { value: 20000 };
  const events = [];
  let caseLeft = cases;
  let upLeft = upgrades;
  const sessionCount = Math.max(1, Math.ceil((cases + upgrades) / 15));
  const slot = (days * 24 * 60 * MINUTE) / sessionCount;
  let seq = 0;
  for (let s = 0; s < sessionCount && caseLeft + upLeft > 0; s++) {
    let ts = start + s * slot + rand() * slot * 0.5;
    const target = s === sessionCount - 1 ? caseLeft + upLeft : Math.min(caseLeft + upLeft, 3 + Math.floor(rand() * 25));
    let made = 0;
    while (made < target && caseLeft + upLeft > 0) {
      const pickUpgrade = upLeft > 0 && (caseLeft === 0 || rand() < upLeft / (caseLeft + upLeft));
      if (pickUpgrade) {
        events.push(makeUpgradeEvent(rand, Math.round(ts), tag, seq++, cfg, balance));
        upLeft--; made++;
      } else {
        const evs = makeCaseEvents(rand, caseLeft, Math.round(ts), tag, seq++, balance);
        events.push(...evs);
        caseLeft -= evs.length; made += evs.length;
      }
      ts += (5 + rand() * 80) * 1000; // 5-85 s between actions
    }
  }
  const span = days * 24 * 60 * MINUTE;
  const side = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  for (let i = 0; i < deposits; i++) events.push(makeDeposit(side, tag, i, Math.round(start + side() * span)));
  for (let i = 0; i < withdrawals; i++) events.push(makeWithdrawal(side, tag, i, Math.round(start + side() * span)));
  return events.sort((a, b) => a.ts - b.ts);
}

/** Build one completed deposit. */
export function depositEvent({ ts = 0, amount = 1000, status = 'completed', ...rest } = {}) {
  return {
    id: `d-${++builderSeq}`, kind: 'deposit', ts, site: 'caser.gg', userId: 'u1', source: 'import',
    balanceBefore: null, balanceAfter: null,
    amount, method: 'card', status, completedTs: status === 'completed' ? ts + MINUTE : null, ...rest,
  };
}

/** Build one withdrawal. */
export function withdrawalEvent({ ts = 0, value = 100, exactTime = true, ...rest } = {}) {
  return {
    id: `w-${++builderSeq}`, kind: 'withdrawal', ts, site: 'caser.gg', userId: 'u1', source: 'live',
    balanceBefore: null, balanceAfter: null,
    item: makeItem(value), value, exactTime, ...rest,
  };
}
