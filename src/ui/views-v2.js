// Dashboard tabs added in v2: Odds, Mystery, Money (see docs/CONTRACT.md, "UI v2").
// Each view gets the dashboard's shared helpers through ctx and returns an array of nodes.
// Every stats call goes through ctx.memo + ctx.call, so a missing or failing function shows an error box.

import { h } from './dom.js';
import { calibrationChart, histogramChart, moneyChart } from './charts.js';
import { fmtMoney, fmtNumber, fmtInt, fmtPct, fmtCI, fmtP, fmtPEq, fmtZ, fmtDate, fmtMult, signClass, DASH } from './format.js';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : ok(Number(v)) ? Number(v) : null);
const settledUpgrade = (e) => e && e.kind === 'upgrade' && e.status !== 'pending';

/** RTP (returned / cost) from roi. */
const rtpOf = (roi) => (ok(roi) ? 1 + roi : null);
const rtpCI = (ci) => (Array.isArray(ci) && ok(ci[0]) && ok(ci[1]) ? [ci[0] + 1, ci[1] + 1] : null);

function rtpCell(rtp, ci) {
  return h(
    'td',
    { class: 'num' },
    h('span', { class: ok(rtp) ? signClass(rtp - 1) : '', text: fmtPct(rtp, 1) }),
    ci ? h('span', { class: 'ci', text: fmtCI(ci) }) : null,
  );
}

function kpiSub(k, v, sub, cls) {
  return h(
    'div',
    { class: 'kpi' },
    h('div', { class: 'k', text: k }),
    h('div', { class: ['v', 'num', cls], text: v, title: v }),
    sub ? h('div', { class: 's', text: sub }) : null,
  );
}

function joinLabels(rows) {
  return rows.map((r) => r.label ?? `${r.lo}${DASH}${r.hi}%`).join(', ');
}

// ---------------- Odds ----------------

export function viewOdds(ctx) {
  const { state, memo, call, contentWidth, errorBox, emptyState, goDataButton, table, th, sigBadge } = ctx;
  const ev = state.events;
  if (!ev.some((e) => settledUpgrade(e) && !e.mystery)) {
    return emptyState(
      'No upgrades yet',
      'This tab compares the chance the site shows with how often you really win. Make some upgrades or import your history from the Data tab.',
      goDataButton(),
    );
  }
  const out = [];
  const curve = memo('calibrationCurve', () => call('calibrationCurve', ev));
  if (curve.error) out.push(h('section', null, h('h3', { text: 'Shown chance vs real win rate' }), errorBox(curve.error)));
  else {
    const rows = (curve.value || []).filter((r) => r && r.n > 0);
    const total = rows.reduce((a, r) => a + r.n, 0);
    if (!rows.length) {
      out.push(h('section', null, h('h3', { text: 'Shown chance vs real win rate' }), h('p', { class: 'muted', text: 'No normal upgrades to compare yet.' })));
    } else {
      out.push(h('section', null, curveCallout(rows, total)));
      out.push(
        h(
          'section',
          null,
          h('h3', { text: 'Shown chance vs real win rate' }),
          calibrationChart({ rows, width: contentWidth() }),
          h('p', {
            class: 'hint',
            text: 'Each dot is one bucket of shown chance. The dashed diagonal is what the site promises. Dots above it win more often than shown, below it less often. The vertical line is the 95% range.',
          }),
        ),
      );
      out.push(
        h(
          'section',
          null,
          h('h3', { text: 'By shown chance' }),
          table(
            [
              th('Shown chance'),
              th('Upgrades'),
              th('Wins'),
              th('Shown', 'Average chance the site showed'),
              th('Real', 'Your real win rate. Second line: 95% Wilson interval'),
              th('Real ÷ shown'),
              th('RTP', 'Returned divided by staked'),
              th('Result', 'Holm-corrected across buckets'),
            ],
            rows.map((r) =>
              h(
                'tr',
                null,
                h('td', { class: 'num', text: r.label ?? `${r.lo}${DASH}${r.hi}%` }),
                h('td', { class: 'num', text: fmtInt(r.n) }),
                h('td', { class: 'num', text: fmtInt(r.wins) }),
                h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
                h('td', { class: 'num' }, fmtPct(r.winRate, 1), r.winRateCI ? h('span', { class: 'ci', text: fmtCI(r.winRateCI) }) : null),
                h('td', {
                  class: 'num',
                  text: ok(r.winRate) && r.expectedRate > 0 ? fmtMult(r.winRate / r.expectedRate) : DASH,
                }),
                rtpCell(r.realRtp, null),
                h('td', null, sigBadge(r)),
              ),
            ),
          ),
          h('p', {
            class: 'hint',
            text: 'Normal upgrades only. Mystery upgrades have no shown chance, and upgrades where the super-drop card appeared are left out because the card changes the odds (see below).',
          }),
        ),
      );
    }
  }
  out.push(superDropSection(ctx));
  return out;
}

