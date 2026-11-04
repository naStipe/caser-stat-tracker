import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, parseExchange, upgradeFromRecord, historyRows, upgradeHistoryRows, caseFromInventoryRecord, depositFromPayment, withdrawalFromInventoryRecord, dropLiveTwins } from '../src/capture/parsers.js';
import { apiPath } from '../src/capture/hook.js';
import { shouldReplace, mergeEvent } from '../src/store/db.js';
import { toCsv, fromJson, toJson } from '../src/store/export.js';
import { shownChance, numOrNull } from '../src/schema.js';

const ex = (o) => ({ method: 'GET', reqBody: null, status: 200, serverTs: 1_700_000_000_000, ...o });

test('apiPath keeps same-origin /api paths only', () => {
  assert.equal(apiPath('https://caser.gg/api/game/cases?x=1', 'https://caser.gg'), '/game/cases?x=1');
  assert.equal(apiPath('/api/users/me', 'https://caser.gg'), '/users/me');
  assert.equal(apiPath('https://evil.com/api/x', 'https://caser.gg'), null);
  assert.equal(apiPath('https://caser.gg/_next/x.js', 'https://caser.gg'), null);
});

test('numOrNull keeps real zeros and drops junk', () => {
  assert.equal(numOrNull('0.000'), 0);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull('79.000'), 79);
});

test('shownChance matches the site formula and caps at 100', () => {
  assert.equal(shownChance(100, 1000), 10.3);
  assert.equal(shownChance(500, 400), 100);
  assert.equal(shownChance(0, 100), 0);
});

test('real case open response: price_paid, is_free, user_balance, unique ids for same skin', () => {
  const ctx = new Context();
  ctx.learn(ex({ path: '/game/cases', resBody: { cases: [{ id: '111', slug: 'magnum', title: 'Magnum', price: '19.000' }] } }));
  ctx.learn(ex({ path: '/users/me', resBody: { id: '1', balance: 38.06 } }));
  const skin = { id: '4709', marketName: 'MAG-7 | Metallic DDPAT (Factory New)', price: '15.520', is_free: false, price_paid: '19.000' };
  const open = ex({
    method: 'POST',
    path: '/game/cases/magnum/open',
    status: 201,
    reqBody: { count: 2, gameMode: 'fast' },
    resBody: { items: [skin, { ...skin, is_free: true, price_paid: '0.000' }], user_balance: '0.06', free_opens: {} },
  });
  const { events, recognized } = parseExchange(open, ctx, 'caser.gg');
  assert.equal(recognized, true);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  assert.equal(events[0].casePrice, 19);
  assert.equal(events[0].free, false);
  assert.equal(events[1].casePrice, 0);
  assert.equal(events[1].free, true);
  assert.equal(events[0].caseName, 'Magnum');
  assert.equal(events[0].item.name, 'MAG-7 | Metallic DDPAT (Factory New)');
  assert.equal(events[0].item.price, 15.52);
  assert.equal(events[0].gameMode, 'fast');
  assert.equal(events[0].batchId, events[1].batchId);
  assert.equal(events[0].balanceBefore, 38.06);
  assert.equal(events[0].balanceAfter, 0.06);
});

test('imported drops that were captured live are skipped once each', () => {
  const t = Date.parse('2026-11-04T00:53:39Z');
  const live = [{ kind: 'case', source: 'live', matchKey: 'magnum|MAG-7', ts: t + 2000 }];
  const imp = [
    { caseSlug: 'magnum', item: { name: 'MAG-7' }, ts: t },
    { caseSlug: 'magnum', item: { name: 'MAG-7' }, ts: t + 1000 },
    { caseSlug: 'magnum', item: { name: 'AK' }, ts: t },
  ];
  assert.equal(dropLiveTwins(imp, live).length, 2);
});

test('failed case open makes no events', () => {
  const { events } = parseExchange(ex({ method: 'POST', path: '/game/cases/eclipse/open', status: 409, resBody: { message: 'x' } }), new Context(), 'caser.gg');
  assert.equal(events.length, 0);
});

test('won upgrade: stake from bet items + balance, returned = target price', () => {
  const ctx = new Context();
  const bet = ex({
    method: 'POST',
    path: '/game/upgrade/bet',
    reqBody: { betInventoryItemIds: [1, 2], addedBalance: 10, isMystery: false, gameMode: 'normal', targetItemId: 99 },
    resBody: {
      bet: { id: 'b1', status: 'won', betItems: [{ id: 1, name: 'A', price: '40' }, { id: 2, name: 'B', price: '50' }], addedBalance: 10, targetItem: { id: 99, name: 'Knife', price: '1000' } },
      superDrop: { shown: false, won: false },
      compensationItems: [],
    },
  });
  const [e] = parseExchange(bet, ctx, 'caser.gg').events;
  assert.equal(e.stake, 100);
  assert.equal(e.won, true);
  assert.equal(e.returned, 1000);
  assert.equal(e.net, 900);
  assert.equal(e.chanceShown, 10.3);
  assert.equal(e.chanceServer, null);
  assert.equal(e.id, 'upgrade:b1');
});

