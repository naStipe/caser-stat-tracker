import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOf, pickLegacyOwner, filterByAccount, resolveSelection, listAccounts, accountName,
  streamFlag, flagComplete, progressKey, isStreamFlag,
} from '../src/store/accounts.js';
import { Context } from '../src/capture/parsers.js';

const ev = (id, userId) => ({ id, kind: 'case', ts: 1, userId });

test('events without a userId belong to the legacy owner', () => {
  assert.equal(accountOf(ev('a', '7'), '1'), '7');
  assert.equal(accountOf(ev('a', null), '1'), '1');
  assert.equal(accountOf(ev('a', ''), null), null);
});

test('legacy owner is the account with the most events', () => {
  assert.equal(pickLegacyOwner([ev('a', '1'), ev('b', '2'), ev('c', '2'), ev('d', null)]), '2');
  assert.equal(pickLegacyOwner([ev('a', null)]), null);
  assert.equal(pickLegacyOwner([]), null);
});

test('filter keeps one account, or everything for all / unknown', () => {
  const list = [ev('a', '1'), ev('b', '2'), ev('c', null)];
  assert.deepEqual(filterByAccount(list, '1', '1').map((e) => e.id), ['a', 'c']);
  assert.deepEqual(filterByAccount(list, '2', '1').map((e) => e.id), ['b']);
  assert.equal(filterByAccount(list, 'all', '1'), list);
  assert.equal(filterByAccount(list, null, null), list);
});

test('selection "current" follows the signed-in account', () => {
  assert.equal(resolveSelection('current', '5', '1'), '5');
  assert.equal(resolveSelection(undefined, null, '1'), '1');
  assert.equal(resolveSelection('current', null, null), null);
  assert.equal(resolveSelection('all', '5', '1'), 'all');
  assert.equal(resolveSelection('9', '5', '1'), '9');
});

test('account list puts the signed-in account first, then by event count', () => {
  const list = listAccounts([ev('a', '1'), ev('b', '2'), ev('c', '2'), ev('d', null)], { 2: { name: 'Bob' } }, '1', '3');
  assert.deepEqual(list.map((a) => [a.id, a.name, a.events, a.current]), [
    ['3', 'Account 3', 0, true],
    ['1', 'Account 1', 2, false],
    ['2', 'Bob', 2, false],
  ]);
  assert.equal(accountName('4', { 4: { name: '  ' } }), 'Account 4');
});

test('history flags are per account; the legacy owner keeps the old flags', () => {
  assert.equal(streamFlag('upgrades', '7'), 'upgrades:7');
  assert.equal(progressKey('payments', '7'), 'sync:7:payments');
  assert.equal(flagComplete(['upgrades:7'], 'upgrades', '7', '1'), true);
  assert.equal(flagComplete(['upgrades'], 'upgrades', '1', '1'), true);
  assert.equal(flagComplete(['upgrades'], 'upgrades', '7', '1'), false);
  assert.equal(flagComplete(['upgrades:1'], 'upgrades', '7', '1'), false);
  assert.equal(flagComplete(['upgrades:7'], 'upgrades', null, null), false);
});

test('stream flag check accepts old and per-account names only', () => {
  const streams = ['upgrades', 'inventory', 'payments'];
  assert.ok(isStreamFlag('upgrades', streams));
  assert.ok(isStreamFlag('inventory:abc-12', streams));
  assert.ok(!isStreamFlag('other:1', streams));
  assert.ok(!isStreamFlag('upgrades:', streams));
  assert.ok(!isStreamFlag('upgrades:a b', streams));
  assert.ok(!isStreamFlag(5, streams));
});

test('context learns the account name and forgets the old inventory on a switch', () => {
  const ctx = new Context();
  const me = (body) => ({ method: 'GET', path: '/users/me', status: 200, resBody: body });
  ctx.learn(me({ id: 1, username: 'alice', balance: 5 }));
  ctx.learn({ method: 'GET', path: '/items/inventory/balance', status: 200, resBody: { amount: '9.5' } });
  ctx.learn({ method: 'GET', path: '/items/inventory', status: 200, resBody: { items: [{ id: 'x', price: 1, item: { marketName: 'A' } }] } });
  assert.equal(ctx.userId, '1');
  assert.equal(ctx.userName, 'alice');
  assert.equal(ctx.items.size, 1);
  ctx.learn(me({ id: 2, balance: 3 }));
  assert.equal(ctx.userId, '2');
  assert.equal(ctx.userName, null);
  assert.equal(ctx.items.size, 0);
  assert.equal(ctx.inventoryValue, null);
  assert.equal(ctx.balance, 3);
});
