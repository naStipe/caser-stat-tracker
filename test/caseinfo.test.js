import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSlugFromPath, caseDetailPath, caseInfoFromResponse, fetchCaseInfo } from '../src/capture/caseinfo.js';
import { caseOdds } from '../src/stats/caseodds.js';

const official = {
  case: { id: '111', title: 'Magnum', slug: 'magnum', price: '19.000', type: 'paid' },
  items: [
    { id: '626', marketName: 'P90 | Grim (Field-Tested)', price: '26.080', image: 'https://img/1', rarity: '15' },
    { id: '1', marketName: 'Cheap', price: '6.406', image: null, rarity: '12' },
    { id: '2', marketName: 'Top', price: '213.530', image: null, rarity: '8' },
  ],
};

const custom = {
  id: '30238',
  slug: 'case-c2f2b251',
  title: 'Custom',
  price: '4.180',
  items: [
    { item: { id: '24970', marketName: 'M249 | Sleet (Minimal Wear)', price: '4.000', rarity: '13' }, chancePercent: '99.9980' },
    { item: { id: '9', marketName: 'Knife', price: '1000.000', rarity: '1' }, chancePercent: '0.0020' },
  ],
};

test('caseSlugFromPath reads case pages with and without a locale', () => {
  assert.equal(caseSlugFromPath('/en/cases/magnum'), 'magnum');
  assert.equal(caseSlugFromPath('/cases/case-c2f2b251/'), 'case-c2f2b251');
  assert.equal(caseSlugFromPath('/ru/cases/%D0%B0'), 'а');
  assert.equal(caseSlugFromPath('/en/upgrade'), null);
  assert.equal(caseSlugFromPath('/en/cases'), null);
  assert.equal(caseSlugFromPath('/en/cases/magnum/open'), null);
});

test('caseDetailPath matches only the case-contents endpoints', () => {
  assert.deepEqual(caseDetailPath('/game/cases/magnum'), { slug: 'magnum', custom: false });
  assert.deepEqual(caseDetailPath('/game/custom-cases/case-x?y=1'), { slug: 'case-x', custom: true });
  assert.equal(caseDetailPath('/game/cases'), null);
  assert.equal(caseDetailPath('/game/cases/magnum/open'), null);
  assert.equal(caseDetailPath('/game/custom-cases'), null);
});

test('official case: prices, no chances', () => {
  const info = caseInfoFromResponse(official, { slug: 'magnum' });
  assert.equal(info.slug, 'magnum');
  assert.equal(info.title, 'Magnum');
  assert.equal(info.price, 19);
  assert.equal(info.custom, false);
  assert.equal(info.items.length, 3);
  assert.equal(info.items[0].name, 'P90 | Grim (Field-Tested)');
  assert.equal(info.items[0].price, 26.08);
  assert.equal(info.items[0].chance, null);

  const o = caseOdds(info);
  assert.equal(o.n, 3);
  assert.deepEqual(o.min, { name: 'Cheap', price: 6.406 });
  assert.deepEqual(o.max, { name: 'Top', price: 213.53 });
  assert.equal(o.hasChances, false);
  assert.equal(o.ev, null);
  assert.deepEqual(o.items.map((i) => i.name), ['Top', 'P90 | Grim (Field-Tested)', 'Cheap']);
  assert.ok(Math.abs(o.items[0].mult - 213.53 / 19) < 1e-9);
});

test('custom case: unwraps items and computes EV from the published chances', () => {
  const info = caseInfoFromResponse(custom, { slug: 'case-c2f2b251', custom: true });
  assert.equal(info.custom, true);
  assert.equal(info.items[1].name, 'Knife');
  assert.equal(info.items[1].chance, 0.002);

  const o = caseOdds(info);
  assert.equal(o.hasChances, true);
  const ev = 4 * 0.99998 + 1000 * 0.00002;
  assert.ok(Math.abs(o.ev - ev) < 1e-9);
  assert.ok(Math.abs(o.evRatio - ev / 4.18) < 1e-9);
});

test('chances that do not add up to 100% are not used for EV', () => {
  const info = caseInfoFromResponse({ ...custom, items: [custom.items[0]] }, { custom: true });
  const o = caseOdds({ ...info, items: [...info.items, { id: 'x', name: 'No chance', price: 5, image: null, rarity: null, chance: null }] });
  assert.equal(o.hasChances, false);
  assert.equal(o.ev, null);
});

test('empty or junk bodies give null', () => {
  assert.equal(caseInfoFromResponse(null), null);
  assert.equal(caseInfoFromResponse({ case: { slug: 'x' }, items: [] }), null);
  assert.equal(caseInfoFromResponse({ cases: [] }), null);
});

test('fetchCaseInfo falls back to the custom endpoint on 404', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.startsWith('/api/game/cases/')) return { status: 404, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => custom };
  };
  const info = await fetchCaseInfo(fakeFetch, 'case-c2f2b251');
  assert.deepEqual(calls, ['/api/game/cases/case-c2f2b251', '/api/game/custom-cases/case-c2f2b251']);
  assert.equal(info.custom, true);
  assert.equal(info.items.length, 2);
});
