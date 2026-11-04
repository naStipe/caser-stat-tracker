// Bundles src/main.js into one Tampermonkey userscript: dist/caser-tracker.user.js
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const banner = `// ==UserScript==
// @name         Caser Stat Tracker
// @namespace    caser-stat-tracker
// @version      ${pkg.version}
// @description  Records your case opens and upgrades on caser.gg / caser.one and shows ROI, upgrade odds and factor statistics. Data stays in your browser.
// @match        https://caser.gg/*
// @match        https://www.caser.gg/*
// @match        https://caser.one/*
// @match        https://www.caser.one/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==
`;

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/caser-tracker.user.js',
  banner: { js: banner },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