test('lost upgrade uses inventory prices when the response lacks bet items, counts compensation', () => {
  const ctx = new Context();
  ctx.learn(ex({ path: '/items/inventory', resBody: { items: [{ id: 7, price: '25', item: { name: 'Glock' } }] } }));
  const bet = ex({
    method: 'POST',
    path: '/game/upgrade/bet',
    reqBody: { betInventoryItemIds: [7], addedBalance: 0, targetItemId: 3 },
    resBody: { bet: { id: 'b2', status: 'lost', chance: 0.2, targetItem: { id: 3, price: '125' } }, compensationItems: [{ id: 4, name: 'Sticker', price: '1.5' }] },
  });
  const [e] = parseExchange(bet, ctx, 'caser.gg').events;
  assert.equal(e.stake, 25);
  assert.equal(e.betItems[0].name, 'Glock');
  assert.equal(e.chanceServer, 20);
  assert.equal(e.chanceShown, 20);
  assert.equal(e.returned, 1.5);
  assert.equal(e.net, -23.5);
});

test('history rows are found the same way the site finds them', () => {
  assert.equal(historyRows({ items: [1, 2] }).length, 2);
  assert.equal(historyRows({ data: { upgrades: [1] } }).length, 1);
  assert.equal(historyRows([1, 2, 3]).length, 3);
  assert.equal(historyRows(null).length, 0);
});

test('real upgrade history row: fraction probability, featured rows merged without duplicates', () => {
  const row = {
    id: '368445938', status: 'won', addedBalance: '0.00', probability: '0.0490', isMystery: false,
    betItems: [{ id: '25', marketName: 'P2000 | Red Wing (Battle-Scarred)', price: '9.471' }],
    targetItem: { id: '2318', marketName: 'StatTrak™ SG 553 | Darkwing (Minimal Wear)', price: '199.15' },
    wonItem: { id: '2318', marketName: 'StatTrak™ SG 553 | Darkwing (Minimal Wear)', price: '199.15' },
    superDrop: { shown: false, won: false, item: null }, multiplier: '21.02', createdAt: '2026-11-01T23:51:40+00:00',
  };
  const rows = upgradeHistoryRows({ featured: [row, { id: 'f2' }], items: [row, { id: 'x' }], hasMore: false });
  assert.deepEqual(rows.map((r) => r.id), ['368445938', 'x', 'f2']);
  const e = upgradeFromRecord(row, new Context(), 'caser.gg');
  assert.equal(e.chanceServer, 4.9);
  assert.equal(e.stake, 9.471);
  assert.equal(e.returned, 199.15);
  assert.equal(e.target.name, 'StatTrak™ SG 553 | Darkwing (Minimal Wear)');
});

test('mystery upgrade: hidden chance, item always received, multiplier kept', () => {
  const lost = upgradeFromRecord({
    id: 'm1', status: 'lost', isMystery: true, probability: '0', mysteryMultiplier: '0.8212', addedBalance: '0.00',
    betItems: [{ id: 'a', price: '1329.63' }], targetItem: { id: 't', price: '1091.96' }, wonItem: { id: 't', price: '1091.96' },
    superDrop: { shown: false, won: false, item: null }, createdAt: '2026-11-03T22:26:28+00:00',
  }, new Context(), 'caser.gg');
  assert.equal(lost.chanceShown, null);
  assert.equal(lost.chanceServer, null);
  assert.equal(lost.returned, 1091.96);
  assert.equal(lost.mysteryMultiplier, 0.8212);
  assert.ok(Math.abs(lost.net - (1091.96 - 1329.63)) < 1e-9);
});

test('super-drop win returns the multiplied item once, not target + super drop', () => {
  const e = upgradeFromRecord({
    id: 's1', status: 'won', probability: '0.1100', addedBalance: '0',
    betItems: [{ price: '12' }], targetItem: { price: '115.16' }, wonItem: { price: '178.05' },
    superDrop: { shown: true, won: true, item: { price: '178.05' } }, createdAt: '2026-11-01T00:00:00Z',
  }, new Context(), 'caser.gg');
  assert.equal(e.returned, 178.05);
  assert.equal(e.chanceShown, 11);
});

test('deposits from payment history and withdrawals from inventory history', () => {
  const ctx = new Context();
  const d = depositFromPayment({ id: '18262533', methodName: 'Google Pay', amount: '274.30', status: 'completed', createdAt: '2026-11-04T00:38:54+00:00', completedAt: '2026-11-04T00:39:11+00:00' }, ctx, 'caser.gg');
  assert.equal(d.kind, 'deposit');
  assert.equal(d.amount, 274.3);
  assert.equal(d.completedTs, Date.parse('2026-11-04T00:39:11+00:00'));
  const w = withdrawalFromInventoryRecord({ id: '1277634214', status: 'withdrawn', price: '3537.300', item: { marketName: 'AWP | Wildfire (Battle-Scarred)' }, createdAt: '2026-11-01T18:42:35+00:00' }, ctx, 'caser.gg');
  assert.equal(w.kind, 'withdrawal');
  assert.equal(w.value, 3537.3);
  assert.equal(w.exactTime, false);
  assert.equal(withdrawalFromInventoryRecord({ id: 1, status: 'sold', createdAt: '2026-11-01T00:00:00Z' }, ctx, 'caser.gg'), null);
});