function curveCallout(rows, total) {
  const above = rows.filter((r) => r.significant && r.winRate > r.expectedRate);
  const below = rows.filter((r) => r.significant && r.winRate < r.expectedRate);
  let headline;
  let tone = 'neutral';
  if (!above.length && !below.length) headline = 'Your wins match the shown odds at every level';
  else if (above.length && below.length) {
    headline = 'The shown odds are off, in both directions';
    tone = 'warn';
  } else if (below.length) {
    headline = 'You win less often than the shown odds';
    tone = 'bad';
  } else {
    headline = 'You win more often than the shown odds';
    tone = 'good';
  }
  const parts = [];
  if (above.length) parts.push(`More often than shown at ${joinLabels(above)}.`);
  if (below.length) parts.push(`Less often than shown at ${joinLabels(below)}.`);
  if (!parts.length) parts.push('Every bucket is within random noise of the shown chance.');
  parts.push(`Based on ${fmtInt(total)} normal upgrades.`);
  return h(
    'div',
    { class: ['callout', tone] },
    h('div', { class: 'headline', text: headline }),
    h('p', { class: 'detail', text: parts.join(' ') }),
    above.length
      ? h('p', {
          class: 'detail',
          text: 'Winning more often than shown does not mean profit: check the RTP column. Below 100% you still lose money on average.',
        })
      : null,
  );
}

function sideBox(title, m) {
  if (!m || !m.n) return h('div', { class: 'box' }, h('div', { class: 'k', text: title }), h('div', { class: 'v muted', text: 'none yet' }));
  return h(
    'div',
    { class: 'box' },
    h('div', { class: 'k', text: `${title}: ${fmtInt(m.n)}` }),
    h(
      'div',
      { class: 'v num' },
      h('span', { class: ok(m.winRate) && ok(m.expectedRate) ? signClass(m.winRate - m.expectedRate) : '', text: `${fmtPct(m.winRate, 1)} won` }),
      h('span', { class: 'muted', text: `  vs ${fmtPct(m.expectedRate, 1)} shown` }),
    ),
    h('div', { class: 's num', text: `RTP ${fmtPct(m.rtp, 1)} · z = ${fmtZ(m.z)}, ${fmtPEq(m.p)}` }),
  );
}

