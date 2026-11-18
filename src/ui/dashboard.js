// Dashboard: launcher button (bottom-left) + right-side drawer.
// Five tabs, plus a settings view behind the gear button in the header.
// Each view leads with the plain answer. Statistics (z, p, intervals, method notes) live in
// tooltips (any element with data-tip) or in "more" expanders, so the first read stays simple.
// Statistics come from the stats server through opts.remote (store/remote-stats.js): every answer is
// {value}, {error} or {loading}, and the panel re-renders when answers arrive.

import { h, s, createHost, attach, store, debounce, safe } from './dom.js';
import { BASE_CSS, DASHBOARD_CSS } from './styles.js';
import { lineChart, diffBars } from './charts.js';
import { viewOdds, viewMystery, viewMoney } from './views-v2.js';
import { viewSessions } from './view-sessions.js';
import {
  fmtMoney,
  fmtNumber,
  fmtInt,
  fmtPct,
  fmtCI,
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
  ['cases', 'Cases'],
  ['upgrades', 'Upgrades'],
  ['money', 'Money'],
  ['factors', 'Factors'],
];
const UP_SUBS = [
  ['odds', 'Odds'],
  ['sessions', 'Sessions'],
  ['mystery', 'Mystery'],
];
// Tabs that became Upgrades sub-views; a saved tab from an older version still opens the right place.
const LEGACY_TABS = { odds: 'odds', sessions: 'sessions', mystery: 'mystery' };

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

const caseNet = (r) => (ok(r.net) ? r.net : num(r.returned) - num(r.cost));
const caseName = (r) => String(r.caseName || r.caseSlug || 'Unknown case');
// [key, label, value, direction]: direction 1 = ascending.
const CASE_SORTS = [
  ['n', 'Most opened', (r) => r.n, -1],
  ['cost', 'Most spent', (r) => r.cost, -1],
  ['net-best', 'Best net', caseNet, -1],
  ['net-worst', 'Worst net', caseNet, 1],
  ['roi-best', 'Best ROI', (r) => r.roi, -1],
  ['roi-worst', 'Worst ROI', (r) => r.roi, 1],
  ['best', 'Best drop', (r) => (r.best ? r.best.price : null), -1],
  ['name', 'Name', (r) => caseName(r).toLowerCase(), 1],
];
const CASE_PAGE = 25;

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