test('live withdrawal request is priced from the learned inventory', () => {
  const ctx = new Context();
  ctx.learn(ex({ path: '/items/inventory', resBody: { items: [{ id: 55, price: '26.14', item: { marketName: 'Deagle' } }] } }));
  const evs = parseExchange(ex({ method: 'POST', path: '/withdrawals', reqBody: { inventoryItemIds: [55] }, resBody: { ok: true } }), ctx, 'caser.gg').events;
  assert.equal(evs.length, 1);
  assert.equal(evs[0].value, 26.14);
  assert.equal(evs[0].exactTime, true);
});

test('inventory balance endpoint is inventory value, not cash balance', () => {
  const ctx = new Context();
  ctx.learn(ex({ path: '/users/me', resBody: { id: '1', balance: 19.06 } }));
  ctx.learn(ex({ path: '/items/inventory/balance', resBody: { amount: '185.789' } }));
  assert.equal(ctx.balance, 19.06);
  assert.equal(ctx.inventoryValue, 185.789);
});

test('case drop from inventory history uses the learned case price; unknown cases are skipped', () => {
  const ctx = new Context();
  ctx.learn(ex({ path: '/game/cases', resBody: { cases: [{ id: '7', slug: 'magnum', title: 'Magnum', price: '19.000' }] } }));
  const row = {
    id: '1346640004', action: 'won_case', status: 'available', price: '15.520', createdAt: '2026-11-04T00:53:39+00:00',
    item: { id: '4709', marketName: 'MAG-7 | Metallic DDPAT (Factory New)', price: '15.520' },
    source: { type: 'case', case: { slug: 'magnum', title: 'Магнум' } },
  };
  const e = caseFromInventoryRecord(row, ctx, 'caser.gg');
  assert.equal(e.id, 'case:1346640004');
  assert.equal(e.casePrice, 19);
  assert.equal(e.item.price, 15.52);
  assert.equal(e.ts, Date.parse('2026-11-04T00:53:39+00:00'));
  assert.equal(caseFromInventoryRecord({ ...row, source: { type: 'case', case: { slug: 'gone' } } }, ctx, 'caser.gg'), null);
  assert.equal(caseFromInventoryRecord({ ...row, action: 'won_upgrade', source: { type: 'upgrade' } }, ctx, 'caser.gg'), null);
});

test('history record timestamp comes from createdAt', () => {
  const e = upgradeFromRecord({ id: 9, status: 'lost', createdAt: '2026-10-01T12:00:00Z', betItems: [{ price: 10 }], targetItem: { price: 50 } }, new Context(), 'caser.gg');
  assert.equal(e.ts, Date.parse('2026-10-01T12:00:00Z'));
  assert.equal(e.source, 'import');
});

test('store merge: resolved beats pending, live beats import but keeps live time', () => {
  assert.equal(shouldReplace({ kind: 'upgrade', status: 'pending', source: 'live' }, { status: 'won', source: 'import' }), true);
  assert.equal(shouldReplace({ kind: 'upgrade', status: 'won', source: 'live' }, { status: 'won', source: 'import' }), false);
  const m = mergeEvent({ ts: 5, source: 'live', balanceBefore: 10, status: 'pending' }, { ts: 9, source: 'import', balanceBefore: null, status: 'won' });
  assert.equal(m.ts, 5);
  assert.equal(m.status, 'won');
  assert.equal(m.balanceBefore, 10);
});

test('store merge: a deposit upgrades from pending to completed', () => {
  const pending = { kind: 'deposit', status: 'pending', source: 'import', completedTs: null };
  const done = { kind: 'deposit', status: 'completed', source: 'import', completedTs: 1000 };
  assert.equal(shouldReplace(pending, done), true);
  assert.equal(shouldReplace(done, { kind: 'deposit', status: 'completed', source: 'import', completedTs: 1000 }), false);
  assert.equal(shouldReplace(done, pending), false); // never fall back to pending
  const m = mergeEvent(pending, done);
  assert.equal(m.status, 'completed');
  assert.equal(m.completedTs, 1000);
});

test('export round trip and csv escaping', () => {
  const evs = [{ id: 'case:1', kind: 'case', ts: 1, site: 'caser.gg', source: 'live', casePrice: 10, caseName: 'A, "B"', item: { name: 'X', price: 5 }, free: false, gameMode: 'normal', balanceBefore: null, balanceAfter: null }];
  assert.deepEqual(fromJson(toJson(evs)), evs);
  assert.match(toCsv(evs), /"A, ""B"""/);
  assert.throws(() => fromJson('nope'), /valid JSON/);
});

test('selection price parsing handles site formats', async () => {
  const { parsePrice } = await import('../src/capture/selection.js');
  assert.equal(parsePrice('26,14'), 26.14);
  assert.equal(parsePrice('1 234,56'), 1234.56);
  assert.equal(parsePrice('1\u00a0234,5'), 1234.5);
  assert.equal(parsePrice('78.50'), 78.5);
});