function superDropSection(ctx) {
  const { state, memo, call, errorBox } = ctx;
  const res = memo('superDropStats', () => call('superDropStats', state.events));
  const head = h('h3', { text: 'Super-drop card' });
  if (res.error) return h('section', null, head, errorBox(res.error));
  const sd = res.value || {};
  if (!sd.n) return h('section', null, head, h('p', { class: 'muted', text: 'No normal upgrades yet.' }));
  const shown = sd.shown || {};
  const notShown = sd.notShown || {};
  const hits = sd.hits || {};
  const cardWins = shown.n > 0 && ok(shown.p) && shown.p < 0.05;
  const verdict = !shown.n
    ? 'The card has not appeared on your upgrades yet.'
    : cardWins && shown.winRate > shown.expectedRate
      ? `With the card shown you win more often than the shown chance (${fmtPct(shown.winRate, 0)} vs ${fmtPct(shown.expectedRate, 0)}). That is why these upgrades are left out of the odds tests.`
      : cardWins
        ? `With the card shown you win less often than the shown chance (${fmtPct(shown.winRate, 0)} vs ${fmtPct(shown.expectedRate, 0)}).`
        : 'With the card shown, your win rate is within random noise of the shown chance.';
  return h(
    'section',
    null,
    head,
    h(
      'div',
      { class: 'callout neutral' },
      h('div', { class: 'headline', text: `The card appeared on ${fmtPct(sd.shownRate, 1)} of your upgrades` }),
      h('p', { class: 'detail', text: `${fmtInt(sd.shownN)} of ${fmtInt(sd.n)} normal upgrades. ${verdict}` }),
    ),
    h('div', { class: 'split' }, sideBox('Card shown', shown), sideBox('No card', notShown)),
    hits.n
      ? h('p', {
          class: 'hint',
          text: `${fmtInt(hits.n)} super-drop wins. The card multiplied the win by ${fmtMult(hits.avgMultiplier)} on average (from ${fmtMult(hits.minMultiplier)} to ${fmtMult(hits.maxMultiplier)}).`,
        })
      : h('p', { class: 'hint', text: 'No super-drop wins yet.' }),
  );
}

// ---------------- Mystery ----------------

export function viewMystery(ctx) {
  const { state, memo, call, cur, contentWidth, errorBox, emptyState, goDataButton, table, th, moneyCell } = ctx;
  const ev = state.events;
  if (!ev.some((e) => settledUpgrade(e) && e.mystery)) {
    return emptyState(
      'No mystery upgrades yet',
      'Mystery upgrades hide the chance and always give you an item. This tab shows what they really pay back.',
      goDataButton(),
    );
  }
  const res = memo('mysteryStats', () => call('mysteryStats', ev));
  if (res.error) return [errorBox(res.error)];
  const m = res.value || {};
  const c = cur();
  const rtp = rtpOf(m.roi);
  const ci = rtpCI(m.roiCI);
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
          h('div', { class: 'cap', text: 'Mystery RTP' }),
          h('div', { class: ['big', 'num', ok(rtp) ? signClass(rtp - 1) : ''], text: fmtPct(rtp, 1) }),
          ci ? h('div', { class: 'cap num', text: `95% range ${fmtCI(ci)}`, style: { marginTop: '4px' } }) : null,
        ),
        h(
          'div',
          { style: { textAlign: 'right' } },
          h('div', { class: 'cap', text: 'Net' }),
          h('div', { class: ['roi', 'num', signClass(m.net)], text: fmtMoney(m.net, c, { sign: true }) }),
        ),
      ),
      h(
        'div',
        { class: 'kpis' },
        kpiSub('Upgrades', fmtInt(m.n || 0), `spent ${fmtMoney(m.cost, c)}`),
        kpiSub('Hit rate', fmtPct(m.hitRate, 1), m.hitRateCI ? fmtCI(m.hitRateCI) : 'multiplier x1 or more'),
        kpiSub('Mean multiplier', fmtMult(m.meanMultiplier)),
        kpiSub('Median', fmtMult(m.medianMultiplier)),
      ),
      h('p', {
        class: 'hint',
        text: `RTP is what you got back per unit staked. ${ok(rtp) && rtp < 1 ? `On average a mystery upgrade returned ${fmtPct(rtp, 0)} of its stake.` : ''} Hit rate is the share that gave back at least the stake.`,
      }),
    ),
  );

  const bins = Array.isArray(m.histogram) ? m.histogram : [];
  if (bins.some((b) => b && b.n > 0)) {
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'What multiplier you got' }),
        histogramChart({ bins, width: contentWidth() }),
        h('p', { class: 'hint', text: 'Red bars returned less than the stake, green bars at least the stake. Percent is the share of your mystery upgrades.' }),
      ),
    );
  }

  const byStake = (Array.isArray(m.byStake) ? m.byStake : []).filter((r) => r && r.n > 0);
  if (byStake.length) {
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'By stake' }),
        mysteryTest(m.test),
        h('div', { style: { height: '12px' } }),
        table(
          [th('Stake'), th('Upgrades'), th('Spent'), th('RTP', 'Second line: 95% range'), th('Hit rate'), th('Mean mult.')],
          byStake.map((r) =>
            h(
              'tr',
              null,
              h('td', { class: 'num', text: r.label ?? DASH }),
              h('td', { class: 'num', text: fmtInt(r.n) }),
              moneyCell(r.cost),
              rtpCell(rtpOf(r.roi), rtpCI(r.roiCI)),
              h('td', { class: 'num', text: fmtPct(r.hitRate, 1) }),
              h('td', { class: 'num', text: fmtMult(r.meanMultiplier) }),
            ),
          ),
        ),
      ),
    );
  }
  return out;
}

