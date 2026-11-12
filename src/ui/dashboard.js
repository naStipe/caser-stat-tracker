// Dashboard: launcher button (bottom-left) + right-side drawer with tabs.
// Talks to stats only through opts.stats (see docs/CONTRACT.md, "UI API").

import { h, s, createHost, attach, store, debounce, safe } from './dom.js';
import { BASE_CSS, DASHBOARD_CSS } from './styles.js';
import { lineChart, diffBars } from './charts.js';
import { viewOdds, viewMystery, viewMoney } from './views-v2.js';
import {
  fmtMoney,
  fmtNumber,
  fmtInt,
  fmtPct,
  fmtCI,
  fmtP,
  fmtPEq,
  fmtZ,
  fmtDate,
  fmtDateShort,
  fmtTime,
  fmtDateTime,
  fmtDuration,
  fmtAgo,
  signClass,
  DASH,
} from './format.js';

const TABS = [
  ['overview', 'Overview'],
  ['odds', 'Odds'],
  ['cases', 'Cases'],
  ['upgrades', 'Upgrades'],
  ['mystery', 'Mystery'],
  ['factors', 'Factors'],
  ['money', 'Money'],
  ['data', 'Data'],
];

// Factor keys from the contract. kinds = which event kinds the factor makes sense for.
const FACTORS = [
  { key: 'hour', label: 'Hour of day', kinds: ['upgrade', 'case'] },
  { key: 'weekday', label: 'Day of week', kinds: ['upgrade', 'case'] },
  { key: 'daypart', label: 'Part of day', kinds: ['upgrade', 'case'] },
  { key: 'sessionPosition', label: 'Position in session', kinds: ['upgrade', 'case'] },
  { key: 'sessionMinute', label: 'Minutes into session', kinds: ['upgrade', 'case'] },
  { key: 'afterLossStreak', label: 'Losses in a row before', kinds: ['upgrade'] },
  { key: 'afterWin', label: 'Previous upgrade result', kinds: ['upgrade'] },
  { key: 'mode', label: 'Normal or mystery', kinds: ['upgrade'] },
  { key: 'multiplier', label: 'Multiplier', kinds: ['upgrade'] },
  { key: 'itemCount', label: 'Items in the bet', kinds: ['upgrade'] },
  { key: 'addedBalance', label: 'Added balance', kinds: ['upgrade'] },
  { key: 'free', label: 'Free or paid open', kinds: ['case'] },
  { key: 'gameMode', label: 'Game mode', kinds: ['upgrade', 'case'] },
  { key: 'site', label: 'Site', kinds: ['upgrade', 'case'] },
  { key: 'balanceBand', label: 'Balance before', kinds: ['upgrade', 'case'] },
  { key: 'sinceDeposit', label: 'Time since last deposit', kinds: ['upgrade', 'case'] },
  { key: 'afterDepositOrder', label: 'Upgrades since last deposit', kinds: ['upgrade'] },
  { key: 'sinceWithdrawal', label: 'Time since last withdrawal', kinds: ['upgrade', 'case'] },
  { key: 'superDrop', label: 'Super-drop card shown', kinds: ['upgrade'] },
];

const EDGE_CFG = {
  chance: { storeKey: 'cst.ui.edges.chance', def: [0, 2, 5, 10, 20, 30, 50, 75, 100], allowInf: false },
  stake: { storeKey: 'cst.ui.edges.stake', def: [0, 100, 500, 1000, 5000, 20000, Infinity], allowInf: true },
};

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (ok(v) ? v : Number(v) || 0);

export function edgesToText(arr) {
  return arr.map((v) => (v === Infinity ? 'inf' : String(v))).join(', ');
}

/** Parse "0, 2, 5, inf" into a sorted unique number list. */
export function parseEdges(text, allowInf) {
  const parts = String(text || '')
    .split(/[,;\s]+/)
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (/^(inf|infinity|∞)$/i.test(p)) {
      if (!allowInf) return { error: 'Infinity is not allowed here. Use 100 as the top edge.' };
      out.push(Infinity);
      continue;
    }
    const n = Number(p);
    if (!Number.isFinite(n)) return { error: `"${p}" is not a number.` };
    if (n < 0) return { error: 'Edges cannot be negative.' };
    out.push(n);
  }
  const edges = [...new Set(out)].sort((a, b) => a - b);
  if (edges.length < 2) return { error: 'Enter at least two edges, separated by commas.' };
  return { edges };
}

function flow(e) {
  if (!e) return null;
  if (e.kind === 'case') return { cost: num(e.casePrice), ret: num(e.item && e.item.price) };
  if (e.kind === 'upgrade' && e.status !== 'pending') return { cost: num(e.stake), ret: num(e.returned) };
  return null;
}

function cumulative(events) {
  const sorted = events.filter((e) => flow(e)).sort((a, b) => num(a.ts) - num(b.ts));
  let net = 0;
  return sorted.map((e) => {
    const f = flow(e);
    net += f.ret - f.cost;
    return { ts: num(e.ts), v: net };
  });
}

