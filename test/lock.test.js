import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLock, checkPassword, isLock, isGuest, passwordProblem, OWNER_LOCK } from '../src/store/lock.js';

test('the built-in owner lock opens with the owner password', async () => {
  assert.ok(isLock(OWNER_LOCK));
  assert.equal(await checkPassword(OWNER_LOCK, '12341234'), true);
  assert.equal(await checkPassword(OWNER_LOCK, '1234'), false);
});

test('a stored lock accepts its password and nothing else', async () => {
  const rec = await makeLock('hunter2');
  assert.ok(isLock(rec));
  assert.ok(!JSON.stringify(rec).includes('hunter2'));
  assert.equal(await checkPassword(rec, 'hunter2'), true);
  assert.equal(await checkPassword(rec, 'hunter3'), false);
  assert.equal(await checkPassword(rec, ''), false);
  assert.equal(await checkPassword(null, 'hunter2'), false);
});

test('the same password gets a different salt each time', async () => {
  const a = await makeLock('same-pass');
  const b = await makeLock('same-pass');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('short passwords are refused', async () => {
  assert.ok(passwordProblem('abc'));
  assert.equal(passwordProblem('abcd'), null);
  await assert.rejects(makeLock('abc'));
});

test('guest view: only with a lock, not unlocked, and not a trusted account', async () => {
  const rec = await makeLock('pass1234');
  assert.equal(isGuest(null, false, [], '1'), false);
  assert.equal(isGuest(rec, false, [], '1'), true);
  assert.equal(isGuest(rec, true, [], '1'), false);
  assert.equal(isGuest(rec, false, ['1'], '1'), false);
  assert.equal(isGuest(rec, false, ['1'], '2'), true);
  assert.equal(isGuest(rec, false, ['1'], null), true);
});