function mysteryTest(t) {
  if (!t || !ok(t.p)) {
    return h(
      'div',
      { class: 'callout neutral' },
      h('div', { class: 'headline', text: 'Not enough data for a test yet' }),
      h('p', { class: 'detail', text: 'Treat differences between stake sizes as random noise for now.' }),
    );
  }
  const df = Array.isArray(t.df)
    ? t.df.map((d) => fmtInt(d)).join(', ')
    : ok(t.df)
      ? fmtInt(t.df) + (ok(t.dfWithin) ? `, ${fmtInt(t.dfWithin)}` : '')
      : null;
  const method = /^anova$/i.test(String(t.method || '')) ? 'ANOVA' : t.method || 'Test';
  const line = `${method}: statistic = ${fmtNumber(t.statistic, 2)}${df ? `, df = ${df}` : ''}, ${fmtPEq(t.p)}`;
  if (t.p >= 0.05) {
    return h(
      'div',
      { class: 'callout neutral', role: 'note' },
      h('div', { class: 'headline', text: 'No real effect: differences are within random noise.' }),
      h('p', { class: 'detail', text: 'Stake size does not change the mystery multiplier beyond what luck produces.' }),
      h('p', { class: 'detail', text: line }),
    );
  }
  return h(
    'div',
    { class: 'callout warn', role: 'note' },
    h('div', { class: 'headline', text: 'Stake size may change the multiplier' }),
    h('p', { class: 'detail', text: 'The rows differ more than luck usually explains. Check again after more data before acting on it.' }),
    h('p', { class: 'detail', text: line }),
  );
}

// ---------------- Money ----------------

function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || DASH);
  return fmtDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
}

