import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerVersion, compareVersions, checkForUpdate, parseRawUrl } from '../src/update.js';

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

const RAW = 'https://raw.githubusercontent.com/me/repo/main/dist/s.user.js';
const SHA = 'a'.repeat(40);

test('parseRawUrl splits a raw GitHub URL', () => {
  assert.deepEqual(parseRawUrl(RAW), { owner: 'me', repo: 'repo', ref: 'main', path: 'dist/s.user.js' });
  assert.equal(parseRawUrl('https://x.test/s.user.js'), null);
});

test('update check reads the file at the newest commit, past the raw cache', async () => {
  const calls = [];
  const request = async (url, headers) => {
    calls.push([url, headers?.accept ?? null]);
    if (url.startsWith('https://api.github.com/')) return { status: 200, text: `${SHA}\n` };
    return { status: 200, text: url.includes(SHA) ? '// @version      0.9.3\n' : '// @version      0.9.2\n' };
  };
  const r = await checkForUpdate({ url: RAW, current: '0.9.2', request });
  assert.match(calls[0][0], /^https:\/\/api\.github\.com\/repos\/me\/repo\/commits\/main\?t=\d+$/);
  assert.equal(calls[0][1], 'application/vnd.github.sha');
  assert.equal(calls[1][0], `https://raw.githubusercontent.com/me/repo/${SHA}/dist/s.user.js`);
  assert.equal(r.latest, '0.9.3');
  assert.equal(r.newer, true);
  assert.equal(r.installUrl, calls[1][0]);
});

test('update check falls back to the branch file when the API fails', async () => {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    if (url.startsWith('https://api.github.com/')) return { status: 403, text: 'rate limit' };
    return { status: 200, text: '// @version      0.9.3\n' };
  };
  const r = await checkForUpdate({ url: RAW, current: '0.9.3', request });
  assert.equal(r.newer, false);
  assert.equal(r.installUrl, RAW);
  assert.match(urls[1], /^https:\/\/raw\.githubusercontent\.com\/me\/repo\/main\/dist\/s\.user\.js\?t=\d+$/);
  // Not a GitHub URL: no API call at all.
  const plain = [];
  await checkForUpdate({ url: 'https://x.test/s.user.js', current: '1', request: async (u) => (plain.push(u), { status: 200, text: '// @version 1\n' }) });
  assert.equal(plain.length, 1);
  await assert.rejects(checkForUpdate({ url: 'u', current: '1', request: async () => ({ status: 404, text: '' }) }), /404/);
});