const ICON = { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' };
function iconClose() {
  return s('svg', ICON, s('path', { d: 'M4 4l8 8M12 4l-8 8' }));
}
function iconSettings() {
  return s(
    'svg',
    ICON,
    s('path', { d: 'M2.5 4.5h6M12.5 4.5h1M2.5 11.5h1M7.5 11.5h6' }),
    s('circle', { cx: 10.5, cy: 4.5, r: 1.8 }),
    s('circle', { cx: 5.5, cy: 11.5, r: 1.8 }),
  );
}

export function mountDashboard(opts = {}) {
  const o = opts;
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

  let savedTab = store.get('cst.ui.tab', 'overview');
  let savedSub = store.get('cst.ui.upSub', 'odds');
  if (LEGACY_TABS[savedTab]) {
    savedSub = LEGACY_TABS[savedTab];
    savedTab = 'upgrades';
  }
  const state = {
    open: false,
    tab: TABS.some(([id]) => id === savedTab) ? savedTab : 'overview',
    lastTab: 'overview',
    upSub: UP_SUBS.some(([id]) => id === savedSub) ? savedSub : 'odds',
    loaded: false,
    loading: false,
    again: false,
    loadError: null,
    cache: new Map(),
    caseSort: CASE_SORTS.some(([k]) => k === store.get('cst.ui.caseSort2', 'n')) ? store.get('cst.ui.caseSort2', 'n') : 'n',
    caseOpen: new Set(),
    caseLimit: CASE_PAGE,
    openMore: new Set(),
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

  // Local work that is only redone after a refresh.
  const memo = (key, fn) => {
    if (!state.cache.has(key)) state.cache.set(key, safe(fn));
    return state.cache.get(key);
  };
  /** One statistic from the stats server: {value, stale?} | {error} | {loading: true}. */
  const stat = (name, ...args) => (o.remote ? o.remote.get(name, ...args) : { error: new Error('The stats server is not connected.') });
  /** Counts of the shown account (server view "meta"), or null until they arrive. */
  const counts = () => stat('meta').value || null;
  const loadingBox = () => h('p', { class: 'muted loading', role: 'status', text: 'Loading…' });

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
  const settingsBtn = h(
    'button',
    {
      type: 'button',
      class: 'iconbtn',
      'aria-label': 'Settings and data',
      'aria-pressed': 'false',
      'data-tip': 'Settings and data: sync, import, export, cloud',
      on: { click: () => selectTab(state.tab === 'data' ? state.lastTab : 'data', true) },
    },
    iconSettings(),
  );
  // Running version, and a button once a newer published version is known.
  const verEl = h('span', { class: 'ver' });
  const updBtn = h('button', {
    type: 'button',
    class: 'btn sm primary',
    hidden: true,
    'data-tip': 'Opens the Tampermonkey update page',
    on: { click: () => safe(() => o.onOpenUpdate()) },
  });
  const head = h(
    'div',
    { class: 'head' },
    h('div', { class: 'head-main' }, h('div', { class: 'titlerow' }, titleEl, verEl, updBtn), subEl, acctEl),
    h('div', { class: 'actions' }, settingsBtn, closeBtn),
  );

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
    const i = Math.max(0, ids.indexOf(state.tab));
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

  // ---------- tooltips ----------
  // One shared box, placed next to whichever [data-tip] element is hovered or focused.
  const tipEl = h('div', { class: 'tipbox', role: 'tooltip', id: 'cst-tip', hidden: true });
  let tipAnchor = null;
  function showTip(a) {
    const text = a.getAttribute('data-tip');
    if (!text) return;
    if (tipAnchor && tipAnchor !== a) tipAnchor.removeAttribute('aria-describedby');
    tipAnchor = a;
    a.setAttribute('aria-describedby', 'cst-tip');
    tipEl.textContent = text;
    tipEl.hidden = false;
    const r = a.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pr.left + 8, Math.min(left, pr.right - 8 - tw));
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 8) top = r.top - 6 - th;
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  function hideTip() {
    if (tipAnchor) tipAnchor.removeAttribute('aria-describedby');
    tipAnchor = null;
    tipEl.hidden = true;
  }
  const tipTarget = (e) => (e.target && e.target.closest ? e.target.closest('[data-tip]') : null);
  panel.addEventListener('pointerover', (e) => {
    const a = tipTarget(e);
    if (a === tipAnchor) return;
    if (a) showTip(a);
    else hideTip();
  });
  panel.addEventListener('pointerleave', hideTip);
  panel.addEventListener('focusin', (e) => {
    const a = tipTarget(e);
    if (a) showTip(a);
    else hideTip();
  });
  panel.addEventListener('focusout', hideTip);
  body.addEventListener('scroll', hideTip, { passive: true });

  wrap.append(launcher, panel, tipEl);

  function onEscape(e) {
    if (!state.open) return;
    e.preventDefault();
    if (tipAnchor) {
      hideTip();
      return;
    }
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
  // Answers from the stats server arrive after the render that asked for them: draw again then.
  const unsubscribe = o.remote ? o.remote.subscribe(() => state.open && render()) : () => {};

  function open() {
    state.open = true;
    state.tabChanged = true;
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    render();
    (tabBtns[state.tab] || settingsBtn).focus();
    doRefresh();
  }

  function close() {
    const hadFocus = root.activeElement && panel.contains(root.activeElement);
    hideTip();
    state.open = false;
    state.confirmClear = false;
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    if (hadFocus) launcher.focus();
  }

  function selectTab(id, focus) {
    if (state.tab !== id) {
      if (id === 'data') state.lastTab = state.tab;
      state.tab = id;
      state.tabChanged = true;
      state.confirmClear = false;
      if (id !== 'data') store.set('cst.ui.tab', id);
    }
    render();
    if (focus) (tabBtns[id] || settingsBtn).focus();
  }

  function selectUpSub(id) {
    if (state.tab !== 'upgrades') selectTab('upgrades', false);
    if (state.upSub !== id) {
      state.upSub = id;
      state.tabChanged = true;
      store.set('cst.ui.upSub', id);
    }
    render();
  }

  // ---------- data ----------
  async function doRefresh() {
    if (state.loading) {
      state.again = true;
      return;
    }
    state.loading = true;
    // New events may have reached the server: ask again (old answers stay on screen meanwhile).
    o.remote?.invalidate();
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
    hideTip();
    const active = root.activeElement;
    const fk = state.pendingFocus || (active && body.contains(active) ? active.dataset.fk : null);
    const caret = active && active.tagName === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = body.scrollTop;

    const metaRes = stat('meta');
    const m = metaRes.value || null;
    state.loadError = metaRes.error || o.remote?.lastError() || null;
    subEl.textContent = !m
      ? metaRes.error
        ? 'Stats server unreachable'
        : 'Loading…'
      : m.total
        ? `${fmtInt(m.total)} events · ${fmtDate(m.firstTs)} ${DASH} ${fmtDate(m.lastTs)}`
        : 'No events recorded yet';
    renderAccounts();
    const stHead = safe(() => (o.getStatus ? o.getStatus() : {})).value || {};
    verEl.textContent = stHead.version ? `v${stHead.version}` : '';
    const upd = stHead.update;
    const showUpd = !!(upd && upd.newer && typeof o.onOpenUpdate === 'function');
    updBtn.hidden = !showUpd;
    if (showUpd) updBtn.textContent = `Update to v${upd.latest}`;

    const onData = state.tab === 'data';
    for (const [id] of TABS) {
      const sel = id === state.tab;
      tabBtns[id].setAttribute('aria-selected', String(sel));
      tabBtns[id].tabIndex = sel || (onData && id === state.lastTab) ? 0 : -1;
    }
    settingsBtn.setAttribute('aria-pressed', String(onData));
    if (onData) body.removeAttribute('aria-labelledby');
    else body.setAttribute('aria-labelledby', `cst-tab-${state.tab}`);
    if (onData) body.setAttribute('aria-label', 'Settings and data');
    else body.removeAttribute('aria-label');

    let content;
    if (!m && state.tab !== 'data') content = metaRes.error ? [errorBox(metaRes.error, 'Could not reach the stats server')] : [loadingBox()];
    else {
      const views = {
        overview: viewOverview,
        cases: viewCases,
        upgrades: viewUpgrades,
        money: () => viewMoney(ctx),
        factors: viewFactors,
        data: viewData,
      };
      try {
        content = (views[state.tab] || viewOverview)();
      } catch (e) {
        console.warn('[caser-tracker] render failed', e);
        content = [errorBox(e)];
      }
      if (state.loadError && state.tab !== 'data') content.unshift(errorBox(state.loadError, 'Could not reach the stats server'));
    }
    const view = h('div', { class: ['view', state.tabChanged && 'enter'] }, content);
    body.replaceChildren(view);
    body.scrollTop = state.tabChanged ? 0 : scroll;
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
    const label = (x) => `${x.name}${x.current ? ' (signed in)' : ''} · ${fmtInt(x.events)} events`;
    const select = h(
      'select',
      {
        'aria-label': 'Account',
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

  // ---------- shared building blocks ----------
  function errorBox(err, prefix = 'Could not compute this view') {
    return h('div', { class: 'error', role: 'alert', text: `${prefix}: ${(err && err.message) || err}` });
  }

  function emptyState(title, text, action) {
    return [h('div', { class: 'empty' }, h('div', { class: 'et', text: title }), h('p', { class: 'ed', text }), action || null)];
  }

  function goDataButton() {
    return h('button', { type: 'button', class: 'btn primary', text: 'Import history', on: { click: () => selectTab('data', true) } });
  }

  /** Small "?" button; hover or focus shows the text. */
  function tip(text) {
    if (!text) return null;
    return h('button', { type: 'button', class: 'tip', 'data-tip': text, 'aria-label': 'More info', text: '?' });
  }

  /** Section title with an optional "?" tip and an optional right-hand note. */
  function sectionHead(title, tipText, right) {
    const h3 = h('h3', null, title, tip(tipText));
    if (!right) return h3;
    return h('div', { class: 'section-head' }, h3, typeof right === 'string' ? h('span', { class: 'muted', text: right }) : right);
  }

  /** Collapsible block. Its open state survives re-renders. */
  function more(id, label, ...children) {
    const d = h('details', { class: 'more', open: state.openMore.has(id) }, h('summary', { 'data-fk': `more-${id}`, text: label }), h('div', { class: 'more-body' }, children.flat().map((x) => (typeof x === 'string' ? h('p', { text: x }) : x))));
    d.addEventListener('toggle', () => (d.open ? state.openMore.add(id) : state.openMore.delete(id)));
    return d;
  }

  function callout(tone, headline, ...rest) {
    return h(
      'div',
      { class: ['callout', tone] },
      h('div', { class: 'headline', text: headline }),
      rest.map((x) => (typeof x === 'string' ? h('p', { class: 'detail', text: x }) : x)),
    );
  }

  function linkBtn(text, onClick) {
    return h('button', { type: 'button', class: 'linkbtn', text, on: { click: onClick } });
  }

  /** Segmented radio control. options: [key, label, enabled?]. */
  function seg(name, options, value, onPick, label) {
    const enabled = options.filter((x) => x[2] !== false).map((x) => x[0]);
    return h(
      'div',
      { class: 'seg', role: 'radiogroup', 'aria-label': label },
      options.map(([k, text, en]) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(value === k),
          tabindex: value === k ? '0' : '-1',
          disabled: en === false,
          'data-fk': `${name}-${k}`,
          text,
          on: {
            click: () => pick(k),
            keydown: (e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const i = enabled.indexOf(k);
              pick(enabled[(i + step + enabled.length) % enabled.length]);
            },
          },
        }),
      ),
    );
    function pick(k) {
      state.pendingFocus = `${name}-${k}`;
      onPick(k);
    }
  }

  function kpi(k, v, sub, cls, tipText) {
    return h(
      'div',
      { class: 'kpi' },
      h('div', { class: 'k' }, k, tip(tipText)),
      h('div', { class: ['v', 'num', cls], text: v }),
      sub ? h('div', { class: 's', text: sub }) : null,
    );
  }

  function hero(cap, value, cls, side, capTip) {
    return h(
      'div',
      { class: 'hero' },
      h('div', null, h('div', { class: 'cap' }, cap, tip(capTip)), h('div', { class: ['big', 'num', cls], text: value })),
      side
        ? h('div', { class: 'side' }, h('div', { class: 'cap' }, side.cap, tip(side.tip)), h('div', { class: ['roi', 'num', side.cls], text: side.value }))
        : null,
    );
  }

  function moneyCell(v, sign = false) {
    return h('td', { class: ['num', sign && signClass(v)], text: fmtMoney(v, '', { sign }) });
  }

  function roiCell(roi, ci) {
    return h('td', { class: 'num' }, h('span', { class: signClass(roi), text: fmtPct(roi, 1, { sign: true }), 'data-tip': ci ? `95% range ${fmtCI(ci)}` : null }));
  }

  function rateCell(rate, ci) {
    return h('td', { class: 'num' }, h('span', { text: fmtPct(rate, 1), 'data-tip': ci ? `95% range ${fmtCI(ci)}` : null }));
  }

  function sigBadge(r) {
    if (!r || !r.n) return h('span', { class: 'faint', text: DASH });
    const pText = ok(r.p) ? ` (${fmtPEq(r.p)})` : '';
    if ((r.oddsN ?? r.n) < 10) return h('span', { class: 'badge', text: 'Too few', 'data-tip': 'Fewer than 10 upgrades: too few to judge.' });
    if (r.significant) {
      const below = num(r.winRate) < num(r.expectedRate);
      return h('span', {
        class: ['badge', below ? 'bad' : 'good'],
        text: below ? 'Below odds' : 'Above odds',
        'data-tip': `The gap to the shown chance is too large to be luck${pText}, after correcting for the number of rows checked.`,
      });
    }
    return h('span', { class: 'badge', text: 'Luck', 'data-tip': `The gap to the shown chance is within normal luck${pText}.` });
  }

  function table(headers, rows, extraClass) {
    return h('div', { class: 'tablewrap' }, h('table', { class: extraClass }, h('thead', null, h('tr', null, headers)), h('tbody', null, rows)));
  }

  /** Column header; with tipText the label gets a dotted underline and a tooltip. */
  const th = (text, tipText) => h('th', { scope: 'col' }, tipText ? h('span', { class: 'thtip', 'data-tip': tipText, tabindex: '0', text }) : text);

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

  // Shared helpers for the views in views-v2.js and view-sessions.js.
  const ctx = {
    state,
    memo,
    stat,
    counts,
    loadingBox,
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
    hero,
    tip,
    more,
    callout,
    sectionHead,
    linkBtn,
    edgeEditor,
  };

  // ---------- Overview ----------
  function viewOverview() {
    if (!counts().total) {
      return emptyState('No events yet', 'Open a case or make an upgrade on the site and it shows up here. You can also import your past history.', goDataButton());
    }
    const c = cur();
    const sum = stat('summarize');
    if (sum.loading) return [loadingBox()];
    if (sum.error) return [errorBox(sum.error)];
    const { total = {}, cases = {}, upgrades = {} } = sum.value || {};
    const out = [];

    out.push(
      h(
        'section',
        null,
        hero(
          'Total net',
          fmtMoney(total.net, c, { sign: true }),
          signClass(total.net),
          { cap: 'ROI', value: fmtPct(total.roi, 1, { sign: true }), cls: signClass(total.roi), tip: 'Net divided by everything spent on cases and upgrades.' },
          'Everything returned minus everything spent, over cases and upgrades.',
        ),
        h(
          'div',
          { class: 'kpis' },
          kpi('Spent', fmtMoney(total.cost, c)),
          kpi('Returned', fmtMoney(total.returned, c)),
          kpi(`Cases · ${fmtInt(cases.n || 0)}`, fmtMoney(cases.net, c, { sign: true }), `ROI ${fmtPct(cases.roi, 1, { sign: true })}`, signClass(cases.net)),
          kpi(`Upgrades · ${fmtInt(upgrades.n || 0)}`, fmtMoney(upgrades.net, c, { sign: true }), `ROI ${fmtPct(upgrades.roi, 1, { sign: true })}`, signClass(upgrades.net)),
        ),
      ),
    );

    const seriesRes = stat('cumulative');
    const series = seriesRes.value || [];
    out.push(
      h(
        'section',
        null,
        sectionHead('Net over time', 'Running total of every case open and upgrade, oldest on the left. Hover the chart to read a point.'),
        seriesRes.loading
          ? loadingBox()
          : seriesRes.error
            ? errorBox(seriesRes.error)
            : series.length >= 2
              ? lineChart({ points: series, width: contentWidth(), currency: c, count: (counts().kinds?.case ?? 0) + (counts().settled ?? 0) })
              : h('p', { class: 'muted', text: 'The chart needs at least two events.' }),
      ),
    );

    out.push(h('section', null, sectionHead('Upgrade odds check'), calibrationBlock()));

    const ses = stat('sessions');
    out.push(
      h(
        'section',
        null,
        sectionHead('Recent sessions', 'A session is a stretch of play without a long break.'),
        ses.loading ? loadingBox() : ses.error ? errorBox(ses.error) : sessionsList(ses.value || [], c),
      ),
    );
    return out;
  }

  function calibrationBlock() {
    const cal = stat('calibration');
    if (cal.loading) return loadingBox();
    if (cal.error) return errorBox(cal.error);
    const r = cal.value;
    if (!r || !r.n) return callout('neutral', 'No upgrades yet', 'This check compares how often you win upgrades with the chance the site showed.');
    const map = {
      consistent: ['Your wins match the shown odds', 'neutral', 'The gap is within normal luck.'],
      below: ['You win less often than the shown odds', 'bad', 'The gap is too large to be luck.'],
      above: ['You win more often than the shown odds', 'good', 'The gap is too large to be luck. It can still change with more data.'],
    };
    const [headline, tone, note] = map[r.verdict] || map.consistent;
    return callout(
      tone,
      headline,
      `${fmtInt(r.wins)} wins from ${fmtInt(r.n)} upgrades, ${fmtNumber(r.expectedWins, 1)} expected.${ok(r.impliedRtp) ? ` Upgrades paid back ${fmtPct(r.impliedRtp, 1)} of your stakes.` : ''}`,
      r.n < 30 ? 'Fewer than 30 upgrades: this check is weak for now.' : null,
      more('cal', 'How this is checked', `${note} z = ${fmtZ(r.z)}, ${fmtPEq(r.p)}. The z score counts how far your wins are from the expected wins, in standard deviations; p is the chance of a gap this big from luck alone.`),
      linkBtn('Odds by chance level', () => selectUpSub('odds')),
    );
  }

  function sessionsList(list, c) {
    if (!list.length) return h('p', { class: 'muted', text: 'No sessions yet.' });
    const rows = [...list].sort((a, b) => num(b.start) - num(a.start)).slice(0, 5);
    return h(
      'div',
      { class: 'list' },
      rows.map((x) => {
        const kinds = x.kinds || {};
        const parts = [];
        if (kinds.case) parts.push(`${fmtInt(kinds.case)} ${kinds.case === 1 ? 'case' : 'cases'}`);
        if (kinds.upgrade) parts.push(`${fmtInt(kinds.upgrade)} ${kinds.upgrade === 1 ? 'upgrade' : 'upgrades'}`);
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
            h('div', { class: 'd num', text: `spent ${fmtMoney(x.cost, '')}` }),
          ),
        );
      }),
    );
  }

  // ---------- Cases ----------
  function viewCases() {
    if (!counts().kinds?.case) {
      return emptyState('No case opens yet', 'Open a case on the site, or import your drop history.', goDataButton());
    }
    const res = stat('caseRoi');
    if (res.loading) return [loadingBox()];
    if (res.error) return [errorBox(res.error)];
    const all = [...(res.value || [])];
    const c = cur();

    let opens = 0;
    let cost = 0;
    let returned = 0;
    let best = null;
    for (const r of all) {
      opens += num(r.n);
      cost += num(r.cost);
      returned += num(r.returned);
      if (r.best && ok(r.best.price) && (!best || r.best.price > best.price)) best = r.best;
    }
    const net = returned - cost;
    const roi = cost > 0 ? net / cost : null;

    const [, , get, dir] = CASE_SORTS.find(([k]) => k === state.caseSort) || CASE_SORTS[0];
    all.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va === null || va === undefined || (typeof va === 'number' && !Number.isFinite(va));
      const nb = vb === null || vb === undefined || (typeof vb === 'number' && !Number.isFinite(vb));
      if (na || nb) return na === nb ? 0 : na ? 1 : -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    const shown = all.slice(0, state.caseLimit);

    const sortSel = h(
      'select',
      {
        'aria-label': 'Sort cases',
        'data-fk': 'case-sort',
        on: {
          change: (e) => {
            state.caseSort = e.target.value;
            store.set('cst.ui.caseSort2', state.caseSort);
            state.pendingFocus = 'case-sort';
            render();
          },
        },
      },
      CASE_SORTS.map(([k, label]) => h('option', { value: k, selected: k === state.caseSort, text: label })),
    );

    return [
      h(
        'section',
        null,
        hero('Cases net', fmtMoney(net, c, { sign: true }), signClass(net), { cap: 'ROI', value: fmtPct(roi, 1, { sign: true }), cls: signClass(roi) }),
        h(
          'div',
          { class: 'kpis' },
          kpi('Opens', fmtInt(opens), `${fmtInt(all.length)} ${all.length === 1 ? 'case' : 'cases'}`),
          kpi('Spent', fmtMoney(cost, c)),
          kpi('Returned', fmtMoney(returned, c)),
          kpi('Best drop', best ? fmtMoney(best.price, c) : DASH, best ? best.name : null),
        ),
      ),
      h(
        'section',
        null,
        h('div', { class: 'section-head' }, sectionHead('By case', 'Click a case for its details.'), sortSel),
        h('div', { class: 'list' }, shown.map((r) => caseRow(r, c))),
        all.length > shown.length
          ? h('div', { class: 'list-foot' }, h('span', { class: 'muted', text: `${fmtInt(shown.length)} of ${fmtInt(all.length)}` }), h('button', {
              type: 'button',
              class: 'btn',
              'data-fk': 'case-more',
              text: `Show ${fmtInt(Math.min(CASE_PAGE, all.length - shown.length))} more`,
              on: {
                click: () => {
                  state.caseLimit += CASE_PAGE;
                  state.pendingFocus = 'case-more';
                  render();
                },
              },
            }))
          : null,
      ),
    ];
  }

  function caseRow(r, c) {
    const id = String(r.caseSlug || r.caseName);
    const open = state.caseOpen.has(id);
    const net = caseNet(r);
    const d = h(
      'details',
      { class: 'sess', open },
      h(
        'summary',
        { class: 'row' },
        h(
          'div',
          { class: 'l' },
          h('div', { class: 't', text: caseName(r) }),
          h('div', { class: 'd num', text: `${fmtInt(r.n)} ${r.n === 1 ? 'open' : 'opens'} · ${r.casePrice ? `${fmtMoney(r.casePrice, '')} each` : 'free'}` }),
        ),
        h(
          'div',
          { class: 'r' },
          h('div', { class: ['num', signClass(net)], text: fmtMoney(net, c, { sign: true }) }),
          h('div', { class: 'd num', text: `ROI ${fmtPct(r.roi, 1, { sign: true })}` }),
        ),
      ),
      open
        ? h(
            'div',
            { class: 'sess-body' },
            h(
              'div',
              { class: 'kpis k3' },
              kpi('Spent', fmtMoney(r.cost, '')),
              kpi('Returned', fmtMoney(r.returned, '')),
              kpi('Hit rate', fmtPct(r.hitRate, 1), null, null, 'Share of drops worth at least the case price.'),
              kpi('Median drop', fmtMoney(r.median, '')),
              kpi('Best drop', r.best ? fmtMoney(r.best.price, '') : DASH, r.best ? r.best.name : null),
              kpi('ROI range', r.roiCI ? fmtCI(r.roiCI, 0) : DASH, null, null, '95% range of the true ROI. A wide range means few opens: the result can still be luck.'),
            ),
          )
        : null,
    );
    d.addEventListener('toggle', () => {
      if (d.open === state.caseOpen.has(id)) return;
      if (d.open) state.caseOpen.add(id);
      else state.caseOpen.delete(id);
      render();
    });
    return d;
  }

  // ---------- Upgrades ----------
  function viewUpgrades() {
    const m = counts();
    if (!m.settled) {
      return emptyState('No upgrades yet', 'Make an upgrade on the site, or import your upgrade history.', goDataButton());
    }
    const hasNormal = m.settledNormal > 0;
    const hasMystery = m.settledMystery > 0;
    if (state.upSub === 'mystery' && !hasMystery) state.upSub = 'odds';
    if (state.upSub !== 'mystery' && !hasNormal && hasMystery) state.upSub = 'mystery';
    const nav = h(
      'div',
      { class: 'subnav' },
      seg(
        'up',
        UP_SUBS.map(([k, label]) => [k, label, k === 'mystery' ? hasMystery : hasNormal]),
        state.upSub,
        (k) => selectUpSub(k),
        'Upgrade view',
      ),
    );
    const views = { odds: () => viewOdds(ctx), sessions: () => viewSessions(ctx), mystery: () => viewMystery(ctx) };
    let content;
    try {
      content = views[state.upSub]();
    } catch (e) {
      console.warn('[caser-tracker] render failed', e);
      content = [errorBox(e)];
    }
    return [nav, ...content];
  }

  // ---------- Factors ----------
  function viewFactors() {
    const m = counts();
    const hasUp = m.settled > 0;
    const hasCase = (m.kinds?.case ?? 0) > 0;
    if (!hasUp && !hasCase) {
      return emptyState('Nothing to compare yet', 'Factors compare your results by time, session and bet type. Record some events first.', goDataButton());
    }
    if (state.factorKind === 'upgrade' && !hasUp) state.factorKind = 'case';
    if (state.factorKind === 'case' && !hasCase) state.factorKind = 'upgrade';
    const kind = state.factorKind;
    const choices = FACTORS.filter((f) => f.kinds.includes(kind));
    if (!choices.some((f) => f.key === state.factorKey)) state.factorKey = choices[0].key;
    const fdef = choices.find((f) => f.key === state.factorKey);

    const kindSeg = seg(
      'kind',
      [
        ['upgrade', 'Upgrades', hasUp],
        ['case', 'Cases', hasCase],
      ],
      kind,
      (k) => {
        state.factorKind = k;
        store.set('cst.ui.factorKind', k);
        render();
      },
      'Event kind',
    );
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

    const out = [
      h('p', { class: 'hint', style: { margin: '0 0 12px' }, text: 'Does anything (time of day, streaks, bet size…) change your results? Pick a factor.' }),
      h('div', { class: 'controls' }, kindSeg, select),
    ];
    const res = stat('factor', fdef.key, { kind });
    if (res.loading) return [...out, loadingBox()];
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

    let bars;
    let chartTip;
    let caption;
    if (hasAdj) {
      bars = rows.map((x) => ({ label: x.label ?? x.value, n: x.n, value: ok(x.zAdj) ? x.zAdj : null, significant: !!x.significantAdj }));
      chartTip =
        'Each bar compares the wins in that row with what the real odds curve expects for its bets (z score). Inside the shaded band (±1.96) is ordinary luck. Solid bars stay significant after correcting for the number of rows.';
      caption = `Adjusted z score per row by ${fdef.label}`;
    } else {
      bars = rows.map((x) => {
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
      chartTip = isUp
        ? '0 means you won exactly as often as the shown chance says. The line is the 95% range: if it crosses 0, the row matches the shown odds. Solid bars are significant, faded ones are not.'
        : '0 means break even. The line is the 95% range. Solid bars are significant, faded ones are not.';
      caption = isUp ? `Wins relative to shown odds by ${fdef.label}` : `ROI by ${fdef.label}`;
    }
    out.push(
      h(
        'section',
        null,
        sectionHead(hasAdj ? 'How unusual each row is' : isUp ? 'Wins vs shown odds' : 'Return per row', chartTip),
        diffBars(
          hasAdj
            ? { rows: bars, width: contentWidth(), clamp: [-6, 6], minSpan: 4, band: [-1.96, 1.96], fmt: (v) => 'z ' + fmtNumber(v, 1, { sign: true }), caption }
            : { rows: bars, width: contentWidth(), caption },
        ),
      ),
    );

    const c = cur();
    const headers = isUp
      ? [
          th(fdef.label),
          th('Upgrades'),
          th('Won', 'Your real win rate. Hover a value for its 95% range.'),
          th('Shown', 'Average chance the site showed'),
          th('Result', hasAdj ? 'Checked against the real odds curve, corrected for the number of rows' : 'Checked against the shown odds, corrected for the number of rows'),
          th('Net'),
        ]
      : [th(fdef.label), th('Opens'), th('Spent'), th('ROI', 'Hover a value for its 95% range'), th('Net')];
    const trs = rows.map((x) =>
      isUp
        ? h(
            'tr',
            null,
            h('td', { text: String(x.label ?? x.value) }),
            h('td', { class: 'num', text: fmtInt(x.n) }),
            rateCell(x.winRate, x.winRateCI),
            h('td', { class: 'num', text: fmtPct(x.expectedRate, 1) }),
            h('td', null, hasAdj ? zBadge(x.zAdj, x.significantAdj, x.n, 'real odds') : zBadge(x.z, x.significant, x.n, 'shown odds')),
            moneyCell(x.net, true),
          )
        : h('tr', null, h('td', { text: String(x.label ?? x.value) }), h('td', { class: 'num', text: fmtInt(x.n) }), moneyCell(x.cost), roiCell(x.roi, x.roiCI), moneyCell(x.net, true)),
    );
    out.push(
      h(
        'section',
        null,
        sectionHead('Table', null, c ? `Money in ${c}` : null),
        table(headers, trs),
        isUp
          ? more(
              'factor-note',
              'About these numbers',
              'Win rates use normal upgrades without the super-drop card (mystery upgrades have no shown chance).',
              hasAdj
                ? 'Result uses the real odds curve: low chances win more often than shown and high chances less, so a row full of low-chance bets looks lucky against the shown odds alone.'
                : null,
            )
          : null,
      ),
    );
    return out;
  }

  function zBadge(z, significant, n, against) {
    if (!ok(z)) return h('span', { class: 'faint', text: DASH });
    const zt = `z = ${fmtNumber(z, 2, { sign: true })} against the ${against}.`;
    if (!(n >= 10)) return h('span', { class: 'badge', text: 'Too few', 'data-tip': `Fewer than 10 upgrades. ${zt}` });
    if (significant) return h('span', { class: ['badge', z < 0 ? 'bad' : 'good'], text: z < 0 ? 'Below' : 'Above', 'data-tip': `Too far from the odds to be luck. ${zt}` });
    return h('span', { class: 'badge', text: 'Luck', 'data-tip': `Within normal luck. ${zt}` });
  }

  function testCallout(t, kind, fdef) {
    if (!t || !ok(t.p)) return callout('neutral', 'Not enough data for a test yet', 'Treat any differences below as random noise for now.');
    const isUp = kind === 'upgrade';
    const statName = isUp ? 'χ²' : 'Test statistic';
    const dfText = ok(t.df) ? `, df = ${fmtInt(t.df)}` : '';
    const shownLine = `${statName} = ${fmtNumber(t.statistic, 2)}${dfText}, ${fmtPEq(t.p)}`;
    const useAdj = isUp && ok(t.pAdj);
    const sig = useAdj ? (typeof t.significantAdj === 'boolean' ? t.significantAdj : t.pAdj < 0.05) : !!t.significant;
    const lines = useAdj
      ? [`Adjusted for the real odds curve: ${statName} = ${fmtNumber(t.statisticAdj, 2)}${dfText}, ${fmtPEq(t.pAdj)}.`, `Against the shown odds only: ${shownLine}.`]
      : [`${shownLine}.`];
    if (useAdj && t.significant && !sig) {
      lines.push('Against the shown odds alone this factor looks significant. That comes from the mix of chance levels in each row (low chances win more than shown), not from the factor itself.');
    }
    const details = more('factor-test', 'Test details', ...lines);
    if (!sig) {
      return callout('neutral', 'No real effect', `The differences between rows are normal luck. "${fdef.label}" does not change your results.`, details);
    }
    return callout(
      'warn',
      'Possible real effect',
      fdef.key === 'superDrop'
        ? 'Upgrades with the super-drop card shown win at a different rate. This is a site feature you cannot choose, not a pattern you can time.'
        : `The rows differ more than luck usually explains. With ${FACTORS.length} factors to look at, one can pass by chance, so check again after more data.`,
      details,
    );
  }

  // ---------- Settings and data ----------
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

  function card(title, desc, ...children) {
    return h('div', { class: 'card' }, h('div', { class: 'ct', text: title }), desc ? h('p', { class: 'cd', text: desc }) : null, children);
  }

  // The sync key: a random name for this history on the stats server. Every browser that holds it
  // shows and adds to the same history.
  function cloudCard(cl, btn) {
    const keyInput = h('input', {
      type: 'text',
      class: 'key-input',
      placeholder: 'Paste the sync key from your other browser',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Sync key from another browser',
      'data-fk': 'cloud-key-input',
      value: state.cloudKeyDraft || '',
      on: { input: (e) => (state.cloudKeyDraft = e.target.value) },
    });
    if (!cl.key) {
      return card('Your history on the server', 'Preparing your sync key…');
    }
    const stateText =
      cl.state === 'syncing'
        ? `Working… ${cl.progress || ''}`
        : cl.state === 'error'
          ? `Failed: ${cl.error}`
          : ok(cl.lastPush) || ok(cl.lastPull)
            ? `Up to date, checked ${fmtAgo(Math.max(num(cl.lastPush), num(cl.lastPull)))}`
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
    return card(
      'Your history on the server',
      'Your events are stored on the tracker\'s server under this key, and the statistics are computed there. Keep a copy of the key: without it the history cannot be reached.',
      h(
        'dl',
        { class: 'status' },
        h('dt', { text: 'Server' }),
        h('dd', { class: cl.state === 'error' ? 'neg' : null }, h('span', { class: ['dot', cl.state === 'error' ? 'off' : 'on'], 'aria-hidden': 'true' }), stateText),
        h('dt', null, 'Sync key', tip('Anyone with this key can read and change your history, so keep it private. Paste it into your other browsers to see the same history there.')),
        h('dd', { class: 'num key-text' }, shown),
      ),
      h(
        'div',
        { class: 'btns', style: { marginTop: '12px' } },
        btn('cloud-copy', 'Copy key', 'primary', () => {
          const done = (text, tone) => {
            state.msg = { text, tone };
            state.lastRun = null;
            state.pendingFocus = 'cloud-copy';
            render();
          };
          const copied = () => done('Key copied. Keep it somewhere safe, and paste it below in your other browsers.', 'pos');
          const failed = () => {
            state.cloudKeyShown = true;
            done('Could not copy. The key is shown above: click it, then press Ctrl+C.', 'neg');
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
        btn('cloud-sync', 'Check now', '', () => run('cloud-sync', () => o.onCloudSync(), () => 'Everything recorded here is on the server.'), {
          busyLabel: 'Checking…',
          disabled: cl.state === 'syncing',
        }),
      ),
      h(
        'div',
        { class: 'btns key-row' },
        keyInput,
        btn('cloud-join', 'Use this key', '', () =>
          run('cloud-join', () => o.onCloudJoin(state.cloudKeyDraft), () => {
            state.cloudKeyDraft = '';
            return 'This browser now shows the history of that key.';
          }),
        ),
      ),
    );
  }

  // Owner lock: a guest sees only the signed-in account until the owner password is entered.
  function lockCard(lk, btn) {
    const name = lk.accountName || 'this account';
    if (!lk.guest) {
      return card(
        'Owner lock',
        lk.trusted
          ? `Unlocked: every account is shown. It stays unlocked while ${name} is signed in on this browser.`
          : 'Unlocked: every account is shown. It locks again when the page reloads or another account signs in.',
        h('div', { class: 'btns' }, btn('lock-now', 'Lock now', '', () => run('lock-now', () => o.onLock(), () => 'Locked. Only the signed-in account is shown.'))),
      );
    }
    const unlock = () => {
      const pass = state.lockDraft || '';
      state.lockDraft = '';
      run('lock-unlock', () => o.onUnlock(pass, !!state.lockRemember), () => {
        state.lockRemember = false;
        return 'Unlocked. Every account is shown.';
      });
    };
    return card(
      'Owner lock',
      lk.accountName ? `Guest view: only ${name} is shown. Enter the owner password to see every account.` : 'Guest view: sign in on the site to see your account. Enter the owner password to see every account.',
      h(
        'div',
        { class: 'btns' },
        h('input', {
          type: 'password',
          class: 'key-input',
          style: { flex: '1 1 200px', minWidth: '0' },
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
            { class: 'switch', style: { marginTop: '10px' } },
            h('input', { type: 'checkbox', checked: !!state.lockRemember, 'data-fk': 'lock-remember', on: { change: (e) => (state.lockRemember = e.target.checked) } }),
            h('span', { text: `Stay unlocked while ${name} is signed in on this browser` }),
          )
        : null,
    );
  }

  // Result line of the last action. Lock and update actions show it under their card, the rest at the bottom.
  const lockRun = () => typeof state.lastRun === 'string' && state.lastRun.startsWith('lock-');
  const updateRun = () => state.lastRun === 'update-check';
  const msgLine = () => h('p', { class: ['msg', state.msg && state.msg.tone], role: 'status', 'aria-live': 'polite', text: state.msg ? state.msg.text : '' });

  function viewData() {
    const c = cur();
    const st = safe(() => (o.getStatus ? o.getStatus() : {})).value || {};
    const m = counts() || { total: 0, kinds: {} };
    const count = (k) => m.kinds?.[k] ?? 0;
    const nCase = count('case');
    const nUp = count('upgrade');
    const nDep = count('deposit');
    const nWd = count('withdrawal');
    // Export and "Clear all" cover every account, not only the one shown.
    const nAccounts = state.accounts && Array.isArray(state.accounts.list) ? state.accounts.list.length : 1;
    const totalEvents = state.accounts && ok(state.accounts.total) ? state.accounts.total : m.total;
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

    const out = [h('h2', { class: 'view-title', text: 'Settings and data' })];
    if (state.loadError) out.push(h('section', null, errorBox(state.loadError, 'Could not reach the stats server')));
    const lk = st.lock && st.lock.set && typeof o.onUnlock === 'function' ? st.lock : null;
    const isGuest = !!(lk && lk.guest);
    if (lk && lk.guest) out.push(h('section', null, lockCard(lk, btn), lockRun() ? msgLine() : null));

    // Updates first, so a new version is the first thing seen.
    if (st.update && st.update.available && typeof o.onCheckUpdate === 'function') {
      const u = st.update;
      out.push(
        h(
          'section',
          null,
          card(
            'Updates',
            u.newer ? `Version ${u.latest} is available. Install opens Tampermonkey: press Update, then reload this page.` : `You run ${versionText(st)}. Tampermonkey also checks once a day.`,
            h(
              'div',
              { class: 'btns' },
              u.newer && typeof o.onOpenUpdate === 'function' ? btn('update-install', `Install v${u.latest}`, 'primary', () => safe(() => o.onOpenUpdate())) : null,
              btn(
                'update-check',
                'Check for updates',
                '',
                () => run('update-check', () => o.onCheckUpdate(), (r) => (r && r.newer ? `Version ${r.latest} is available.` : 'You have the latest version.')),
                { busyLabel: 'Checking…', disabled: !!u.checking },
              ),
            ),
          ),
          updateRun() ? msgLine() : null,
        ),
      );
    }

    // Status
    out.push(
      h(
        'section',
        null,
        sectionHead('Status'),
        h(
          'div',
          { class: 'card' },
          h(
            'dl',
            { class: 'status' },
            h('dt', { text: 'Recording' }),
            h('dd', null, h('span', { class: ['dot', st.capturing ? 'on' : 'off'], 'aria-hidden': 'true' }), st.capturing ? 'On' : 'Off'),
            h('dt', { text: 'Events stored' }),
            h('dd', {
              class: 'num',
              'data-tip': `${fmtInt(nCase)} case opens, ${fmtInt(nUp)} upgrades, ${fmtInt(nDep)} deposits, ${fmtInt(nWd)} withdrawals`,
              text: fmtInt(m.total),
            }),
            h('dt', { text: 'Last event' }),
            h('dd', { class: 'num', text: ok(st.lastEventTs) ? fmtAgo(st.lastEventTs) : 'none yet', 'data-tip': ok(st.lastEventTs) ? fmtDateTime(st.lastEventTs) : null }),
            h('dt', { text: 'Last site sync' }),
            h('dd', {
              class: 'num',
              text: st.syncing ? `Syncing… ${st.syncing}` : ok(st.lastSync) ? fmtAgo(st.lastSync) : 'never',
              'data-tip': !st.syncing && ok(st.lastSync) ? fmtDateTime(st.lastSync) : null,
            }),
          ),
          more(
            'status-more',
            'More details',
            h(
              'dl',
              { class: 'status' },
              h('dt', null, 'Unknown responses', tip('Site responses the parser did not recognise. Above 0 can mean the site changed.')),
              h('dd', { class: ['num', num(st.unknownResponses) > 0 && 'neg'], text: fmtInt(num(st.unknownResponses)) }),
              h('dt', { text: 'Version' }),
              h('dd', { class: 'num', text: versionText(st) }),
              c ? [h('dt', { text: 'Currency' }), h('dd', { text: c })] : null,
            ),
          ),
        ),
      ),
    );

    // History
    const sync = [
      card(
        'Your history',
        'Read from the site on its own when you open it, at most every 15 minutes, and stored on the tracker server. The first sync takes a few minutes.',
        h(
          'div',
          { class: 'btns' },
          btn('history', 'Sync with site', 'primary', () => run('history', () => o.onImportHistory(), (r) => `Synced: ${fmtInt(num(r && r.added))} new events from the site.`), {
            busyLabel: 'Syncing…',
            disabled: !!st.syncing,
          }),
          btn('file', 'Import file', '', () => fileInput.click(), { busyLabel: 'Importing…' }),
        ),
      ),
    ];
    if (st.cloud && typeof o.onCloudJoin === 'function') sync.push(cloudCard(st.cloud, btn));
    out.push(h('section', null, sectionHead('History and sync'), sync));

    // Preferences
    const prefs = [];
    const settings = safe(() => (o.getSettings ? o.getSettings() : null)).value;
    if (settings && typeof o.setSetting === 'function') {
      prefs.push(
        card(
          'Upgrade odds card',
          'Shows odds, EV and your real win rate on the upgrade page. Turn it off if the upgrade page lags.',
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
            h('span', { text: 'Show the card' }),
          ),
        ),
      );
    }
    if (lk && !lk.guest) prefs.push(lockCard(lk, btn));
    if (prefs.length) out.push(h('section', null, sectionHead('Preferences'), prefs, lk && !lk.guest && lockRun() ? msgLine() : null));

    // Export and delete
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
    const backup = [
      card(
        'Export',
        isGuest ? 'Exports hold only the signed-in account.' : nAccounts > 1 ? 'Exports hold the events of every account.' : 'Download a backup of your history.',
        h('div', { class: 'btns' }, btn('export-json', 'Export JSON', '', () => exp('json'), { disabled: !totalEvents }), btn('export-csv', 'Export CSV', '', () => exp('csv'), { disabled: !totalEvents })),
      ),
    ];
    if (!isGuest) {
      const del = card(
        'Delete data',
        'Removes every recorded event from the server, for every browser that uses this sync key.',
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
        del.append(
          h(
            'div',
            { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'cst-confirm-text' },
            h('p', {
              id: 'cst-confirm-text',
              text: `Delete all ${fmtInt(totalEvents)} recorded events${nAccounts > 1 ? ` of all ${nAccounts} accounts` : ''} from the server? Every browser with this sync key loses them. This cannot be undone. Export first if you want a backup.`,
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
      backup.push(del);
    }
    out.push(h('section', null, sectionHead('Backup'), backup));
    if (!lockRun() && !updateRun()) out.push(msgLine());
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
      unsubscribe();
      window.removeEventListener('keydown', onWindowKey);
      window.removeEventListener('resize', onResize);
      host.remove();
    },
  };
}
