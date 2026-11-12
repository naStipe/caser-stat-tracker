// Upgrade overlay: a small draggable card with odds, EV and history for the current selection.
// Visible only while opts.getSelection() returns non-null. Polls every 400 ms and does no work
// when neither the selection nor the stored events changed.

import { h, s, createHost, attach, store, debounce, safe } from './dom.js';
import { BASE_CSS, OVERLAY_CSS } from './styles.js';
import { fmtMoney, fmtPct, fmtCI, fmtChance, fmtMult, fmtInt, fmtDuration, signClass, DASH } from './format.js';

const POS_KEY = 'cst.ui.overlayPos';
const COLLAPSED_KEY = 'cst.ui.overlayCollapsed';
const POLL_MS = 400;
const MIN_HISTORY = 30;
const REAL_MIN_N = 100;

/** The calibrationCurve row whose [lo, hi) range (percent) holds chance; the last row includes hi. */
export function curveRowFor(rows, chance) {
  if (!Array.isArray(rows) || !ok(chance)) return null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !ok(r.lo) || !ok(r.hi)) continue;
    const last = i === rows.length - 1;
    if (chance >= r.lo && (chance < r.hi || (last && chance <= r.hi))) return r;
  }
  return null;
}

const ok = (v) => typeof v === 'number' && Number.isFinite(v);