export function viewMoney(ctx) {
  const { state, memo, call, cur, contentWidth, errorBox, emptyState, goDataButton, table, th, moneyCell, render } = ctx;
  const ev = state.events;
  const hv = state.holdings || {};
  const balance = numOrNull(hv.balance);
  const inventoryValue = numOrNull(hv.inventoryValue);
  const hasFlow = ev.some((e) => e && (e.kind === 'deposit' || e.kind === 'withdrawal'));
  if (!hasFlow) {
    const held = balance === null && inventoryValue === null ? '' : ` You hold ${fmtMoney((balance || 0) + (inventoryValue || 0), cur())} right now.`;
    return emptyState(
      'No deposits or withdrawals yet',
      `Import your history from the Data tab to load your payments. Withdrawn items come from your inventory history.${held}`,
      goDataButton(),
    );
  }
  const res = memo(`moneyFlow:${balance}:${inventoryValue}`, () => call('moneyFlow', ev, { balance, inventoryValue }));
  if (res.error) return [errorBox(res.error)];
  const mf = res.value || {};
  const dep = mf.deposits || {};
  const wd = mf.withdrawals || {};
  const c = cur();
  const out = [];

  const holdingsKnown = ok(mf.holdings);
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
          h('div', { class: 'cap', text: 'Real money result' }),
          h('div', { class: ['big', 'num', signClass(mf.net)], text: fmtMoney(mf.net, c, { sign: true }) }),
          h('div', { class: 'cap', text: holdingsKnown ? 'Withdrawn + what you hold now − deposited' : 'Withdrawn − deposited (holdings unknown)', style: { marginTop: '4px' } }),
        ),
      ),
      h(
        'div',
        { class: 'kpis' },
        kpiSub('Deposited', fmtMoney(dep.sum, c), `${fmtInt(dep.n || 0)} completed`),
        kpiSub('Withdrawn', fmtMoney(wd.value, c), `${fmtInt(wd.n || 0)} items`),
        kpiSub(
          'Holdings',
          holdingsKnown ? fmtMoney(mf.holdings, c) : 'unknown',
          holdingsKnown ? `cash ${balance === null ? DASH : fmtMoney(balance, '')}, skins ${inventoryValue === null ? DASH : fmtMoney(inventoryValue, '')}` : 'not read from the site yet',
        ),
        kpiSub('Failed deposits', fmtInt(dep.failedN || 0), dep.failedN ? fmtMoney(dep.failedSum, c) : 'none'),
      ),
      state.holdingsError ? errorBox(state.holdingsError, 'Could not read holdings') : null,
      dep.n
        ? h('p', {
            class: 'hint',
            text: `Deposits from ${fmtDate(dep.firstTs)} to ${fmtDate(dep.lastTs)}${ok(dep.perDay) ? `, about ${fmtMoney(dep.perDay, c)} per day` : ''}. Failed and expired payments are not counted as money in.`,
          })
        : null,
    ),
  );

  const series = Array.isArray(mf.series) ? mf.series.filter((p) => p && ok(p.ts) && ok(p.cumulativeNet)) : [];
  const approx = wd.n > 0 && ok(wd.exactTimeN) && wd.exactTimeN < wd.n;
  if (series.length) {
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Deposits and withdrawals over time' }),
        moneyChart({ series, width: contentWidth(), currency: c }),
        h('p', { class: 'hint', text: 'The line is everything withdrawn minus everything deposited so far. It leaves out what you hold now.' }),
        approx ? h('p', { class: 'hint', text: 'Withdrawal times are approximate for imported items.' }) : null,
      ),
    );
  } else if (approx) {
    out.push(h('p', { class: 'hint', text: 'Withdrawal times are approximate for imported items.' }));
  }

  const daily = (Array.isArray(mf.daily) ? mf.daily : []).filter((d) => d && (num(d.deposited) || num(d.withdrawn))).slice().sort((a, b) => (a.day < b.day ? 1 : -1));
  if (daily.length) {
    const LIMIT = 14;
    const shown = state.dailyAll ? daily : daily.slice(0, LIMIT);
    out.push(
      h(
        'section',
        null,
        h('div', { class: 'section-head' }, h('h3', { text: 'By day' }), c ? h('span', { class: 'muted', text: `Money in ${c}` }) : null),
        table(
          [th('Day'), th('Deposited'), th('Withdrawn'), th('Withdrawn − deposited')],
          shown.map((d) =>
            h(
              'tr',
              null,
              h('td', { class: 'num', text: dayLabel(d.day) }),
              moneyCell(num(d.deposited)),
              moneyCell(num(d.withdrawn)),
              moneyCell(num(d.withdrawn) - num(d.deposited), true),
            ),
          ),
        ),
        daily.length > LIMIT
          ? h('div', { style: { marginTop: '10px' } },
              h('button', {
                type: 'button',
                class: 'btn ghost',
                'data-fk': 'daily-toggle',
                text: state.dailyAll ? 'Show fewer days' : `Show all ${fmtInt(daily.length)} days`,
                on: {
                  click: () => {
                    state.dailyAll = !state.dailyAll;
                    state.pendingFocus = 'daily-toggle';
                    render();
                  },
                },
              }),
            )
          : null,
      ),
    );
  }
  return out;
}

function num(v) {
  return ok(v) ? v : Number(v) || 0;
}
