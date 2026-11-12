// Exchange panel: while the site's "Item replacement" modal is open, ranks the offered items by the money they
// really sell for on CSFloat: the median of recent sales without outliers ("typical") or its 25th percentile
// ("fast sale"), after CSFloat's seller fee. Sales in the last 30 days and active listings show liquidity, a
// sparkline shows recent sales, and opening a row shows every recent sale on a chart. Clicking a row also selects
// that item in the site's modal; it never confirms the replacement.

import { h, s, createHost, attach, store } from './dom.js';
import { BASE_CSS, EXCHANGE_CSS } from './styles.js';
import { fmtMoney, fmtNumber, fmtInt, fmtPct, fmtAgo, signClass, DASH } from './format.js';
import { salesChart, salesSparkline } from './charts.js';
import { expandPoints, marketUrl, CSFLOAT_SELLER_FEE } from '../prices/csfloat.js';

const COLLAPSED_KEY = 'cst.ui.exchangeCollapsed';
const SORT_KEY = 'cst.ui.exchangeSort';
const BASIS_KEY = 'cst.ui.exchangeBasis';
const MIN_SALES_KEY = 'cst.ui.exchangeMinSales';
const POLL_MS = 500;

const okNum = (v) => typeof v === 'number' && Number.isFinite(v);
const usd = (v, opts) => (okNum(v) ? (v < 0 ? '−$' : opts?.sign && v > 0 ? '+$' : '$') + fmtNumber(Math.abs(v), 2) : DASH);
const feePct = `${fmtNumber(CSFLOAT_SELLER_FEE * 100, 0)}%`;

