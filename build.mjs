// Bundles src/main.js into one Tampermonkey userscript: dist/caser-tracker.user.js
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Tampermonkey checks this URL for a higher @version and updates the script by itself.
const UPDATE_URL = 'https://raw.githubusercontent.com/naStipe/caser-stat-tracker/main/dist/caser-tracker.user.js';

const banner = `// ==UserScript==
// @name         Caser Stat Tracker
// @namespace    caser-stat-tracker
// @version      ${pkg.version}
// @description  Records your case opens and upgrades on caser.gg / caser.one and shows ROI, upgrade odds and factor statistics. Data stays in your browser (shared between both domains); optional cloud sync between browsers; only item names go to CSFloat for prices.
// @match        https://caser.gg/*
// @match        https://www.caser.gg/*
// @match        https://caser.one/*
// @match        https://www.caser.one/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @connect      csfloat.com
// @connect      hafnhxumrqyaljmciqqq.supabase.co
// @connect      raw.githubusercontent.com
// @noframes
// @homepageURL  https://github.com/naStipe/caser-stat-tracker
// @updateURL    ${UPDATE_URL}
// @downloadURL  ${UPDATE_URL}
// ==/UserScript==
`;

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/caser-tracker.user.js',
  banner: { js: banner },
  define: { __VERSION__: JSON.stringify(pkg.version), __UPDATE_URL__: JSON.stringify(UPDATE_URL) },
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