function icon(d) {
  return s(
    'svg',
    { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    s('path', { d }),
  );
}
const GRIP = 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01';
const CHEVRON_UP = 'M4 10l4-4 4 4';
const CHEVRON_DOWN = 'M4 6l4 4 4-4';
const CLOSE = 'M4.5 4.5l7 7M11.5 4.5l-7 7';

/**
 * One-line plain-language verdict.
 * real: { rate, n, label } from calibrationCurve when that bucket has at least REAL_MIN_N upgrades.
 */
export function verdictFor(q, stake, currency, real = null, targetPrice = null) {
  if (real && ok(real.rate) && ok(targetPrice)) {
    const perTry = real.rate * targetPrice - stake;
    const sub = ok(real.bucketRate)
      ? `At ${real.label || 'this'} shown chance you really won ${fmtPct(real.bucketRate, 1)} vs ${fmtPct(real.bucketShown, 1)} shown (${fmtInt(real.n)} upgrades).`
      : `Real win rate from ${fmtInt(real.n)} of your upgrades at this level.`;
    if (Math.abs(perTry) < 0.005) return { text: 'On average you break even at these odds.', tone: '', sub };
    return perTry < 0
      ? { text: `On average you lose ${fmtMoney(-perTry, currency)} per try at these odds.`, tone: 'neg', sub }
      : { text: `On average you gain ${fmtMoney(perTry, currency)} per try at these odds.`, tone: 'pos', sub };
  }
  if (ok(q.realEdge)) {
    const perTry = q.realEdge * stake;
    const sub = 'Based on your own upgrades at similar chances.';
    if (Math.abs(perTry) < 0.005) return { text: 'On average you break even at these odds.', tone: '', sub };
    return perTry < 0
      ? { text: `On average you lose ${fmtMoney(-perTry, currency)} per try at these odds.`, tone: 'neg', sub }
      : { text: `On average you gain ${fmtMoney(perTry, currency)} per try at these odds.`, tone: 'pos', sub };
  }
  const sub = `By the shown odds only. Your real results here are unknown until ${MIN_HISTORY} upgrades at similar chances.`;
  if (!ok(q.ev) || Math.abs(q.ev) < 0.005) return { text: 'By the shown odds you break even on average.', tone: '', sub };
  return q.ev < 0
    ? { text: `On average you lose ${fmtMoney(-q.ev, currency)} per try at these odds.`, tone: 'neg', sub }
    : { text: `The shown odds promise ${fmtMoney(q.ev, currency)} per try on average.`, tone: '', sub };
}

const pctCapped = (p) => (p > 0.99 ? '>99%' : p < 0.01 ? '<1%' : fmtPct(p, 0));

const OUTLOOK_TEXT = {
  'likely-profit': { text: 'Likely profitable', tone: 'pos' },
  'likely-loss': { text: 'Likely losing', tone: 'neg' },
  unclear: { text: 'Unclear', tone: '' },
};

/**
 * Outlook block: does this upgrade pay on average at this chance and at this moment?
 * Returns null when there is no outlook or not enough history (the plain verdict is used then).
 */
export function outlookBlock(ol, currency, balance = null) {
  if (!ol || !OUTLOOK_TEXT[ol.verdict]) return null;
  const t = OUTLOOK_TEXT[ol.verdict];
  const ctx = ol.context || {};
  const kellyEl = kellyLine(ol, currency, balance);
  const since =
    ctx.minutesSinceDeposit === null || !ok(ctx.minutesSinceDeposit)
      ? 'No deposit recorded yet.'
      : `${fmtDuration(ctx.minutesSinceDeposit * 60000)} since your last deposit, upgrade #${fmtInt((ctx.upgradesSinceDeposit || 0) + 1)} after it, ${fmtMoney(ctx.netSinceDeposit, currency, { sign: true })} since then.`;
  const rows = [];
  for (const w of ol.windows || []) {
    const cur = w.key === (ol.window && ol.window.key);
    const cls = cur ? 'cur' : '';
    rows.push(
      h('span', { class: cls, text: (cur ? 'Now: ' : '') + w.label }),
      h('span', { class: ['num', cls], text: w.n ? fmtPct(w.realChance, 1) : DASH }),
      h('span', { class: ['num', cls], text: `n = ${fmtInt(w.n)}` }),
    );
  }
  return h(
    'div',
    { class: ['outlook', t.tone], role: 'status', 'aria-live': 'polite' },
    h(
      'div',
      { class: 'ol-head' },
      h('span', { class: 'ol-verdict', text: t.text }),
      h('span', {
        class: 'ol-prob',
        title: `From your history: ${fmtPct(ol.probProfitable, 1)} chance that the real win rate here beats break-even, so the upgrade pays on average`,
        text: `${pctCapped(ol.verdict === 'likely-loss' ? 1 - ol.probProfitable : ol.probProfitable)} ${ol.verdict === 'unclear' ? 'it pays' : 'confident'}`,
      }),
    ),
    h(
      'p',
      { class: 'ol-line' },
      'Real chance now ',
      h('b', { text: fmtPct(ol.realChance, 1) }),
      ` vs ${fmtChance(ol.chanceShown)} shown. Average `,
      h('b', { class: signClass(ol.ev), text: fmtMoney(ol.ev, currency, { sign: true }) }),
      ` per try (${fmtPct(ol.evPct, 1, { sign: true })}).`,
    ),
    h('p', { class: 'ol-line', text: since }),
    h('div', { class: 'ol-win', 'aria-label': `Real chance at ${ol.band} shown chance by time since deposit` }, ...rows),
    kellyEl,
  );
}

/**
 * Half-Kelly suggested stake for the selected upgrade. Shows a percent of bankroll, plus a money
 * amount when the balance is known. Zero edge -> skip. Returns null when there is no Kelly figure.
 */
export function kellyLine(ol, currency, balance) {
  const k = ol.kelly;
  if (!k) return null;
  if (!(k.half > 0)) {
    return h('p', { class: 'ol-kelly', text: 'Suggested stake: 0 — skip this one.' });
  }
  const amount = ok(balance) && balance > 0 ? ` (≈ ${fmtMoney(k.half * balance, currency)})` : '';
  return h(
    'p',
    { class: 'ol-kelly', title: 'Half-Kelly: the stake that grows a bankroll fastest for this edge, halved because the real chance is an estimate' },
    'Suggested stake: ',
    h('b', { text: `${fmtPct(k.half, 1)} of balance` }),
    amount,
  );
}

export function mountUpgradeOverlay(opts = {}) {
  const o = opts;
  const stats = o.stats || {};
  const cur = () => {
    try {
      return String((o.currency && o.currency()) ?? '');
    } catch {
      return '';
    }
  };

  const { host, root } = createHost('caser-tracker-overlay', 2147482990);
  root.append(h('style', { text: BASE_CSS + OVERLAY_CSS }));
  const wrap = h('div', { class: 'root' });
  root.append(wrap);

  let collapsed = !!store.get(COLLAPSED_KEY, false);
  let pos = store.get(POS_KEY, null);
  if (!pos || !ok(pos.x) || !ok(pos.y)) pos = null;

  const grip = h('button', { type: 'button', class: 'iconbtn grip', 'aria-label': 'Move card. Use arrow keys, hold Shift for bigger steps.' }, icon(GRIP));
  const toggle = h('button', {
    type: 'button',
    class: 'iconbtn',
    on: {
      click: () => {
        collapsed = !collapsed;
        store.set(COLLAPSED_KEY, collapsed);
        applyCollapsed();
        clampAndPlace();
      },
    },
  });
  const off =
    typeof o.onTurnOff === 'function'
      ? h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Turn off upgrade odds', title: 'Turn off. Turn it back on in Stats, Data tab.', on: { click: () => o.onTurnOff() } }, icon(CLOSE))
      : null;
  const bar = h('div', { class: 'bar' }, grip, h('span', { class: 'ttl', text: 'Upgrade odds' }), toggle, off);
  const content = h('div', { class: 'content', id: 'cst-overlay-content' });
  const card = h('div', { class: 'card', role: 'region', 'aria-label': 'Upgrade odds', hidden: true }, bar, content);
  wrap.append(card);
  // Keep site hotkeys from reacting to keys pressed on the card.
  card.addEventListener('keydown', (e) => e.stopPropagation());

  function applyCollapsed() {
    card.classList.toggle('collapsed', collapsed);
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', 'cst-overlay-content');
    toggle.setAttribute('aria-label', collapsed ? 'Expand upgrade odds' : 'Collapse upgrade odds');
    toggle.replaceChildren(icon(collapsed ? CHEVRON_DOWN : CHEVRON_UP));
  }
  applyCollapsed();

  // ---------- position ----------
  function clamp(p) {
    const w = card.offsetWidth || 300;
    const hh = card.offsetHeight || 40;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - hh);
    return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) };
  }
  function place(p) {
    card.style.left = `${Math.round(p.x)}px`;
    card.style.top = `${Math.round(p.y)}px`;
  }
  function clampAndPlace() {
    if (card.hidden) return;
    if (!pos) pos = { x: window.innerWidth - (card.offsetWidth || 300) - 16, y: 96 };
    place(clamp(pos));
  }

  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button') && !e.target.closest('.grip')) return;
    const r = card.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pos = clamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy });
    place(pos);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    card.classList.remove('dragging');
    store.set(POS_KEY, pos);
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    pos = clamp({ x: r.left + d[0], y: r.top + d[1] });
    place(pos);
    store.set(POS_KEY, pos);
  });
  const onResize = debounce(() => {
    if (pos) pos = clamp(pos);
    clampAndPlace();
  }, 120);
  window.addEventListener('resize', onResize);

  // ---------- events ----------
  let events = [];
  let curveRows = null;
  let olModel = null;
  let version = 0;
  let loading = false;
  let again = false;
  async function loadEvents() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const ev = await o.getEvents();
      events = Array.isArray(ev) ? ev : [];
    } catch (e) {
      console.warn('[caser-tracker] overlay could not read events', e);
    }
    // The real odds curve is computed once per load, not on every poll.
    const curve = safe(() => (typeof stats.calibrationCurve === 'function' ? stats.calibrationCurve(events) : null));
    curveRows = Array.isArray(curve.value) ? curve.value : null;
    // The outlook's history part is also built once per load; per render only the clock-dependent part runs.
    const m = safe(() => (typeof stats.outlookModel === 'function' ? stats.outlookModel(events) : null));
    olModel = m.value || null;
    quoteCache = null;
    loading = false;
    version += 1;
    if (again) {
      again = false;
      loadEvents();
    }
  }
  const refresh = debounce(loadEvents, 300);

  // ---------- render ----------
  let lastKey = null;
  let lastVersion = -1;
  // upgradeQuote scans the whole history, so it is cached until the selection or the events change.
  let quoteCache = null;

  function tick() {
    attach(host);
    let sel = null;
    try {
      sel = o.getSelection ? o.getSelection() : null;
    } catch {
      sel = null;
    }
    // The time slot makes the outlook follow the clock (time since deposit) while the selection stays.
    const key = sel ? `${sel.stake}|${sel.targetPrice}|${sel.chanceShown}|${cur()}|${Math.floor(Date.now() / 15000)}` : '';
    if (key === lastKey && version === lastVersion) return;
    lastKey = key;
    lastVersion = version;
    if (!sel) {
      card.hidden = true;
      return;
    }
    const wasHidden = card.hidden;
    card.hidden = false;
    renderContent(sel);
    if (wasHidden || pos) clampAndPlace();
  }

  function renderContent(sel) {
    const c = cur();
    const stake = Number(sel.stake);
    const targetPrice = Number(sel.targetPrice);
    if (!(stake > 0) || !(targetPrice > 0)) {
      content.replaceChildren(h('p', { class: 'muted', text: 'Pick your items and a target item to see the odds.' }));
      return;
    }
    const input = { stake, targetPrice };
    if (ok(sel.chanceShown)) input.chanceShown = sel.chanceShown;
    const qKey = `${stake}|${targetPrice}|${input.chanceShown}|${version}`;
    const res =
      quoteCache && quoteCache.key === qKey
        ? quoteCache.res
        : safe(() => {
            if (typeof stats.upgradeQuote !== 'function') throw new Error('stats.upgradeQuote is missing');
            return stats.upgradeQuote(input, events);
          });
    quoteCache = { key: qKey, res };
    if (res.error || !res.value) {
      content.replaceChildren(h('p', { class: 'error', role: 'alert', text: `Could not compute odds: ${(res.error && res.error.message) || 'no result'}` }));
      return;
    }
    const q = res.value;
    const chance = ok(q.chanceShown) ? q.chanceShown : ok(sel.chanceShown) ? sel.chanceShown : null;
    const row = curveRowFor(curveRows, chance);
    // The bucket's real/shown ratio is applied to this selection's chance, so a 1% bet in a 0-10% bucket
    // is not credited with the bucket's average real win rate.
    const real =
      row && row.n >= REAL_MIN_N && ok(row.winRate) && ok(chance)
        ? {
            rate: row.expectedRate > 0 ? Math.min(1, (chance / 100) * (row.winRate / row.expectedRate)) : row.winRate,
            bucketRate: row.winRate,
            bucketShown: row.expectedRate,
            n: row.n,
            label: row.label,
          }
        : null;
    const v = verdictFor(q, stake, c, real, targetPrice);
    const sim = q.similar || {};
    const lr = q.longRun || {};

    const kv = h(
      'dl',
      { class: 'kv' },
      h('dt', { text: 'Shown chance' }),
      h('dd', { class: 'num', text: fmtChance(q.chanceShown) }),
      real ? h('dt', { text: 'Real chance at this level', title: `Your real win rate for ${real.label || 'this'} shown chance` }) : null,
      real
        ? h(
            'dd',
            { class: ['num', signClass(real.rate - (chance || 0) / 100)] },
            fmtPct(real.rate, 1),
            h('span', { class: 'ci', text: `(n = ${fmtInt(real.n)})` }),
          )
        : null,
      h('dt', { text: 'Fair chance', title: 'Stake divided by target price' }),
      h('dd', { class: 'num', text: fmtChance(q.chanceFair) }),
      h('dt', { text: 'Multiplier' }),
      h('dd', { class: 'num', text: fmtMult(q.multiplier) }),
      h('dt', { text: 'EV per try', title: 'Expected value by the shown chance' }),
      h(
        'dd',
        { class: ['num', signClass(q.ev)] },
        fmtMoney(q.ev, c, { sign: true }),
        h('span', { class: 'ci', text: `${fmtPct(q.evPct, 1, { sign: true })} of stake` }),
      ),
      h('dt', { text: 'Real edge', title: 'From your history at similar chances: real return minus 1' }),
      ok(q.realEdge)
        ? h('dd', { class: ['num', signClass(q.realEdge)], text: fmtPct(q.realEdge, 1, { sign: true }) })
        : h('dd', { class: 'muted' }, 'not enough data', h('span', { class: 'ci', text: `needs ${MIN_HISTORY} upgrades` })),
      h('dt', { text: 'Your similar tries', title: 'Same chance bucket and same stake bucket' }),
      sim.n
        ? h(
            'dd',
            { class: 'num' },
            `${fmtPct(sim.winRate, 1)} won`,
            h('span', { class: 'ci', text: `${fmtCI(sim.winRateCI)}, n = ${fmtInt(sim.n)}` }),
          )
        : h('dd', { class: 'muted', text: 'none yet' }),
    );

    const longRun = h(
      'div',
      { class: 'longrun' },
      h('div', { class: 'lt', text: `${fmtInt(lr.tries || 100)} tries like this${lr.basis === 'history' ? ', at your real return' : ', at the shown odds'}` }),
      h('div', { class: 'line' }, h('span', { text: 'Average net' }), h('span', { class: ['num', signClass(lr.mean)], text: fmtMoney(lr.mean, c, { sign: true }) })),
      h(
        'div',
        { class: 'line' },
        h('span', { text: '5–95% range' }),
        h('span', { class: 'num', text: ok(lr.p05) && ok(lr.p95) ? `${fmtMoney(lr.p05, '', { sign: true })} to ${fmtMoney(lr.p95, c, { sign: true })}` : DASH }),
      ),
      h('div', { class: 'line' }, h('span', { text: 'Chance to end in profit' }), h('span', { class: 'num', text: fmtPct(lr.probProfit, 0) })),
    );

    const ol = safe(() => (typeof stats.upgradeOutlook === 'function' ? stats.upgradeOutlook(input, events, { now: Date.now(), model: olModel || undefined }) : null));
    let balance = null;
    try {
      const hv = o.getHoldings ? o.getHoldings() : null;
      if (hv && ok(hv.balance)) balance = hv.balance;
    } catch {}
    const olEl = ol.value ? outlookBlock(ol.value, c, balance) : null;

    content.replaceChildren(
      ...(olEl
        ? [olEl]
        : [h('p', { class: ['verdict', v.tone], role: 'status', 'aria-live': 'polite', text: v.text }), h('p', { class: 'verdict-sub', text: v.sub })]),
      kv,
      longRun,
    );
  }

  const timer = setInterval(tick, POLL_MS);
  loadEvents().then(tick);

  return {
    refresh,
    destroy() {
      clearInterval(timer);
      refresh.cancel();
      onResize.cancel();
      window.removeEventListener('resize', onResize);
      host.remove();
    },
  };
}