function iconClose() {
  return s(
    'svg',
    { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' },
    s('path', { d: 'M4 4l8 8M12 4l-8 8' }),
  );
}

export function mountDashboard(opts = {}) {
  const o = opts;
  const stats = o.stats || {};
  const cur = () => {
    try {
      return String((o.currency && o.currency()) ?? '');
    } catch {
      return '';
    }
  };

  const { host, root } = createHost('caser-tracker-dashboard');
  root.append(h('style', { text: BASE_CSS + DASHBOARD_CSS }));
  const wrap = h('div', { class: 'root' });
  root.append(wrap);

  const savedSort = store.get('cst.ui.caseSort', null);
  const state = {
    open: false,
    tab: TABS.some(([id]) => id === store.get('cst.ui.tab', 'overview')) ? store.get('cst.ui.tab', 'overview') : 'overview',
    events: [],
    loaded: false,
    loading: false,
    again: false,
    loadError: null,
    cache: new Map(),
    caseSort: savedSort && typeof savedSort.key === 'string' ? savedSort : { key: 'n', dir: -1 },
    factorKey: store.get('cst.ui.factorKey', 'hour'),
    factorKind: store.get('cst.ui.factorKind', 'upgrade') === 'case' ? 'case' : 'upgrade',
    edges: { chance: null, stake: null },
    edgeText: { chance: '', stake: '' },
    edgeErr: { chance: null, stake: null },
    confirmClear: false,
    busy: null,
    msg: null,
    tabChanged: true,
    pendingFocus: null,
    holdings: null,
    holdingsError: null,
    dailyAll: false,
    accounts: null,
  };
  for (const kind of ['chance', 'stake']) {
    const cfg = EDGE_CFG[kind];
    const saved = store.get(cfg.storeKey, null);
    const parsed = typeof saved === 'string' ? parseEdges(saved, cfg.allowInf) : { error: 'none' };
    if (parsed.edges) {
      state.edges[kind] = parsed.edges;
      state.edgeText[kind] = edgesToText(parsed.edges);
    } else {
      state.edgeText[kind] = edgesToText(cfg.def);
    }
  }

  const memo = (key, fn) => {
    if (!state.cache.has(key)) state.cache.set(key, safe(fn));
    return state.cache.get(key);
  };
  const call = (name, ...args) => {
    if (typeof stats[name] !== 'function') throw new Error(`stats.${name} is missing`);
    return stats[name](...args);
  };

  // ---------- launcher ----------
  const launcher = h(
    'button',
    {
      type: 'button',
      class: 'launcher',
      'aria-expanded': 'false',
      'aria-controls': 'cst-panel',
      'aria-label': 'Open stats panel',
      on: { click: () => (state.open ? close() : open()) },
    },
    h('span', { class: 'mark', 'aria-hidden': 'true' }),
    h('span', { class: 'label', text: 'Stats' }),
  );

  // ---------- panel ----------
  const titleEl = h('h2', { class: 'title', id: 'cst-title', text: 'Case and upgrade stats' });
  const subEl = h('div', { class: 'sub' });
  // Account picker: shown once more than one site account has events (or is signed in).
  const acctEl = h('div', { class: 'acct', hidden: true });
  let acctShown = '';
  const closeBtn = h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close stats panel', on: { click: () => close() } }, iconClose());
  // Running version, and a button once a newer published version is known.
  const verEl = h('span', { class: 'ver' });
  const updBtn = h('button', {
    type: 'button',
    class: 'btn sm primary',
    hidden: true,
    title: 'Opens the Tampermonkey update page',
    on: { click: () => safe(() => o.onOpenUpdate()) },
  });
  const head = h('div', { class: 'head' }, h('div', null, h('div', { class: 'titlerow' }, titleEl, verEl, updBtn), subEl, acctEl), closeBtn);

  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Stats sections' });
  const tabBtns = {};
  for (const [id, label] of TABS) {
    const b = h('button', {
      type: 'button',
      role: 'tab',
      id: `cst-tab-${id}`,
      class: 'tab',
      'aria-controls': 'cst-body',
      text: label,
      on: { click: () => selectTab(id, true) },
    });
    tabBtns[id] = b;
    tabsEl.append(b);
  }
  tabsEl.addEventListener('keydown', (e) => {
    const ids = TABS.map(([id]) => id);
    const i = ids.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') next = ids[0];
    else if (e.key === 'End') next = ids[ids.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next, true);
    }
  });

  const body = h('div', { class: 'body', id: 'cst-body', role: 'tabpanel', tabindex: '0' });
  const panel = h(
    'div',
    { class: 'panel', id: 'cst-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'cst-title', hidden: true },
    head,
    tabsEl,
    body,
  );
  // Keep the site's own hotkeys from reacting to typing inside the panel.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    panel.addEventListener(type, (e) => {
      if (type === 'keydown' && e.key === 'Escape') onEscape(e);
      e.stopPropagation();
    });
  }
  wrap.append(launcher, panel);

  function onEscape(e) {
    if (!state.open) return;
    e.preventDefault();
    if (state.confirmClear) {
      state.confirmClear = false;
      state.pendingFocus = 'clear';
      render();
      return;
    }
    close();
  }
  const onWindowKey = (e) => {
    if (e.key === 'Escape' && state.open) onEscape(e);
  };
  window.addEventListener('keydown', onWindowKey);
  const onResize = debounce(() => state.open && render(), 150);
  window.addEventListener('resize', onResize);
  const reattach = setInterval(() => attach(host), 2000);

  function open() {
    state.open = true;
    state.tabChanged = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    render();
    tabBtns[state.tab].focus();
    doRefresh();
  }

  function close() {
    const hadFocus = root.activeElement && panel.contains(root.activeElement);
    state.open = false;
    state.confirmClear = false;
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    if (hadFocus) launcher.focus();
  }

  function selectTab(id, focus) {
    if (state.tab !== id) {
      state.tab = id;
      state.tabChanged = true;
      state.confirmClear = false;
      store.set('cst.ui.tab', id);
      body.scrollTop = 0;
    }
    render();
    if (focus) tabBtns[id].focus();
    try {
      tabBtns[id].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      /* ignore */
    }
  }

  // ---------- data ----------
  async function doRefresh() {
    if (state.loading) {
      state.again = true;
      return;
    }
    state.loading = true;
    try {
      const ev = await o.getEvents();
      state.events = Array.isArray(ev) ? ev : [];
      state.loadError = null;
    } catch (e) {
      state.loadError = e;
    }
    if (typeof o.getAccounts === 'function') state.accounts = safe(() => o.getAccounts()).value || null;
    // Holdings (cash balance + skin value) for the Money tab. Optional; may be sync or async.
    if (typeof o.getHoldings === 'function') {
      try {
        const hv = await o.getHoldings();
        state.holdings = hv && typeof hv === 'object' ? hv : null;
        state.holdingsError = null;
      } catch (e) {
        state.holdingsError = e;
      }
    }
    state.loading = false;
    state.loaded = true;
    state.cache.clear();
    if (state.open) render();
    if (state.again) {
      state.again = false;
      doRefresh();
    }
  }
  const refresh = debounce(doRefresh, 250);

  // ---------- render ----------
  function contentWidth() {
    const cs = getComputedStyle(body);
    return body.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
  }

  function render() {
    if (!state.open) return;
    const active = root.activeElement;
    const fk = state.pendingFocus || (active && body.contains(active) ? active.dataset.fk : null);
    const caret = active && active.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = body.scrollTop;

    const n = state.events.length;
    let first = null;
    let last = null;
    for (const e of state.events) {
      const ts = num(e.ts);
      if (!ts) continue;
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    subEl.textContent = !state.loaded
      ? 'Loading…'
      : n
        ? `${fmtInt(n)} events, ${fmtDate(first)} ${DASH} ${fmtDate(last)}`
        : 'No events recorded yet';
    renderAccounts();
    const stHead = safe(() => (o.getStatus ? o.getStatus() : {})).value || {};
    verEl.textContent = stHead.version ? `v${stHead.version}` : '';
    const upd = stHead.update;
    const showUpd = !!(upd && upd.newer && typeof o.onOpenUpdate === 'function');
    updBtn.hidden = !showUpd;
    if (showUpd) updBtn.textContent = `Update to v${upd.latest}`;

    for (const [id] of TABS) {
      const sel = id === state.tab;
      tabBtns[id].setAttribute('aria-selected', String(sel));
      tabBtns[id].tabIndex = sel ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `cst-tab-${state.tab}`);

    let content;
    if (!state.loaded) content = [h('p', { class: 'muted', text: 'Loading your events…' })];
    else {
      const views = {
        overview: viewOverview,
        odds: () => viewOdds(ctx),
        cases: viewCases,
        upgrades: viewUpgrades,
        mystery: () => viewMystery(ctx),
        factors: viewFactors,
        money: () => viewMoney(ctx),
        data: viewData,
      };
      try {
        content = (views[state.tab] || viewOverview)();
      } catch (e) {
        console.warn('[caser-tracker] render failed', e);
        content = [errorBox(e)];
      }
      if (state.loadError && state.tab !== 'data') content.unshift(errorBox(state.loadError, 'Could not read stored events'));
    }
    const view = h('div', { class: ['view', state.tabChanged && 'enter'] }, content);
    body.replaceChildren(view);
    if (!state.tabChanged) body.scrollTop = scroll;
    state.tabChanged = false;

    if (fk) {
      const el = body.querySelector(`[data-fk="${fk}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        if (caret && el.tagName === 'INPUT') {
          try {
            el.setSelectionRange(caret[0], caret[1]);
          } catch {
            /* ignore */
          }
        }
      }
    }
    state.pendingFocus = null;
  }

  // Rebuilt only when the choices change, so an open dropdown keeps its focus across refreshes.
  function renderAccounts() {
    const a = state.accounts;
    // Guest view: only the signed-in account, and a way to the owner password.
    if (a && a.guest) {
      if (acctShown === 'guest') return;
      acctShown = 'guest';
      acctEl.hidden = false;
      acctEl.replaceChildren(
        h(
          'div',
          { class: 'acct-guest' },
          h('span', { text: 'Guest view: signed-in account only' }),
          h('button', {
            type: 'button',
            class: 'btn sm',
            text: 'Unlock',
            on: {
              click: () => {
                state.pendingFocus = 'lock-pass';
                selectTab('data', false);
              },
            },
          }),
        ),
      );
      return;
    }
    const list = a && Array.isArray(a.list) ? a.list : [];
    const show = list.length > 1;
    const value = a && a.selected != null ? String(a.selected) : 'all';
    const sig = show ? JSON.stringify([value, list.map((x) => [x.id, x.name, x.events, x.current])]) : '';
    if (sig === acctShown) return;
    acctShown = sig;
    acctEl.hidden = !show;
    if (!show) {
      acctEl.replaceChildren();
      return;
    }
    const current = list.find((x) => x.current);
    const label = (x) => `${x.name}${x.current ? ' (signed in)' : ''}, ${fmtInt(x.events)} events`;
    const select = h(
      'select',
      {
        'aria-label': 'Account',
        title: 'Which site account the stats are for',
        on: {
          change: (e) => {
            const v = e.target.value;
            // Picking the signed-in account means "follow whoever is signed in".
            safe(() => o.selectAccount(current && v === current.id ? 'current' : v));
          },
        },
      },
      list.map((x) => h('option', { value: x.id, selected: x.id === value, text: label(x) })),
      h('option', { value: 'all', selected: value === 'all', text: 'All accounts' }),
    );
    acctEl.replaceChildren(select);
  }

  function versionText(st) {
    const u = st.update;
    const v = st.version || DASH;
    if (!u || !u.available) return v;
    if (u.newer) return `${v}, v${u.latest} available`;
    if (u.error) return `${v}, update check failed: ${u.error}`;
    if (ok(u.checkedAt)) return `${v}, latest (checked ${fmtAgo(u.checkedAt)})`;
    return v;
  }

  // ---------- small view helpers ----------
  function errorBox(err, prefix = 'Could not compute this view') {
    return h('div', { class: 'error', role: 'alert', text: `${prefix}: ${(err && err.message) || err}` });
  }

  function emptyState(title, text, action) {
    return [h('div', { class: 'empty' }, h('div', { class: 'et', text: title }), h('p', { class: 'ed', text }), action || null)];
  }

  function goDataButton() {
    return h('button', { type: 'button', class: 'btn primary', text: 'Go to Data', on: { click: () => selectTab('data', true) } });
  }

  function moneyCell(v, sign = false) {
    return h('td', { class: ['num', sign && signClass(v)], text: fmtMoney(v, '', { sign }) });
  }

  function roiCell(roi, ci) {
    return h(
      'td',
      { class: 'num' },
      h('span', { class: signClass(roi), text: fmtPct(roi, 1, { sign: true }) }),
      ci ? h('span', { class: 'ci', text: fmtCI(ci) }) : null,
    );
  }

  function rateCell(rate, ci) {
    return h('td', { class: 'num' }, fmtPct(rate, 1), ci ? h('span', { class: 'ci', text: fmtCI(ci) }) : null);
  }

  function sigBadge(r) {
    if (!r || !r.n) return h('span', { class: 'faint', text: DASH });
    if (r.n < 10) return h('span', { class: 'badge', text: 'Too few', title: 'Fewer than 10 upgrades in this row' });
    if (r.significant) {
      const below = num(r.winRate) < num(r.expectedRate);
      return h('span', {
        class: ['badge', below ? 'bad' : 'good'],
        text: below ? 'Below odds' : 'Above odds',
        title: `Too large to be luck (${fmtPEq(r.p)}, Holm-corrected)`,
      });
    }
    return h('span', { class: 'badge', text: 'Noise', title: `Within random noise (${fmtPEq(r.p)})` });
  }

  function table(headers, rows, extraClass) {
    return h(
      'div',
      { class: 'tablewrap' },
      h(
        'table',
        { class: extraClass },
        h('thead', null, h('tr', null, headers)),
        h('tbody', null, rows),
      ),
    );
  }

  const th = (text, title) => h('th', { scope: 'col', text, title });

  // Shared helpers for the views that live in views-v2.js.
  const ctx = {
    state,
    memo,
    call,
    cur,
    contentWidth,
    render,
    errorBox,
    emptyState,
    goDataButton,
    table,
    th,
    moneyCell,
    roiCell,
    rateCell,
    sigBadge,
    kpi,
  };

  // ---------- Overview ----------
  function viewOverview() {
    const ev = state.events;
    if (!ev.length) {
      return emptyState(
        'No events yet',
        'Open a case or make an upgrade on the site and it shows up here. You can also import your past history.',
        goDataButton(),
      );
    }
    const c = cur();
    const sum = memo('summary', () => call('summarize', ev));
    if (sum.error) return [errorBox(sum.error)];
    const { total = {}, cases = {}, upgrades = {} } = sum.value || {};
    const out = [];

    out.push(
      h(
        'section',
        null,
        h(
          'div',
          { class: 'hero' },
          h(
            'div',
            null,
            h('div', { class: 'cap', text: 'Total net' }),
            h('div', { class: ['big', 'num', signClass(total.net)], text: fmtMoney(total.net, c, { sign: true }) }),
          ),
          h(
            'div',
            null,
            h('div', { class: 'cap', text: 'ROI', style: { textAlign: 'right' } }),
            h('div', { class: ['roi', 'num', signClass(total.roi)], text: fmtPct(total.roi, 1, { sign: true }) }),
          ),
        ),
        h(
          'div',
          { class: 'kpis' },
          kpi('Spent', fmtMoney(total.cost, c)),
          kpi('Returned', fmtMoney(total.returned, c)),
          kpi('Case drops', fmtInt(cases.n || 0)),
          kpi('Upgrades', fmtInt(upgrades.n || 0)),
        ),
        h(
          'div',
          { class: 'split' },
          kindBox('Cases', cases, c),
          kindBox('Upgrades', upgrades, c),
        ),
      ),
    );

    const series = memo('series', () => cumulative(ev)).value || [];
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Net over time' }),
        series.length >= 2
          ? [lineChart({ points: series, width: contentWidth(), currency: c }), h('p', { class: 'hint', text: 'Each step is one event, oldest on the left.' })]
          : h('p', { class: 'muted', text: 'The chart needs at least two events.' }),
      ),
    );

    out.push(h('section', null, h('h3', { text: 'Do your wins match the shown odds?' }), calibrationBlock(ev)));

    const ses = memo('sessions', () => call('sessions', ev));
    out.push(h('section', null, h('h3', { text: 'Recent sessions' }), ses.error ? errorBox(ses.error) : sessionsList(ses.value || [], c)));
    return out;
  }

  function kpi(k, v) {
    return h('div', { class: 'kpi' }, h('div', { class: 'k', text: k }), h('div', { class: 'v num', text: v, title: v }));
  }

  function kindBox(label, m, c) {
    return h(
      'div',
      { class: 'box' },
      h('div', { class: 'k', text: `${label}: ${fmtInt(m.n || 0)}` }),
      h(
        'div',
        { class: 'v num' },
        h('span', { class: signClass(m.net), text: fmtMoney(m.net, c, { sign: true }) }),
        h('span', { class: 'muted', text: `  ROI ${fmtPct(m.roi, 1, { sign: true })}` }),
      ),
    );
  }

  function calibrationBlock(ev) {
    const cal = memo('calibration', () => call('calibration', ev));
    if (cal.error) return errorBox(cal.error);
    const r = cal.value;
    if (!r || !r.n) {
      return h(
        'div',
        { class: 'callout neutral' },
        h('div', { class: 'headline', text: 'No upgrades yet' }),
        h('p', { class: 'detail', text: 'This check compares how often you win upgrades with the chance the site showed.' }),
      );
    }
    const map = {
      consistent: ['Your wins match the shown odds', 'neutral', 'The gap between your wins and the shown odds is within random noise.'],
      below: ['You win less often than the shown odds', 'bad', 'The gap is too large to be luck.'],
      above: ['You win more often than the shown odds', 'good', 'The gap is too large to be luck. It can still change with more data.'],
    };
    const [headline, tone, note] = map[r.verdict] || map.consistent;
    return h(
      'div',
      { class: ['callout', tone] },
      h('div', { class: 'headline', text: headline }),
      h(
        'p',
        { class: 'detail' },
        `${fmtInt(r.wins)} wins out of ${fmtInt(r.n)} upgrades, ${fmtNumber(r.expectedWins, 1)} expected from the shown odds. ${note}`,
      ),
      h(
        'p',
        { class: 'detail' },
        `z = ${fmtZ(r.z)}, ${fmtPEq(r.p)}`,
        ok(r.impliedRtp) ? `. Upgrades paid back ${fmtPct(r.impliedRtp, 1)} of what you staked.` : '',
      ),
      r.n < 30 ? h('p', { class: 'detail', text: 'Fewer than 30 upgrades: this check is weak for now.' }) : null,
    );
  }

  function sessionsList(list, c) {
    if (!list.length) return h('p', { class: 'muted', text: 'No sessions yet.' });
    const rows = [...list].sort((a, b) => num(b.start) - num(a.start)).slice(0, 10);
    return h(
      'div',
      { class: 'list' },
      rows.map((x) => {
        const kinds = x.kinds || {};
        const parts = [];
        if (kinds.case) parts.push(`${fmtInt(kinds.case)} case ${kinds.case === 1 ? "drop" : "drops"}`);
        if (kinds.upgrade) parts.push(`${fmtInt(kinds.upgrade)} ${kinds.upgrade === 1 ? "upgrade" : "upgrades"}`);
        return h(
          'div',
          { class: 'row' },
          h(
            'div',
            { class: 'l' },
            h('div', { class: 't num', text: `${fmtDateShort(x.start)}, ${fmtTime(x.start)}${DASH}${fmtTime(x.end)}` }),
            h('div', { class: 'd', text: `${parts.join(', ') || `${fmtInt(x.n)} events`} · ${fmtDuration(num(x.end) - num(x.start))}` }),
          ),
          h(
            'div',
            { class: 'r' },
            h('div', { class: ['num', signClass(x.net)], text: fmtMoney(x.net, c, { sign: true }) }),
            h('div', { class: 'd muted num', text: `spent ${fmtMoney(x.cost, c)}`, style: { fontSize: '11.5px' } }),
          ),
        );
      }),
    );
  }

  // ---------- Cases ----------
  const CASE_COLS = [
    { key: 'caseName', label: 'Case', get: (r) => String(r.caseName || r.caseSlug || '').toLowerCase() },
    { key: 'n', label: 'Opens', get: (r) => r.n },
    { key: 'cost', label: 'Spent', get: (r) => r.cost },
    { key: 'returned', label: 'Returned', get: (r) => r.returned },
    { key: 'roi', label: 'ROI', get: (r) => r.roi, title: 'Net divided by spent. Second line: 95% range.' },
    { key: 'hitRate', label: 'Hit rate', get: (r) => r.hitRate, title: 'Share of drops worth at least the case price' },
    { key: 'best', label: 'Best drop', get: (r) => (r.best ? r.best.price : null) },
    { key: 'median', label: 'Median drop', get: (r) => r.median },
  ];

  function viewCases() {
    const ev = state.events;
    if (!ev.some((e) => e.kind === 'case')) {
      return emptyState('No case opens yet', 'Open a case on the site, or import your drop history from the Data tab.', goDataButton());
    }
    const res = memo('caseRoi', () => call('caseRoi', ev));
    if (res.error) return [errorBox(res.error)];
    const rows = [...(res.value || [])];
    const col = CASE_COLS.find((x) => x.key === state.caseSort.key) || CASE_COLS[1];
    const dir = state.caseSort.dir === 1 ? 1 : -1;
    rows.sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      const na = va === null || va === undefined || (typeof va === 'number' && !Number.isFinite(va));
      const nb = vb === null || vb === undefined || (typeof vb === 'number' && !Number.isFinite(vb));
      if (na || nb) return na === nb ? 0 : na ? 1 : -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    const headers = CASE_COLS.map((cdef) => {
      const active = cdef.key === col.key;
      return h(
        'th',
        { scope: 'col', 'aria-sort': active ? (dir === 1 ? 'ascending' : 'descending') : 'none', title: cdef.title },
        h(
          'button',
          {
            type: 'button',
            class: 'sortbtn',
            'data-fk': `sort-${cdef.key}`,
            'aria-label': `Sort by ${cdef.label}`,
            on: {
              click: () => {
                if (state.caseSort.key === cdef.key) state.caseSort = { key: cdef.key, dir: -state.caseSort.dir };
                else state.caseSort = { key: cdef.key, dir: cdef.key === 'caseName' ? 1 : -1 };
                store.set('cst.ui.caseSort', state.caseSort);
                render();
              },
            },
          },
          cdef.label,
          h('span', { class: 'arrow', 'aria-hidden': 'true', text: active ? (dir === 1 ? '↑' : '↓') : '' }),
        ),
      );
    });

    const trs = rows.map((r) =>
      h(
        'tr',
        null,
        h(
          'td',
          { class: 'name', title: r.caseName || r.caseSlug },
          r.caseName || r.caseSlug || 'Unknown case',
          h('span', { class: 'second num', text: r.casePrice ? `${fmtMoney(r.casePrice, '')} per open` : 'free' }),
        ),
        h('td', { class: 'num', text: fmtInt(r.n) }),
        moneyCell(r.cost),
        moneyCell(r.returned),
        roiCell(r.roi, r.roiCI),
        h('td', { class: 'num', text: fmtPct(r.hitRate, 1) }),
        h(
          'td',
          { class: 'num name', title: r.best ? r.best.name : '' },
          r.best ? fmtMoney(r.best.price, '') : DASH,
          r.best ? h('span', { class: 'second', text: r.best.name }) : null,
        ),
        moneyCell(r.median),
      ),
    );

    return [
      h(
        'section',
        null,
        h('div', { class: 'section-head' }, h('h3', { text: 'Return by case' }), h('span', { class: 'muted', text: `Money in ${cur() || 'site currency'}` })),
        table(headers, trs, 'sticky-first'),
        h('p', {
          class: 'hint',
          text: 'The small range under ROI is the 95% interval. A wide range means few opens, so the result can still be luck. Hit rate is the share of drops worth at least the case price.',
        }),
      ),
    ];
  }

  // ---------- Upgrades ----------
  function edgeEditor(kind, label) {
    const cfg = EDGE_CFG[kind];
    const inputId = `cst-edges-${kind}`;
    const errId = `cst-edges-${kind}-err`;
    const apply = () => {
      const r = parseEdges(state.edgeText[kind], cfg.allowInf);
      if (r.error) state.edgeErr[kind] = r.error;
      else {
        state.edges[kind] = r.edges;
        state.edgeText[kind] = edgesToText(r.edges);
        state.edgeErr[kind] = null;
        store.set(cfg.storeKey, state.edgeText[kind]);
      }
      state.pendingFocus = `edges-${kind}`;
      render();
    };
    const reset = () => {
      state.edges[kind] = null;
      state.edgeText[kind] = edgesToText(cfg.def);
      state.edgeErr[kind] = null;
      store.remove(cfg.storeKey);
      state.pendingFocus = `edges-${kind}`;
      render();
    };
    return [
      h(
        'div',
        { class: 'edges' },
        h('label', { for: inputId, text: label }),
        h('input', {
          type: 'text',
          id: inputId,
          value: state.edgeText[kind],
          'data-fk': `edges-${kind}`,
          inputmode: 'decimal',
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-describedby': state.edgeErr[kind] ? errId : null,
          'aria-invalid': state.edgeErr[kind] ? 'true' : null,
          on: {
            input: (e) => (state.edgeText[kind] = e.target.value),
            keydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
            },
          },
        }),
        h('button', { type: 'button', class: 'btn', text: 'Apply', 'data-fk': `apply-${kind}`, on: { click: apply } }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Reset', 'aria-label': `Reset ${kind} edges to default`, on: { click: reset } }),
      ),
      state.edgeErr[kind] ? h('p', { class: 'err', id: errId, role: 'alert', text: state.edgeErr[kind] }) : null,
    ];
  }

  function bucketTable(rows) {
    const visible = rows.filter((r) => r && r.n > 0);
    if (!visible.length) return h('p', { class: 'muted', text: 'No upgrades fall into these buckets.' });
    const c = '';
    return table(
      [
        th('Bucket'),
        th('Upgrades'),
        th('Wins'),
        th('Win rate', 'Second line: 95% Wilson interval'),
        th('Shown chance', 'Average chance the site showed'),
        th('ROI'),
        th('Result', 'Significance after Holm correction'),
      ],
      visible.map((r) =>
        h(
          'tr',
          null,
          h('td', { class: 'num', text: r.label ?? `${r.lo}${DASH}${r.hi}` }),
          h('td', { class: 'num', text: fmtInt(r.n) }),
          h('td', { class: 'num', text: fmtInt(r.wins) }),
          rateCell(r.winRate, r.winRateCI),
          h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
          roiCell(r.roi, null),
          h('td', null, sigBadge(r)),
        ),
      ),
      c,
    );
  }

  function viewUpgrades() {
    const ev = state.events;
    const hasUpgrades = ev.some((e) => e.kind === 'upgrade' && e.status !== 'pending');
    if (!hasUpgrades) {
      return emptyState('No upgrades yet', 'Make an upgrade on the site, or import your upgrade history from the Data tab.', goDataButton());
    }
    const ce = state.edges.chance;
    const se = state.edges.stake;
    const ceKey = ce ? edgesToText(ce) : 'default';
    const seKey = se ? edgesToText(se) : 'default';
    const byChance = memo(`byChance:${ceKey}`, () => (ce ? call('upgradeByChance', ev, ce) : call('upgradeByChance', ev)));
    const byStake = memo(`byStake:${seKey}`, () => (se ? call('upgradeByStake', ev, se) : call('upgradeByStake', ev)));
    const edgeMap = memo(`edgeMap:${ceKey}`, () => (ce ? call('edgeMap', ev, ce) : call('edgeMap', ev)));

    return [
      h(
        'section',
        null,
        h('h3', { text: 'By shown chance' }),
        edgeEditor('chance', 'Edges, %'),
        byChance.error ? errorBox(byChance.error) : bucketTable(byChance.value || []),
      ),
      h(
        'section',
        null,
        h('h3', { text: 'By stake' }),
        edgeEditor('stake', `Edges${cur() ? ', ' + cur() : ''}`),
        byStake.error ? errorBox(byStake.error) : bucketTable(byStake.value || []),
      ),
      h(
        'section',
        null,
        h('h3', { text: 'Shown return vs real return' }),
        edgeMap.error ? errorBox(edgeMap.error) : edgeMapTable(edgeMap.value || []),
        h('p', {
          class: 'hint',
          text: 'Shown RTP is what the shown odds promise per unit staked. Real RTP is what you got back. Below 100% means you lose money on average in that bucket. Win-rate columns above use normal upgrades without the super-drop card; mystery upgrades are on the Mystery tab.',
        }),
      ),
      h(
        'section',
        null,
        h(
          'p',
          { class: 'hint' },
          'Result column: ',
          h('strong', { text: 'Below odds' }),
          ' or ',
          h('strong', { text: 'Above odds' }),
          ' means the gap between your wins and the shown chance is too large to be luck (p below 0.05 after Holm correction). ',
          h('strong', { text: 'Noise' }),
          ' means the gap is what luck alone produces.',
        ),
      ),
    ];
  }

  function edgeMapTable(rows) {
    const visible = rows.filter((r) => r && r.n > 0);
    if (!visible.length) return h('p', { class: 'muted', text: 'No upgrades fall into these buckets.' });
    return table(
      [th('Bucket'), th('Mode'), th('Upgrades'), th('Shown RTP'), th('Real RTP', 'Second line: 95% range')],
      visible.map((r) =>
        h(
          'tr',
          null,
          h('td', { class: 'num', text: r.label ?? DASH }),
          h('td', { text: r.mode || DASH }),
          h('td', { class: 'num', text: fmtInt(r.n) }),
          h('td', { class: 'num', text: fmtPct(r.shownRtp, 1) }),
          h(
            'td',
            { class: 'num' },
            h('span', { class: ok(r.realRtp) ? signClass(r.realRtp - 1) : '', text: fmtPct(r.realRtp, 1) }),
            r.realRtpCI ? h('span', { class: 'ci', text: fmtCI(r.realRtpCI) }) : null,
          ),
        ),
      ),
    );
  }

  // ---------- Factors ----------
  function viewFactors() {
    const ev = state.events;
    const hasUp = ev.some((e) => e.kind === 'upgrade' && e.status !== 'pending');
    const hasCase = ev.some((e) => e.kind === 'case');
    if (!hasUp && !hasCase) {
      return emptyState('Nothing to compare yet', 'Factors compare your results by time, session and bet type. Record some events first.', goDataButton());
    }
    if (state.factorKind === 'upgrade' && !hasUp) state.factorKind = 'case';
    if (state.factorKind === 'case' && !hasCase) state.factorKind = 'upgrade';
    const kind = state.factorKind;
    const choices = FACTORS.filter((f) => f.kinds.includes(kind));
    if (!choices.some((f) => f.key === state.factorKey)) state.factorKey = choices[0].key;
    const fdef = choices.find((f) => f.key === state.factorKey);

    const seg = h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': 'Event kind' },
      [
        ['upgrade', 'Upgrades', hasUp],
        ['case', 'Cases', hasCase],
      ].map(([k, label, enabled]) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(kind === k),
          tabindex: kind === k ? '0' : '-1',
          disabled: !enabled,
          'data-fk': `kind-${k}`,
          text: label,
          on: {
            click: () => setKind(k),
            keydown: (e) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const other = k === 'upgrade' ? 'case' : 'upgrade';
                if ((other === 'case' && hasCase) || (other === 'upgrade' && hasUp)) setKind(other);
              }
            },
          },
        }),
      ),
    );
    function setKind(k) {
      state.factorKind = k;
      store.set('cst.ui.factorKind', k);
      state.pendingFocus = `kind-${k}`;
      render();
    }

    const select = h(
      'select',
      {
        'aria-label': 'Factor',
        'data-fk': 'factor-select',
        on: {
          change: (e) => {
            state.factorKey = e.target.value;
            store.set('cst.ui.factorKey', state.factorKey);
            state.pendingFocus = 'factor-select';
            render();
          },
        },
      },
      choices.map((f) => h('option', { value: f.key, selected: f.key === state.factorKey, text: f.label })),
    );

    const out = [h('div', { class: 'controls' }, seg, select)];
    const res = memo(`factor:${kind}:${fdef.key}`, () => call('factor', ev, fdef.key, { kind }));
    if (res.error) return [...out, errorBox(res.error)];
    const r = res.value || {};
    const rows = (r.rows || []).filter((x) => x && x.n > 0);
    if (!rows.length) {
      out.push(h('p', { class: 'muted', text: `No ${kind === 'upgrade' ? 'upgrades' : 'case opens'} with a value for this factor.` }));
      return out;
    }

    const isUp = kind === 'upgrade';
    const hasAdj = isUp && rows.some((x) => ok(x.zAdj));
    out.push(h('section', null, testCallout(r.test, kind, fdef)));

    if (hasAdj) {
      const bars = rows.map((x) => ({ label: x.label ?? x.value, n: x.n, value: ok(x.zAdj) ? x.zAdj : null, significant: !!x.significantAdj }));
      out.push(
        h(
          'section',
          null,
          h('h3', { text: 'How unusual each row is' }),
          diffBars({
            rows: bars,
            width: contentWidth(),
            clamp: [-6, 6],
            minSpan: 4,
            band: [-1.96, 1.96],
            fmt: (v) => 'z ' + fmtNumber(v, 1, { sign: true }),
            caption: `Adjusted z score per row by ${fdef.label}`,
          }),
          h('p', {
            class: 'hint',
            text: 'Each bar compares the wins in that row with what the real odds curve expects for its bets (z score). The shaded band is ±1.96: anything inside it is ordinary luck. Solid bars stay significant after correction for testing many rows.',
          }),
        ),
      );
    } else {
      const bars = rows.map((x) => {
        if (isUp) {
          const e = num(x.expectedRate);
          if (!(e > 0) || !ok(x.winRate)) return { label: x.label ?? x.value, n: x.n, value: null };
          const ci = x.winRateCI || [];
          return {
            label: x.label ?? x.value,
            n: x.n,
            value: x.winRate / e - 1,
            lo: ok(ci[0]) ? ci[0] / e - 1 : null,
            hi: ok(ci[1]) ? ci[1] / e - 1 : null,
            significant: !!x.significant,
          };
        }
        const ci = x.roiCI || [];
        return { label: x.label ?? x.value, n: x.n, value: x.roi, lo: ci[0], hi: ci[1], significant: !!x.significant };
      });
      out.push(
        h(
          'section',
          null,
          h('h3', { text: isUp ? 'Wins compared with the shown odds' : 'Return per row' }),
          diffBars({
            rows: bars,
            width: contentWidth(),
            caption: isUp ? `Wins relative to shown odds by ${fdef.label}` : `ROI by ${fdef.label}`,
          }),
          h('p', {
            class: 'hint',
            text: isUp
              ? '0 means you won exactly as often as the shown chance says. The line is the 95% range: if it crosses 0, the row is consistent with the shown odds. Solid bars are significant after correction, faded bars are not.'
              : '0 means break even. The line is the 95% range. Solid bars are significant after correction, faded bars are not.',
          }),
        ),
      );
    }

    const c = cur();
    const headers = isUp
      ? [
          th(fdef.label),
          th('Upgrades'),
          th('Win rate', 'Second line: 95% Wilson interval'),
          th('Shown', 'Average shown chance'),
          th('vs shown odds', 'z score of wins against the shown chance; badge is Holm-corrected'),
          hasAdj ? th('vs real odds', 'z score of wins against the real odds curve; badge is Holm-corrected') : null,
          th('ROI'),
          th('Net'),
        ]
      : [th(fdef.label), th('Opens'), th('Spent'), th('ROI'), th('Net')];
    const trs = rows.map((x) =>
      isUp
        ? h(
            'tr',
            null,
            h('td', { text: String(x.label ?? x.value) }),
            h('td', { class: 'num', text: fmtInt(x.n) }),
            rateCell(x.winRate, x.winRateCI),
            h('td', { class: 'num', text: fmtPct(x.expectedRate, 1) }),
            zCell(x.z, x.significant, x.n),
            hasAdj ? zCell(x.zAdj, x.significantAdj, x.n) : null,
            roiCell(x.roi, null),
            moneyCell(x.net, true),
          )
        : h(
            'tr',
            null,
            h('td', { text: String(x.label ?? x.value) }),
            h('td', { class: 'num', text: fmtInt(x.n) }),
            moneyCell(x.cost),
            roiCell(x.roi, x.roiCI),
            moneyCell(x.net, true),
          ),
    );
    out.push(h('section', null, h('div', { class: 'section-head' }, h('h3', { text: 'Table' }), c ? h('span', { class: 'muted', text: `Money in ${c}` }) : null), table(headers, trs)));
    if (isUp) {
      out.push(
        h('p', {
          class: 'hint',
          text: 'Win-rate columns use normal upgrades without the super-drop card (mystery upgrades have no shown chance). "vs real odds" is the fair test: low chances win more often than shown and high chances less, so a row full of low-chance bets looks lucky against the shown odds alone.',
        }),
      );
    }
    return out;
  }

  function zCell(z, significant, n) {
    if (!ok(z)) return h('td', { class: 'num faint', text: DASH });
    let badge;
    if (!(n >= 10)) badge = h('span', { class: 'badge', text: 'Too few' });
    else if (significant) badge = h('span', { class: ['badge', z < 0 ? 'bad' : 'good'], text: z < 0 ? 'Below' : 'Above' });
    else badge = h('span', { class: 'badge', text: 'Noise' });
    return h('td', { class: 'num' }, `z ${fmtNumber(z, 2, { sign: true })}`, h('span', { class: 'second' }, badge));
  }

  function testCallout(t, kind, fdef) {
    if (!t || !ok(t.p)) {
      return h(
        'div',
        { class: 'callout neutral' },
        h('div', { class: 'headline', text: 'Not enough data for a test yet' }),
        h('p', { class: 'detail', text: 'Treat any differences below as random noise for now.' }),
      );
    }
    const isUp = kind === 'upgrade';
    const statName = isUp ? 'χ²' : 'Test statistic';
    const dfText = ok(t.df) ? `, df = ${fmtInt(t.df)}` : '';
    const shownLine = `${statName} = ${fmtNumber(t.statistic, 2)}${dfText}, ${fmtPEq(t.p)}`;
    const useAdj = isUp && ok(t.pAdj);
    const sig = useAdj ? (typeof t.significantAdj === 'boolean' ? t.significantAdj : t.pAdj < 0.05) : !!t.significant;
    const lines = useAdj
      ? [
          `Adjusted for the real odds curve: ${statName} = ${fmtNumber(t.statisticAdj, 2)}${dfText}, ${fmtPEq(t.pAdj)}.`,
          `Against the shown odds only: ${shownLine}.`,
        ]
      : [shownLine];
    const mixNote =
      useAdj && t.significant && !sig
        ? 'Against the shown odds alone this factor looks significant. That comes from the mix of chance levels in each row (low chances win more than shown), not from the factor itself.'
        : null;
    if (!sig) {
      return h(
        'div',
        { class: 'callout neutral', role: 'note' },
        h('div', { class: 'headline', text: 'No real effect: differences are within random noise.' }),
        h('p', {
          class: 'detail',
          text: `The ups and downs between rows are what luck alone produces. Do not plan when or how to play from "${fdef.label}".`,
        }),
        mixNote ? h('p', { class: 'detail', text: mixNote }) : null,
        lines.map((l) => h('p', { class: 'detail', text: l })),
      );
    }
    return h(
      'div',
      { class: 'callout warn', role: 'note' },
      h('div', { class: 'headline', text: 'Possible real effect' }),
      h('p', {
        class: 'detail',
        text:
          fdef.key === 'superDrop'
            ? 'Upgrades with the super-drop card shown win at a different rate. This is a site feature you cannot choose, not a pattern you can time.'
            : `The rows differ more than luck usually explains. With ${FACTORS.length} factors to look at, one can pass this test by chance, so check again after more data before acting on it.`,
      }),
      lines.map((l) => h('p', { class: 'detail', text: l })),
    );
  }

  // ---------- Data ----------
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,.csv,application/json,text/csv',
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
    on: {
      change: (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        run('file', () => o.onImportFile(file), (r) => `Imported ${fmtInt(num(r && r.added))} new events from ${file.name}.`);
      },
    },
  });
  wrap.append(fileInput);

  async function run(name, fn, okText) {
    if (state.busy) return;
    state.busy = name;
    state.lastRun = name;
    state.msg = { text: 'Working…', tone: 'muted' };
    state.pendingFocus = name;
    render();
    try {
      if (typeof fn !== 'function') throw new Error('not available');
      const r = await fn();
      state.msg = { text: okText(r), tone: 'pos' };
    } catch (e) {
      state.msg = { text: `Failed: ${(e && e.message) || e}`, tone: 'neg' };
    }
    state.busy = null;
    state.pendingFocus = name;
    render();
    doRefresh();
  }

  // Cloud sync: one random key shared by all the user's browsers names their common history.
  function cloudSection(cl, btn) {
    const on = !!cl.key;
    const sec = h('section', null, h('h3', { text: 'Sync between browsers' }));
    if (!on) {
      const keyInput = h('input', {
        type: 'text',
        class: 'key-input',
        placeholder: 'Paste the sync key from your other browser',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'Sync key',
        'data-fk': 'cloud-key-input',
        value: state.cloudKeyDraft || '',
        on: { input: (e) => (state.cloudKeyDraft = e.target.value) },
      });
      sec.append(
        h('p', {
          class: 'hint',
          text: 'Keeps one history in every browser you use (Brave, Chrome, another PC). Your events are stored in the tracker\'s cloud database under a secret key. Start in one browser, then paste the key in the others.',
        }),
        h(
          'div',
          { class: 'btns' },
          btn('cloud-start', 'Start cloud sync', 'primary', () =>
            run('cloud-start', () => o.onCloudStart(), () => 'Cloud sync is on. Copy the key into your other browsers.'),
          ),
        ),
        h(
          'div',
          { class: 'btns key-row' },
          keyInput,
          btn('cloud-join', 'Use key', '', () =>
            run('cloud-join', () => o.onCloudJoin(state.cloudKeyDraft), (r) => {
              state.cloudKeyDraft = '';
              return `Cloud sync is on. ${fmtInt(num(r && r.added))} events came from your other browsers.`;
            }),
          ),
        ),
      );
      return sec;
    }

    const stateText =
      cl.state === 'syncing'
        ? `Syncing… ${cl.progress || ''}`
        : cl.state === 'error'
          ? `Failed: ${cl.error}`
          : ok(cl.lastPull)
            ? `Up to date, checked ${fmtAgo(cl.lastPull)}`
            : 'Waiting';
    // Shown in a read-only field: the site turns off text selection on the page, inputs keep it.
    const shown = state.cloudKeyShown
      ? h('input', {
          type: 'text',
          readonly: true,
          class: 'key-input key-shown',
          value: cl.key,
          'aria-label': 'Sync key',
          'data-fk': 'cloud-key-shown',
          spellcheck: 'false',
          on: { focus: (e) => e.target.select(), click: (e) => e.target.select() },
        })
      : `${cl.key.slice(0, 4)}${'•'.repeat(12)}`;
    sec.append(
      h(
        'dl',
        { class: 'status' },
        h('dt', { text: 'Cloud' }),
        h('dd', { class: cl.state === 'error' ? 'neg' : null }, h('span', { class: ['dot', cl.state === 'error' ? 'off' : 'on'], 'aria-hidden': 'true' }), stateText),
        h('dt', { text: 'Sync key' }),
        h('dd', { class: 'num key-text' }, shown),
      ),
      h(
        'div',
        { class: 'btns' },
        btn('cloud-copy', 'Copy key', 'primary', () => {
          const done = (text, tone) => {
            state.msg = { text, tone };
            state.lastRun = null;
            state.pendingFocus = 'cloud-copy';
            render();
          };
          const copied = () => done('Key copied. Paste it in Data → Sync between browsers in your other browser.', 'pos');
          const failed = () => {
            state.cloudKeyShown = true;
            done('Could not copy. The key is shown in the box above: click it, then press Ctrl+C.', 'neg');
          };
          // The userscript manager's clipboard works where the page blocks navigator.clipboard.
          if (typeof o.copyText === 'function' && safe(() => o.copyText(cl.key)).value === true) copied();
          else {
            try {
              navigator.clipboard.writeText(cl.key).then(copied, failed);
            } catch {
              failed();
            }
          }
        }),
        btn('cloud-show', state.cloudKeyShown ? 'Hide key' : 'Show key', '', () => {
          state.cloudKeyShown = !state.cloudKeyShown;
          state.pendingFocus = 'cloud-show';
          render();
        }),
        btn('cloud-sync', 'Sync now', '', () => run('cloud-sync', () => o.onCloudSync(), (r) => `Cloud sync done: ${fmtInt(num(r && r.added))} new events.`), {
          busyLabel: 'Syncing…',
          disabled: cl.state === 'syncing',
        }),
        btn('cloud-stop', 'Stop', '', () => run('cloud-stop', () => o.onCloudStop(), () => 'Cloud sync is off in this browser. The cloud copy is kept.')),
      ),
      h('p', {
        class: 'hint',
        text: 'Anyone with this key can read and change your history, so keep it private. Checks for new events every minute while the tab is open.',
      }),
    );
    return sec;
  }

  // Owner lock: a guest sees only the signed-in account until the owner password is entered.
  function lockSection(lk, btn) {
    const sec = h('section', null, h('h3', { text: 'Owner lock' }));
    const name = lk.accountName || 'this account';
    if (!lk.guest) {
      sec.append(
        h('p', {
          class: 'hint',
          text: lk.trusted
            ? `Unlocked: every account is shown. It stays unlocked while ${name} is signed in on this browser.`
            : 'Unlocked: every account is shown. It locks again when the page reloads or another account signs in.',
        }),
        h('div', { class: 'btns' }, btn('lock-now', 'Lock now', '', () => run('lock-now', () => o.onLock(), () => 'Locked. Only the signed-in account is shown.'))),
      );
      return sec;
    }
    const unlock = () => {
      const pass = state.lockDraft || '';
      state.lockDraft = '';
      run('lock-unlock', () => o.onUnlock(pass, !!state.lockRemember), () => {
        state.lockRemember = false;
        return 'Unlocked. Every account is shown.';
      });
    };
    sec.append(
      h('p', {
        class: 'hint',
        text: lk.accountName
          ? `Guest view: only ${name} is shown. Enter the owner password to see every account.`
          : 'Guest view: sign in on the site to see your account. Enter the owner password to see every account.',
      }),
      h(
        'div',
        { class: 'btns key-row' },
        h('input', {
          type: 'password',
          class: 'key-input',
          placeholder: 'Owner password',
          autocomplete: 'off',
          'aria-label': 'Owner password',
          'data-fk': 'lock-pass',
          value: state.lockDraft || '',
          on: {
            input: (e) => (state.lockDraft = e.target.value),
            keydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                unlock();
              }
            },
          },
        }),
        btn('lock-unlock', 'Unlock', 'primary', unlock, { busyLabel: 'Checking…' }),
      ),
      lk.accountName
        ? h(
            'label',
            { class: 'switch', style: { marginTop: '8px' } },
            h('input', {
              type: 'checkbox',
              checked: !!state.lockRemember,
              'data-fk': 'lock-remember',
              on: { change: (e) => (state.lockRemember = e.target.checked) },
            }),
            h('span', { text: `Stay unlocked while ${name} is signed in on this browser` }),
          )
        : null,
    );
    return sec;
  }

  // Result line of the last Data action. Lock actions show it under the lock, the rest at the bottom.
  const lockRun = () => typeof state.lastRun === 'string' && state.lastRun.startsWith('lock-');
  const msgLine = () => h('p', { class: ['msg', state.msg && state.msg.tone], role: 'status', 'aria-live': 'polite', text: state.msg ? state.msg.text : '' });

  function viewData() {
    const ev = state.events;
    const c = cur();
    const st = safe(() => (o.getStatus ? o.getStatus() : {})).value || {};
    const nCase = ev.filter((e) => e.kind === 'case').length;
    const nUp = ev.filter((e) => e.kind === 'upgrade').length;
    const nDep = ev.filter((e) => e.kind === 'deposit').length;
    const nWd = ev.filter((e) => e.kind === 'withdrawal').length;
    // Export and "Clear all" cover every account, not only the one shown.
    const nAccounts = state.accounts && Array.isArray(state.accounts.list) ? state.accounts.list.length : 1;
    const totalEvents = state.accounts && ok(state.accounts.total) ? state.accounts.total : ev.length;
    const busy = !!state.busy;

    const btn = (name, label, cls, onClick, extra = {}) =>
      h('button', {
        type: 'button',
        class: ['btn', cls],
        'data-fk': name,
        disabled: busy || extra.disabled,
        'aria-busy': state.busy === name ? 'true' : null,
        text: state.busy === name ? extra.busyLabel || 'Working…' : label,
        on: { click: onClick },
      });

    const out = [];
    if (!ev.length) {
      out.push(
        h(
          'section',
          null,
          h(
            'div',
            { class: 'callout' },
            h('div', { class: 'headline', text: 'Nothing recorded yet' }),
            h('p', {
              class: 'detail',
              text: 'Capturing runs on its own while you open cases and upgrade. You can also import the history the site keeps for your account.',
            }),
          ),
        ),
      );
    }
    if (state.loadError) out.push(h('section', null, errorBox(state.loadError, 'Could not read stored events')));
    const lk = st.lock && st.lock.set && typeof o.onUnlock === 'function' ? st.lock : null;
    const isGuest = !!(lk && lk.guest);
    if (lk) {
      const sec = lockSection(lk, btn);
      if (lockRun()) sec.append(msgLine());
      out.push(sec);
    }

    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Status' }),
        h(
          'dl',
          { class: 'status' },
          h('dt', { text: 'Capturing' }),
          h('dd', null, h('span', { class: ['dot', st.capturing ? 'on' : 'off'], 'aria-hidden': 'true' }), st.capturing ? 'On' : 'Off'),
          h('dt', { text: 'Events stored' }),
          h('dd', {
            class: 'num',
            text: `${fmtInt(ev.length)} (${fmtInt(nCase)} case drops, ${fmtInt(nUp)} upgrades${nDep ? `, ${fmtInt(nDep)} deposits` : ''}${nWd ? `, ${fmtInt(nWd)} withdrawals` : ''})`,
          }),
          h('dt', { text: 'Last event' }),
          h('dd', { class: 'num', text: ok(st.lastEventTs) ? `${fmtDateTime(st.lastEventTs)}, ${fmtAgo(st.lastEventTs)}` : 'none yet' }),
          h('dt', { text: 'Last sync' }),
          h('dd', { class: 'num', text: st.syncing ? `Syncing… ${st.syncing}` : ok(st.lastSync) ? `${fmtDateTime(st.lastSync)}, ${fmtAgo(st.lastSync)}` : 'never' }),
          h('dt', { text: 'Storage', title: 'Whether the browser promised not to clear the stored history on its own' }),
          h('dd', { text: st.storagePersisted === true ? 'Kept by the browser' : st.storagePersisted === false ? 'Browser may clear it when space runs low' : DASH }),
          h('dt', { text: 'Unknown responses', title: 'Site responses the parser did not recognise' }),
          h('dd', { class: ['num', num(st.unknownResponses) > 0 && 'neg'], text: fmtInt(num(st.unknownResponses)) }),
          h('dt', { text: 'Version' }),
          h('dd', { class: 'num', text: versionText(st) }),
          c ? [h('dt', { text: 'Currency' }), h('dd', { text: c })] : null,
        ),
      ),
    );

    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Sync' }),
        h(
          'div',
          { class: 'btns' },
          btn(
            'history',
            'Sync with site',
            'primary',
            () => run('history', () => o.onImportHistory(), (r) => `Synced: ${fmtInt(num(r && r.added))} new events from the site.`),
            { busyLabel: 'Syncing…', disabled: !!st.syncing },
          ),
          btn('file', 'Import file', '', () => fileInput.click(), { busyLabel: 'Importing…' }),
        ),
        h('p', {
          class: 'hint',
          text: 'Your history stays stored in this browser. Sync runs on its own when you open the site (at most every 15 minutes) and only fetches what is new. The first sync loads everything and takes several minutes. Import file accepts files from Export JSON.',
        }),
      ),
    );

    if (st.update && st.update.available && typeof o.onCheckUpdate === 'function') {
      const u = st.update;
      out.push(
        h(
          'section',
          null,
          h('h3', { text: 'Updates' }),
          h(
            'div',
            { class: 'btns' },
            u.newer && typeof o.onOpenUpdate === 'function'
              ? btn('update-install', `Install v${u.latest}`, 'primary', () => safe(() => o.onOpenUpdate()))
              : null,
            btn(
              'update-check',
              'Check for updates',
              u.newer ? '' : 'primary',
              () => run('update-check', () => o.onCheckUpdate(), (r) => (r && r.newer ? `Version ${r.latest} is available.` : 'You have the latest version.')),
              { busyLabel: 'Checking…', disabled: !!u.checking },
            ),
          ),
          h('p', {
            class: 'hint',
            text: 'Tampermonkey also checks once a day on its own. Install opens its update page: press Update (or Overwrite), then reload this page.',
          }),
        ),
      );
    }

    if (st.cloud && typeof o.onCloudStart === 'function') out.push(cloudSection(st.cloud, btn));

    const settings = safe(() => (o.getSettings ? o.getSettings() : null)).value;
    if (settings && typeof o.setSetting === 'function') {
      out.push(
        h(
          'section',
          null,
          h('h3', { text: 'Panels' }),
          h(
            'label',
            { class: 'switch' },
            h('input', {
              type: 'checkbox',
              checked: !!settings.upgradeOverlay,
              'data-fk': 'set-overlay',
              on: {
                change: (e) => {
                  safe(() => o.setSetting('upgradeOverlay', e.target.checked));
                  state.pendingFocus = 'set-overlay';
                  render();
                },
              },
            }),
            h('span', { text: 'Upgrade odds card on the upgrade page' }),
          ),
          h('p', {
            class: 'hint',
            text: 'Shows odds, EV and your real win rate for the selected upgrade. It recomputes over your whole history, so turn it off if the upgrade page lags.',
          }),
        ),
      );
    }

    const exp = (format) => {
      state.lastRun = null;
      try {
        if (typeof o.onExport !== 'function') throw new Error('not available');
        o.onExport(format);
        state.msg = { text: `Export ${format.toUpperCase()} started.`, tone: 'muted' };
      } catch (e) {
        state.msg = { text: `Export failed: ${(e && e.message) || e}`, tone: 'neg' };
      }
      state.pendingFocus = `export-${format}`;
      render();
    };
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Export' }),
        h(
          'div',
          { class: 'btns' },
          btn('export-json', 'Export JSON', '', () => exp('json'), { disabled: !totalEvents }),
          btn('export-csv', 'Export CSV', '', () => exp('csv'), { disabled: !totalEvents }),
        ),
        isGuest
          ? h('p', { class: 'hint', text: 'Exports hold only the signed-in account.' })
          : nAccounts > 1
            ? h('p', { class: 'hint', text: 'Exports hold the events of every account. Each event keeps its account id.' })
            : null,
      ),
    );
    // Deleting is for the owner only.
    if (isGuest) {
      if (!lockRun()) out.push(msgLine());
      return out;
    }

    const clearSection = h(
      'section',
      null,
      h('h3', { text: 'Delete data' }),
      btn(
        'clear',
        'Clear all',
        'danger',
        () => {
          state.confirmClear = true;
          state.pendingFocus = 'clear-cancel';
          render();
        },
        { disabled: !totalEvents || state.confirmClear },
      ),
    );
    if (state.confirmClear) {
      clearSection.append(
        h(
          'div',
          { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'cst-confirm-text' },
          h('p', {
            id: 'cst-confirm-text',
            text: `Delete all ${fmtInt(totalEvents)} recorded events${nAccounts > 1 ? ` of all ${nAccounts} accounts` : ''} from this browser? This cannot be undone. Export first if you want a backup.`,
          }),
          h(
            'div',
            { class: 'btns' },
            btn('clear-yes', 'Delete everything', 'danger-solid', () => {
              state.confirmClear = false;
              run('clear', () => o.onClear(), () => 'All events deleted.');
            }),
            btn('clear-cancel', 'Cancel', '', () => {
              state.confirmClear = false;
              state.pendingFocus = 'clear';
              render();
            }),
          ),
        ),
      );
    }
    out.push(clearSection);
    if (!lockRun()) out.push(msgLine());
    return out;
  }

  // ---------- start ----------
  doRefresh();

  return {
    refresh,
    destroy() {
      refresh.cancel();
      onResize.cancel();
      clearInterval(reattach);
      window.removeEventListener('keydown', onWindowKey);
      window.removeEventListener('resize', onResize);
      host.remove();
    },
  };
}
