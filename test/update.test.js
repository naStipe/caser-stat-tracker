import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerVersion, compareVersions, checkForUpdate } from '../src/update.js';

test('reads @version from a userscript header', () => {
  assert.equal(headerVersion('// ==UserScript==\n// @name  X\n// @version      0.9.2\n// ==/UserScript==\n'), '0.9.2');
  assert.equal(headerVersion('// @version 1.0.0\r\n'), '1.0.0');
  assert.equal(headerVersion('no header'), null);
});

test('compares dotted versions by number, not text', () => {
  assert.equal(compareVersions('0.10.0', '0.9.2'), 1);
  assert.equal(compareVersions('0.9.1', '0.9.1'), 0);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
  assert.equal(compareVersions('0.9.1', '0.9.2'), -1);
});

test('update check skips the cache and reports a newer version', async () => {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return { status: 200, text: '// @version      0.9.3\n' };
  };
  const r = await checkForUpdate({ url: 'https://x.test/s.user.js', current: '0.9.2', request });
  assert.equal(r.latest, '0.9.3');
  assert.equal(r.newer, true);
  assert.match(urls[0], /^https:\/\/x\.test\/s\.user\.js\?t=\d+$/);
  const same = await checkForUpdate({ url: 'u', current: '0.9.3', request });
  assert.equal(same.newer, false);
  await assert.rejects(checkForUpdate({ url: 'u', current: '1', request: async () => ({ status: 404, text: '' }) }), /404/);
});
