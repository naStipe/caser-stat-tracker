// Case contents panel: on a case page, lists every item the case can drop with its site price,
// the cheapest and best drop, and (when the site publishes chances) each item's chance and the EV.
// Shown only while the page URL is a case page. Polls the URL every 500 ms; loads once per case.

import { h, s, createHost, attach, store, safe } from './dom.js';
import { BASE_CSS, CASE_PANEL_CSS } from './styles.js';
import { fmtMoney, fmtChance, fmtMult, fmtInt, fmtNumber, signClass, DASH } from './format.js';

const COLLAPSED_KEY = 'cst.ui.casePanelCollapsed';
const POLL_MS = 500;

function icon(d) {
  return s(
    'svg',
    { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    s('path', { d }),
  );
}
const CHEVRON_UP = 'M4 10l4-4 4 4';
const CHEVRON_DOWN = 'M4 6l4 4 4-4';

/**
 * @param {{
 *   getSlug: () => string|null,
 *   getInfo: (slug: string) => Promise<import('../capture/caseinfo.js').CaseInfo|null>,
 *   stats: {caseOdds: Function},
 *   currency?: () => string,
 * }} o
 */
export function mountCasePanel(o) {
  const cur = () => {
    try {
      return String((o.currency && o.currency()) ?? '');
    } catch {
      return '';
    }
  };

  const { host, root } = createHost('caser-tracker-cases', 2147482980);
  root.append(h('style', { text: BASE_CSS + CASE_PANEL_CSS }));
  const wrap = h('div', { class: 'root' });
  root.append(wrap);

  let collapsed = !!store.get(COLLAPSED_KEY, false);
  const toggle = h('button', {
    type: 'button',
    class: 'iconbtn',
    'aria-controls': 'cst-case-content',
    on: {
      click: () => {
        collapsed = !collapsed;
        store.set(COLLAPSED_KEY, collapsed);
        applyCollapsed();
      },
    },
  });
  const ttl = h('span', { class: 'ttl', text: 'Case contents' });
  const bar = h('div', { class: 'bar' }, ttl, toggle);
  const content = h('div', { class: 'content', id: 'cst-case-content' });
  const panel = h('div', { class: 'cpanel', role: 'region', 'aria-label': 'Case contents', hidden: true }, bar, content);
  wrap.append(panel);
  panel.addEventListener('keydown', (e) => e.stopPropagation());

  function applyCollapsed() {
    panel.classList.toggle('collapsed', collapsed);
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand case contents' : 'Collapse case contents');
    toggle.replaceChildren(icon(collapsed ? CHEVRON_DOWN : CHEVRON_UP));
  }
  applyCollapsed();

  let slug = null;
  let loadId = 0;

  async function load(forSlug) {
    const id = ++loadId;
    ttl.textContent = 'Case contents';
    content.replaceChildren(h('p', { class: 'muted pad', text: 'Loading items…' }));
    let info = null;
    let error = null;
    try {
      info = await o.getInfo(forSlug);
    } catch (e) {
      error = e;
    }
    if (id !== loadId) return; // the user moved to another case meanwhile
    if (error || !info) {
      content.replaceChildren(h('p', { class: 'error pad', role: 'alert', text: error ? `Could not load the case items: ${error.message || error}` : 'The site sent no items for this case.' }));
      return;
    }
    const res = safe(() => o.stats.caseOdds(info));
    if (res.error || !res.value) {
      content.replaceChildren(h('p', { class: 'error pad', role: 'alert', text: 'Could not compute the case outcomes.' }));
      return;
    }
    render(info, res.value);
  }

  function render(info, odds) {
    const c = cur();
    ttl.textContent = info.title;
    const multText = (m) => (m === null ? '' : fmtMult(m));

    const outcome = (label, it) =>
      h(
        'div',
        { class: 'box' },
        h('div', { class: 'k', text: label }),
        h('div', { class: 'v num' }, it ? fmtMoney(it.price, c) : DASH, it && odds.casePrice > 0 ? h('span', { class: ['x', signClass(it.price - odds.casePrice)], text: multText(it.price / odds.casePrice) }) : null),
        h('div', { class: 's', title: it ? it.name : '', text: it ? it.name : '' }),
      );

    let evBox;
    if (odds.hasChances) {
      const ratio = odds.evRatio;
      evBox = h(
        'div',
        { class: 'box wide' },
        h('div', { class: 'k', text: 'Expected value per open', title: 'Sum of item price × the chance the site shows' }),
        h(
          'div',
          { class: 'v num' },
          fmtMoney(odds.ev, c),
          ratio !== null ? h('span', { class: ['x', signClass(ratio - 1)], text: `return ${fmtNumber(ratio, 3)}` }) : null,
        ),
        h('div', { class: 's', text: odds.casePrice > 0 ? `${fmtMoney(odds.ev - odds.casePrice, c, { sign: true })} per open on average, by the site's chances.` : 'Free case.' }),
      );
    } else {
      evBox = h(
        'div',
        { class: 'box wide' },
        h('div', { class: 'k', text: 'Expected value per open' }),
        h('div', { class: 'v muted', text: 'Not available' }),
        h('div', { class: 's wrap', text: 'The site does not publish drop chances for this case, only prices.' }),
      );
    }

    const head = h(
      'div',
      { class: 'sum' },
      h('p', { class: 'meta' }, `${fmtInt(odds.n)} items · case price `, h('b', { class: 'num', text: odds.casePrice > 0 ? fmtMoney(odds.casePrice, c) : 'free' })),
      h('div', { class: 'grid' }, outcome('Cheapest drop', odds.min), outcome('Best drop', odds.max), evBox),
    );

    const rows = odds.items.map((it) =>
      h(
        'li',
        { class: 'item' },
        it.image ? h('img', { src: it.image, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : h('span', { class: 'noimg' }),
        h('span', { class: 'name', title: it.name, text: it.name }),
        h(
          'span',
          { class: 'r' },
          h('span', { class: 'price num', text: fmtMoney(it.price, c) }),
          h('span', { class: 'second num' }, it.mult !== null ? h('span', { class: signClass(it.mult - 1), text: fmtMult(it.mult) }) : null, odds.hasChances && it.mult !== null ? ' · ' : null, odds.hasChances ? fmtChance(it.chance, it.chance < 0.01 ? 4 : it.chance < 1 ? 3 : 2) : null),
        ),
      ),
    );

    const listHead = h('div', { class: 'lhead' }, h('span', { text: 'Item' }), h('span', { text: odds.hasChances ? 'Price · ×case · chance' : 'Price · ×case' }));
    content.replaceChildren(head, listHead, h('ul', { class: 'items' }, ...rows));
  }

  function tick() {
    attach(host);
    let next = null;
    try {
      next = o.getSlug();
    } catch {
      next = null;
    }
    if (next === slug) return;
    slug = next;
    if (!slug) {
      loadId++;
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    load(slug);
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