function icon(d) {
  return s('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s('path', { d }));
}

/** Sales in the last 30 days, with "+" when CSFloat's list of sales is full and every one of them is that recent. */
const sold30 = (m) => `${fmtInt(m.sales30d)}${m.salesCapped ? '+' : ''}`;

function splitText(m) {
  const sp = m?.split;
  if (!sp) return null;
  return `Two price groups: ${fmtPct(sp.lowShare, 0)} of sales at ${usd(sp.lowMin)}–${usd(sp.lowMax)}, the rest at ${usd(sp.highMin)}–${usd(sp.highMax)} (pattern, phase or float). Prices use the lower group; the upper group is upside you only see once you hold the item.`;
}

function sourceText(m) {
  if (!m) return '';
  if (m.source === 'sales') return `median of ${m.used} ${m.split ? 'lower-group ' : ''}sales in the last ${m.windowDays} days`;
  if (m.source === 'reference') return 'CSFloat base price (fewer than 3 recent sales)';
  if (m.source === 'last') return 'last sale only';
  return 'no CSFloat sales';
}

/** Trend as a short colored label, or null when there is no trend or it is under 1%. */
function trendTag(m) {
  if (!m || !okNum(m.trend) || Math.abs(m.trend) < 0.01) return null;
  return h('span', { class: signClass(m.trend), title: 'Median of the last 14 days against days 14 to 90', text: `${m.trend > 0 ? '▲' : '▼'}${fmtPct(Math.abs(m.trend), 1)}` });
}

/** Sales chart plus the numbers behind the sell price for one item. */
function detail(name, m, basis, width) {
  if (!m) return h('div', { class: 'detail' }, h('p', { class: 'faint', text: 'Loading CSFloat sales…' }));
  const stat = (k, v, extra) => h('div', { class: 'st' }, h('div', { class: 'k', text: k }), h('div', { class: 'v num' }, v, extra ?? null));
  const fmtRange = okNum(m.low) && okNum(m.high) ? `${usd(m.low)} – ${usd(m.high)}` : DASH;
  return h(
    'div',
    { class: 'detail' },
    salesChart({ points: expandPoints(m.pts), typical: m.source === 'sales' ? m.value : null, fast: m.source === 'sales' ? m.quick : null, base: m.basePrice, upper: m.split?.upper ?? null, width, height: 130 }),
    m.split ? h('p', { class: 'warnline', text: splitText(m) }) : null,
    h(
      'div',
      { class: 'stats' },
      stat('You get, typical', usd(m.net), basis === 'typical' ? h('span', { class: 'tag', text: 'ranked' }) : null),
      stat('You get, fast sale', usd(m.quickNet), basis === 'fast' ? h('span', { class: 'tag', text: 'ranked' }) : null),
      stat('Listed now', okNum(m.listings) ? fmtInt(m.listings) : DASH),
      stat('Typical price', usd(m.value)),
      stat('Fast-sale price', usd(m.quick)),
      stat('CSFloat base', usd(m.basePrice)),
      stat('Range of used sales', fmtRange),
      stat('Trend 14 d', okNum(m.trend) ? h('span', { class: signClass(m.trend), text: fmtPct(m.trend, 1, { sign: true }) }) : DASH),
      stat('Sold 7 d / 30 d', `${fmtInt(m.sales7d)}${m.salesCapped && m.sales7d === m.n ? '+' : ''} / ${sold30(m)}`),
    ),
    h(
      'div',
      { class: 'dfoot' },
      h('span', { class: 'faint', text: `Typical = ${sourceText(m)}. You get = price minus CSFloat's ${feePct} seller fee.` }),
      h('a', { href: marketUrl(name), target: '_blank', rel: 'noopener noreferrer', on: { click: (e) => e.stopPropagation() }, text: 'Listings ↗' }),
    ),
  );
}

/**
 * @param {{
 *   isOpen: () => boolean,
 *   getState: () => ({itemId: string, current: {name: string, price: number}|null, candidates: import('../capture/replacements.js').Candidate[]}|null),
 *   prices: {get: (name: string) => Promise<import('../prices/csfloat.js').PriceSummary>, cached: (name: string) => any},
 *   stats: {rankCandidates: Function, sellValue: Function},
 *   selectCandidate?: (id: string) => boolean,
 *   currency?: () => string,
 * }} o
 */
export function mountExchangePanel(o) {
  const cur = () => {
    try {
      return String((o.currency && o.currency()) ?? '');
    } catch {
      return '';
    }
  };

  const { host, root } = createHost('caser-tracker-exchange', 2147482990);
  root.append(h('style', { text: BASE_CSS + EXCHANGE_CSS }));
  const wrap = h('div', { class: 'root' });
  root.append(wrap);

  let collapsed = !!store.get(COLLAPSED_KEY, false);
  let sort = store.get(SORT_KEY, 'value') === 'sales' ? 'sales' : 'value';
  let basis = store.get(BASIS_KEY, 'typical') === 'fast' ? 'fast' : 'typical';
  let minSales = Number(store.get(MIN_SALES_KEY, 3)) || 3;
  /** Candidate id whose sales chart is open, or '@current' for the item being replaced. */
  let openId = null;

  const toggle = h('button', {
    type: 'button',
    class: 'iconbtn',
    on: {
      click: () => {
        collapsed = !collapsed;
        store.set(COLLAPSED_KEY, collapsed);
        applyCollapsed();
      },
    },
  });
  const ttl = h('span', { class: 'ttl', text: 'Exchange by CSFloat sell value' });
  const status = h('span', { class: 'status num' });
  const content = h('div', { class: 'content' });
  const panel = h('div', { class: 'xpanel', role: 'region', 'aria-label': 'Exchange by CSFloat sell value', hidden: true }, h('div', { class: 'bar' }, ttl, status, toggle), content);
  /** Set when a row opens, so the next render scrolls its chart into view. */
  let revealOpen = false;
  wrap.append(panel);
  panel.addEventListener('keydown', (e) => e.stopPropagation());

  function applyCollapsed() {
    panel.classList.toggle('collapsed', collapsed);
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand exchange panel' : 'Collapse exchange panel');
    toggle.replaceChildren(icon(collapsed ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4'));
  }
  applyCollapsed();

  /** name -> {summary, error} */
  const results = new Map();
  let state = null;
  let stateKey = '';
  let loadId = 0;
  let renderQueued = false;

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function loadPrices(names) {
    const id = ++loadId;
    for (const name of names) {
      const hit = o.prices.cached(name);
      if (hit) results.set(name, { summary: hit, error: null });
    }
    queueRender();
    (async () => {
      for (const name of names) {
        if (id !== loadId) return;
        if (results.get(name)?.summary) continue;
        try {
          results.set(name, { summary: await o.prices.get(name), error: null });
        } catch (e) {
          results.set(name, { summary: null, error: String(e?.message || e) });
        }
        if (id === loadId) queueRender();
      }
    })();
  }

  function setPref(fn) {
    fn();
    render();
  }

  function seg(label, value, options, onPick) {
    return h(
      'span',
      { class: 'seg', role: 'group', 'aria-label': label },
      ...options.map(([v, text, tip]) => h('button', { type: 'button', title: tip, 'aria-pressed': String(value === v), text, on: { click: () => onPick(v) } })),
    );
  }

  function toggleOpen(id) {
    openId = openId === id ? null : id;
    revealOpen = openId !== null;
    render();
  }

  function render() {
    if (!state) {
      content.replaceChildren(h('p', { class: 'muted pad', text: 'Waiting for the site to load the replacement list…' }));
      return;
    }
    const prevScroll = content.querySelector('.items')?.scrollTop ?? 0;
    const c = cur();
    const curName = state.current?.name ?? null;
    const curMarket = curName ? results.get(curName)?.summary ?? null : null;
    const curSell = o.stats.sellValue(curMarket, basis);
    const rows = o.stats.rankCandidates(state.candidates, (n) => results.get(n), { minSales, sort, basis, currentValue: curSell });
    const names = new Set([curName, ...state.candidates.map((x) => x.name)].filter(Boolean));
    const done = [...names].filter((n) => results.has(n)).length;
    const best = rows.find((r) => r.liquid) ?? null;
    const basisWord = basis === 'fast' ? 'fast sale' : 'typical';

    const curOpen = openId === '@current';
    const yourBox = h(
      'button',
      {
        type: 'button',
        class: ['box', 'clickable', curOpen ? 'open' : null],
        'aria-expanded': String(curOpen),
        title: 'Show the sales chart for your item',
        disabled: !curName,
        on: { click: () => toggleOpen('@current') },
      },
      h('div', { class: 'k', text: `Your item, you get (${basisWord})` }),
      h('div', { class: 'v num' }, usd(curSell), trendTag(curMarket) ? h('span', { class: 'x' }, trendTag(curMarket)) : null),
      h('div', { class: 's', title: curName ?? '', text: curName ? `${curMarket ? `${sold30(curMarket)} sold / 30 d ·` : ''}${curName}` : 'Item name unknown' }),
    );
    const bestBox = h(
      'div',
      { class: 'box' },
      h('div', { class: 'k', text: `Best swap, ${minSales}+ sales / 30 d` }),
      h('div', { class: 'v num' }, best ? usd(best.sell) : DASH, best && best.delta !== null ? h('span', { class: ['x', signClass(best.delta)], text: usd(best.delta, { sign: true }) }) : null),
      h('div', { class: 's', title: best?.name ?? '', text: best ? best.name : done < names.size ? 'Loading prices…' : 'None liquid enough' }),
    );

    const minSel = h(
      'select',
      {
        'aria-label': 'Minimum sales in 30 days',
        on: {
          change: (e) => {
            minSales = Number(e.target.value) || 1;
            store.set(MIN_SALES_KEY, minSales);
            render();
          },
        },
      },
      ...[1, 3, 5, 10, 20].map((n) => h('option', { value: String(n), selected: n === minSales, text: `${n}+ sales` })),
    );
    const tools = h(
      'div',
      { class: 'tools' },
      h(
        'span',
        { class: 'tg' },
        'Price',
        seg('Sell price', basis, [
          ['typical', 'Typical', 'Median recent sale price, after the fee'],
          ['fast', 'Fast sale', '25th percentile of recent sales, after the fee: priced to sell quickly'],
        ], (v) => setPref(() => store.set(BASIS_KEY, (basis = v)))),
      ),
      h(
        'span',
        { class: 'tg' },
        'Sort',
        seg('Sort', sort, [
          ['value', 'Value'],
          ['sales', 'Sales'],
        ], (v) => setPref(() => store.set(SORT_KEY, (sort = v)))),
      ),
      h('span', { class: 'tg' }, 'Liquid at', minSel),
    );
    status.textContent = done < names.size ? `prices ${done}/${names.size}` : `${fmtInt(rows.length)} items`;

    let sepDone = false;
    const items = [];
    rows.forEach((r, i) => {
      const m = r.market;
      const sep = !r.liquid && !sepDone && i > 0;
      if (!r.liquid) sepDone = true;
      const open = openId === r.id;
      const sub = `site ${fmtMoney(r.price, c)}${r.refund ? ` · refund ${fmtMoney(r.refund, c)}` : ''}`;
      const second = r.error
        ? h('span', { class: 'neg', text: 'no price' })
        : !m
          ? 'loading…'
          : [`${sold30(m)} sold`, trendTag(m) ? ' ' : null, trendTag(m)];
      const title = r.error
        ? r.error
        : m
          ? `${r.name}\nTypical ${usd(m.value)}, fast sale ${usd(m.quick)} (${sourceText(m)}).${m.split ? `\n${splitText(m)}` : ''}\n${sold30(m)} sold in 30 days${okNum(m.listings) ? `, ${fmtInt(m.listings)} listed now` : ''}.\nClick for the sales chart.`
          : r.name;
      const spark = m && m.pts?.length ? salesSparkline({ points: expandPoints(m.pts).filter((p) => Date.now() - p.ts <= 90 * 86_400_000), typical: m.source === 'sales' ? m.value : null }) : null;
      const activate = () => {
        o.selectCandidate?.(r.id);
        toggleOpen(r.id);
      };
      items.push(
        h(
          'li',
          {
            class: ['item', r.liquid ? null : 'illiquid', sep ? 'sep' : null, open ? 'open' : null],
            title,
            tabIndex: 0,
            'aria-expanded': String(open),
            on: {
              click: activate,
              keydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  activate();
                }
              },
            },
          },
          h('span', { class: 'rank num', text: r.liquid ? String(i + 1) : '' }),
          r.image ? h('img', { src: r.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : h('span', { class: 'noimg' }),
          h('span', { class: 'mid' }, h('span', { class: 'name', text: r.name }), h('span', { class: 'sub num', text: sub })),
          h('span', { class: 'sp' }, spark),
          h(
            'span',
            { class: 'r' },
            h(
              'span',
              { class: 'price num' },
              usd(r.sell),
              m?.source && m.source !== 'sales' ? h('span', { class: 'flag', title: sourceText(m), text: '*' }) : null,
              m?.split ? h('span', { class: 'flag', title: splitText(m), text: '²' }) : null,
              r.delta !== null ? h('span', { class: ['delta', signClass(r.delta)], text: usd(r.delta, { sign: true }) }) : null,
            ),
            h('span', { class: 'second num' }, second),
          ),
        ),
      );
      if (open) items.push(h('li', { class: 'dwrap', on: { click: (e) => e.stopPropagation() } }, detail(r.name, m, basis, 414)));
    });

    content.replaceChildren(
      h(
        'div',
        { class: 'sum' },
        h('div', { class: 'grid' }, yourBox, bestBox),
        curOpen && curName ? h('div', { class: 'curdetail' }, detail(curName, curMarket, basis, 388)) : null,
        tools,
      ),
      h('div', { class: 'lhead' }, h('span', { text: 'Item · site price' }), h('span', { text: `You get (${basisWord}) · vs yours · sold 30 d` })),
      items.length ? h('ul', { class: 'items' }, ...items) : h('p', { class: 'muted pad', text: 'The site offered no items.' }),
      h(
        'div',
        { class: 'note', text: `You get = recent CSFloat sale prices minus the ${feePct} seller fee. * = under 3 recent sales. ² = two price groups, priced on the lower one. Float and stickers move prices. A row click opens its chart and selects it on the site; you confirm there.` },
      ),
    );
    const list = content.querySelector('.items');
    if (list) list.scrollTop = prevScroll;
    if (revealOpen && list) {
      revealOpen = false;
      const d = list.querySelector('.dwrap');
      const row = d?.previousElementSibling;
      if (d && row) {
        // Scroll inside the list only: keep the opened row's top visible and show as much of its chart as fits.
        const lr = list.getBoundingClientRect();
        const bottom = d.getBoundingClientRect().bottom;
        if (bottom > lr.bottom) list.scrollTop += Math.min(bottom - lr.bottom, row.getBoundingClientRect().top - lr.top);
      }
    }
  }

  function tick() {
    attach(host);
    let open = false;
    try {
      open = o.isOpen();
    } catch {}
    if (!open) {
      if (!panel.hidden) {
        panel.hidden = true;
        loadId++;
        state = null;
        stateKey = '';
        openId = null;
      }
      return;
    }
    panel.hidden = false;
    let next = null;
    try {
      next = o.getState();
    } catch {}
    const key = next ? `${next.itemId}|${next.current?.name ?? ''}|${next.candidates.map((x) => x.id).join(',')}` : '';
    if (key === stateKey) return;
    stateKey = key;
    state = next;
    openId = null;
    if (state) loadPrices([state.current?.name, ...state.candidates.map((x) => x.name)].filter(Boolean));
    render();
  }

  const timer = setInterval(tick, POLL_MS);
  tick();

  return {
    destroy() {
      clearInterval(timer);
      host.remove();
    },
  };
}
