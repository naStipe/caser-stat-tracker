// Upgrade sub-views Odds and Mystery, and the Money tab (see docs/CONTRACT.md, "UI v2").
// Each view gets the dashboard's shared helpers through ctx and returns an array of nodes.
// Every statistic comes from ctx.stat (the stats server): {value}, {error} or {loading}.
// Plain answer first; statistics go into ctx.tip / ctx.more.

import { h } from './dom.js';
import { calibrationChart, histogramChart, moneyChart } from './charts.js';
import { fmtMoney, fmtNumber, fmtInt, fmtPct, fmtCI, fmtPEq, fmtZ, fmtDate, fmtMult, signClass, DASH } from './format.js';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : ok(Number(v)) ? Number(v) : null);
const num = (v) => (ok(v) ? v : Number(v) || 0);

/** RTP (returned / cost) from roi. */
const rtpOf = (roi) => (ok(roi) ? 1 + roi : null);
const rtpCI = (ci) => (Array.isArray(ci) && ok(ci[0]) && ok(ci[1]) ? [ci[0] + 1, ci[1] + 1] : null);

const RTP_TIP = 'Return to player: what came back per unit staked. Below 100% loses money on average.';

function rtpCell(rtp, ci) {
  return h('td', { class: 'num' }, h('span', { class: ok(rtp) ? signClass(rtp - 1) : '', text: fmtPct(rtp, 1), 'data-tip': ci ? `95% range ${fmtCI(ci)}` : null }));
}

function joinLabels(rows) {
  return rows.map((r) => r.label ?? `${r.lo}${DASH}${r.hi}%`).join(', ');
}

// ---------------- Odds ----------------

export function viewOdds(ctx) {
  const { state, stat, counts, loadingBox, cur, contentWidth, errorBox, emptyState, table, th, sigBadge, sectionHead, more, edgeEditor } = ctx;
  if (!counts().settledNormal) {
    return emptyState('No normal upgrades yet', 'This view compares the chance the site shows with how often you really win.');
  }
  const out = [];
  const curve = stat('calibrationCurve');
  if (curve.loading) out.push(h('section', null, loadingBox()));
  else if (curve.error) out.push(h('section', null, errorBox(curve.error)));
  else {
    const rows = (curve.value || []).filter((r) => r && r.n > 0);
    const total = rows.reduce((a, r) => a + r.n, 0);
    if (!rows.length) out.push(h('section', null, h('p', { class: 'muted', text: 'No normal upgrades to compare yet.' })));
    else {
      out.push(h('section', null, curveCallout(ctx, rows, total)));
      out.push(
        h(
          'section',
          null,
          sectionHead(
            'Shown chance vs real win rate',
            'Each dot is one chance bucket. The dashed diagonal is what the site promises. Dots above it win more often than shown, below it less often. The vertical line is the 95% range.',
          ),
          calibrationChart({ rows, width: contentWidth() }),
        ),
      );
      out.push(
        h(
          'section',
          null,
          sectionHead('By shown chance', 'Normal upgrades only. Mystery upgrades have no shown chance; upgrades with the super-drop card are left out because the card changes the odds.'),
          table(
            [
              th('Chance'),
              th('Upgrades'),
              th('Shown', 'Average chance the site showed'),
              th('Won', 'Your real win rate. Hover a value for its 95% range.'),
              th('RTP', RTP_TIP),
              th('Result', 'Is the gap between shown and won too big to be luck? Corrected for the number of buckets.'),
            ],
            rows.map((r) =>
              h(
                'tr',
                null,
                h('td', { class: 'num', text: r.label ?? `${r.lo}${DASH}${r.hi}%` }),
                h('td', { class: 'num', text: fmtInt(r.n) }),
                h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
                h('td', { class: ['num', ok(r.winRate) && r.significant ? signClass(r.winRate - r.expectedRate) : ''] }, h('span', {
                  text: fmtPct(r.winRate, 1),
                  'data-tip': `${fmtInt(r.wins)} wins${r.winRateCI ? `, 95% range ${fmtCI(r.winRateCI)}` : ''}${ok(r.winRate) && r.expectedRate > 0 ? `, ${fmtMult(r.winRate / r.expectedRate)} the shown chance` : ''}`,
                })),
                rtpCell(r.realRtp, null),
                h('td', null, sigBadge(r)),
              ),
            ),
          ),
        ),
      );
    }
  }

  // By stake
  const se = state.edges.stake;
  const byStake = se ? stat('upgradeByStake', se) : stat('upgradeByStake');
  const c = cur();
  const stakeRows = byStake.error ? [] : (byStake.value || []).filter((r) => r && r.n > 0);
  out.push(
    h(
      'section',
      null,
      sectionHead('By stake', 'Do bigger bets win less often? Same upgrades as above, grouped by stake.', c ? `Stake in ${c}` : null),
      byStake.error
        ? errorBox(byStake.error)
        : stakeRows.length
          ? table(
              [th('Stake'), th('Upgrades'), th('Shown'), th('Won', 'Hover a value for its 95% range.'), th('RTP', RTP_TIP), th('Result')],
              stakeRows.map((r) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'num', text: r.label ?? DASH }),
                  h('td', { class: 'num', text: fmtInt(r.n) }),
                  h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
                  h('td', { class: 'num' }, h('span', { text: fmtPct(r.winRate, 1), 'data-tip': r.winRateCI ? `95% range ${fmtCI(r.winRateCI)}` : null })),
                  rtpCell(rtpOf(r.roi), null),
                  h('td', null, sigBadge(r)),
                ),
              ),
            )
          : h('p', { class: 'muted', text: 'No upgrades fall into these stake groups.' }),
      more('stake-edges', 'Change stake groups', edgeEditor('stake', `Edges${c ? `, ${c}` : ''}`), 'Comma-separated. Use inf for no upper limit.'),
    ),
  );

  out.push(superDropSection(ctx));
  return out;
}

function curveCallout(ctx, rows, total) {
  const above = rows.filter((r) => r.significant && r.winRate > r.expectedRate);
  const below = rows.filter((r) => r.significant && r.winRate < r.expectedRate);
  let headline;
  let tone = 'neutral';
  if (!above.length && !below.length) headline = 'Your wins match the shown odds';
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
  if (above.length) parts.push(`More often at ${joinLabels(above)}.`);
  if (below.length) parts.push(`Less often at ${joinLabels(below)}.`);
  if (!parts.length) parts.push('Every chance level is within normal luck.');
  parts.push(`${fmtInt(total)} normal upgrades.`);
  return ctx.callout(
    tone,
    headline,
    parts.join(' '),
    above.length ? 'Winning more often than shown is not profit: check the RTP column. Below 100% you still lose money on average.' : null,
  );
}

function sideBox(title, m) {
  if (!m || !m.n) return h('div', { class: 'box' }, h('div', { class: 'k', text: title }), h('div', { class: 'v muted', text: 'none yet' }));
  return h(
    'div',
    { class: 'box' },
    h('div', { class: 'k', text: `${title} · ${fmtInt(m.n)}` }),
    h(
      'div',
      { class: 'v num' },
      h('span', { class: ok(m.winRate) && ok(m.expectedRate) ? signClass(m.winRate - m.expectedRate) : '', text: `${fmtPct(m.winRate, 1)} won` }),
      h('span', { class: 'muted', text: ` · ${fmtPct(m.expectedRate, 1)} shown` }),
    ),
    h('div', { class: 's num', text: `RTP ${fmtPct(m.rtp, 1)}`, 'data-tip': `z = ${fmtZ(m.z)}, ${fmtPEq(m.p)}` }),
  );
}

function superDropSection(ctx) {
  const { stat, loadingBox, errorBox, sectionHead, more } = ctx;
  const res = stat('superDropStats');
  const head = sectionHead('Super-drop card', 'A card the site sometimes shows on an upgrade. When it appears, the win can be multiplied.');
  if (res.loading) return h('section', null, head, loadingBox());
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
      ? 'With the card you win more often than shown. That is why these upgrades are left out of the odds checks.'
      : cardWins
        ? 'With the card you win less often than shown.'
        : 'With the card your win rate is within normal luck.';
  return h(
    'section',
    null,
    head,
    h('p', { class: 'hint', style: { marginTop: '0', marginBottom: '10px' }, text: `Shown on ${fmtPct(sd.shownRate, 1)} of upgrades (${fmtInt(sd.shownN)} of ${fmtInt(sd.n)}). ${verdict}` }),
    h('div', { class: 'split', style: { marginTop: '0' } }, sideBox('Card shown', shown), sideBox('No card', notShown)),
    hits.n
      ? more(
          'superdrop-hits',
          'Super-drop wins',
          `${fmtInt(hits.n)} wins with the card. It multiplied the win by ${fmtMult(hits.avgMultiplier)} on average (from ${fmtMult(hits.minMultiplier)} to ${fmtMult(hits.maxMultiplier)}).`,
        )
      : null,
  );
}

// ---------------- Mystery ----------------

export function viewMystery(ctx) {
  const { stat, counts, loadingBox, cur, contentWidth, errorBox, emptyState, table, th, moneyCell, kpi, hero, sectionHead, more, callout } = ctx;
  if (!counts().settledMystery) {
    return emptyState('No mystery upgrades yet', 'Mystery upgrades hide the chance and always give you an item. This view shows what they really pay back.');
  }
  const res = stat('mysteryStats');
  if (res.loading) return [loadingBox()];
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
      hero(
        'Mystery RTP',
        fmtPct(rtp, 1),
        ok(rtp) ? signClass(rtp - 1) : '',
        { cap: 'Net', value: fmtMoney(m.net, c, { sign: true }), cls: signClass(m.net) },
        `${RTP_TIP}${ci ? ` 95% range ${fmtCI(ci)}.` : ''}`,
      ),
      h(
        'div',
        { class: 'kpis' },
        kpi('Upgrades', fmtInt(m.n || 0), `spent ${fmtMoney(m.cost, '')}`),
        kpi('Hit rate', fmtPct(m.hitRate, 1), null, null, 'Share that gave back at least the stake (multiplier ×1 or more).'),
        kpi('Average', fmtMult(m.meanMultiplier), null, null, 'Average multiplier: value received divided by stake.'),
        kpi('Median', fmtMult(m.medianMultiplier), null, null, 'Half of your mystery upgrades got less than this.'),
      ),
    ),
  );

  const bins = Array.isArray(m.histogram) ? m.histogram : [];
  if (bins.some((b) => b && b.n > 0)) {
    out.push(
      h(
        'section',
        null,
        sectionHead('Multipliers you got', 'Red bars returned less than the stake, green bars at least the stake. Percent is the share of your mystery upgrades.'),
        histogramChart({ bins, width: contentWidth() }),
      ),
    );
  }

  const byStake = (Array.isArray(m.byStake) ? m.byStake : []).filter((r) => r && r.n > 0);
  if (byStake.length) {
    const t = m.test;
    let verdict = null;
    if (t && ok(t.p)) {
      const df = Array.isArray(t.df) ? t.df.map((d) => fmtInt(d)).join(', ') : ok(t.df) ? fmtInt(t.df) + (ok(t.dfWithin) ? `, ${fmtInt(t.dfWithin)}` : '') : null;
      const method = /^anova$/i.test(String(t.method || '')) ? 'ANOVA' : t.method || 'Test';
      const line = `${method}: statistic = ${fmtNumber(t.statistic, 2)}${df ? `, df = ${df}` : ''}, ${fmtPEq(t.p)}.`;
      verdict =
        t.p >= 0.05
          ? callout('neutral', 'Stake size does not matter', 'Differences between stake sizes are normal luck.', more('mystery-test', 'Test details', line))
          : callout('warn', 'Stake size may change the multiplier', 'The groups differ more than luck usually explains. Check again after more data.', more('mystery-test', 'Test details', line));
    }
    out.push(
      h(
        'section',
        null,
        sectionHead('By stake', null, c ? `Money in ${c}` : null),
        verdict,
        verdict ? h('div', { style: { height: '10px' } }) : null,
        table(
          [th('Stake'), th('Upgrades'), th('Spent'), th('RTP', `${RTP_TIP} Hover a value for its 95% range.`), th('Hit rate'), th('Average')],
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

// ---------------- Money ----------------

function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return String(day || DASH);
  return fmtDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
}

export function viewMoney(ctx) {
  const { state, stat, counts, loadingBox, cur, contentWidth, errorBox, emptyState, goDataButton, table, th, moneyCell, render, kpi, hero, sectionHead } = ctx;
  const hv = state.holdings || {};
  const balance = numOrNull(hv.balance);
  const inventoryValue = numOrNull(hv.inventoryValue);
  const kinds = counts().kinds || {};
  const hasFlow = (kinds.deposit ?? 0) + (kinds.withdrawal ?? 0) > 0;
  if (!hasFlow) {
    const held = balance === null && inventoryValue === null ? '' : ` You hold ${fmtMoney((balance || 0) + (inventoryValue || 0), cur())} right now.`;
    return emptyState('No deposits or withdrawals yet', `Import your history to load your payments and withdrawn items.${held}`, goDataButton());
  }
  // Holdings change with every bet, so they are added here: the server answer stays cached.
  const res = stat('moneyFlow');
  if (res.loading) return [loadingBox()];
  if (res.error) return [errorBox(res.error)];
  const raw = res.value || {};
  const holdings = balance === null && inventoryValue === null ? null : (balance || 0) + (inventoryValue || 0);
  const mf = { ...raw, holdings, net: num(raw.withdrawals?.value) + (holdings ?? 0) - num(raw.deposits?.sum) };
  const dep = mf.deposits || {};
  const wd = mf.withdrawals || {};
  const c = cur();
  const out = [];

  const holdingsKnown = ok(mf.holdings);
  const depTip = [
    'Completed payments only. Failed and expired payments are not money in.',
    dep.failedN ? `${fmtInt(dep.failedN)} failed, ${fmtMoney(dep.failedSum, c)} in total.` : null,
    dep.n ? `From ${fmtDate(dep.firstTs)} to ${fmtDate(dep.lastTs)}${ok(dep.perDay) ? `, about ${fmtMoney(dep.perDay, c)} per day` : ''}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const approx = wd.n > 0 && ok(wd.exactTimeN) && wd.exactTimeN < wd.n;
  out.push(
    h(
      'section',
      null,
      hero(
        'Real money result',
        fmtMoney(mf.net, c, { sign: true }),
        signClass(mf.net),
        null,
        holdingsKnown ? 'Withdrawn + what you hold now − deposited.' : 'Withdrawn − deposited. What you hold now is unknown, so it is left out.',
      ),
      h(
        'div',
        { class: 'kpis k3' },
        kpi('Deposited', fmtMoney(dep.sum, ''), `${fmtInt(dep.n || 0)} payments`, null, depTip),
        kpi('Withdrawn', fmtMoney(wd.value, ''), `${fmtInt(wd.n || 0)} items`, null, approx ? 'Item value at withdrawal. Times are approximate for imported items.' : 'Item value at withdrawal.'),
        kpi(
          'Holdings',
          holdingsKnown ? fmtMoney(mf.holdings, '') : 'unknown',
          holdingsKnown ? `cash ${balance === null ? DASH : fmtMoney(balance, '')} · skins ${inventoryValue === null ? DASH : fmtMoney(inventoryValue, '')}` : 'not read from the site yet',
          null,
          'Your site balance plus the value of skins in your inventory right now.',
        ),
      ),
      state.holdingsError ? errorBox(state.holdingsError, 'Could not read holdings') : null,
    ),
  );

  const series = Array.isArray(mf.series) ? mf.series.filter((p) => p && ok(p.ts) && ok(p.cumulativeNet)) : [];
  if (series.length) {
    out.push(
      h(
        'section',
        null,
        sectionHead('Withdrawn minus deposited', 'Running total of everything withdrawn minus everything deposited. It leaves out what you hold now.'),
        moneyChart({ series, width: contentWidth(), currency: c }),
      ),
    );
  }

  const daily = (Array.isArray(mf.daily) ? mf.daily : [])
    .filter((d) => d && (num(d.deposited) || num(d.withdrawn)))
    .slice()
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  if (daily.length) {
    const LIMIT = 7;
    const shown = state.dailyAll ? daily : daily.slice(0, LIMIT);
    out.push(
      h(
        'section',
        null,
        sectionHead('By day', null, c ? `Money in ${c}` : null),
        table(
          [th('Day'), th('Deposited'), th('Withdrawn'), th('Net', 'Withdrawn minus deposited that day')],
          shown.map((d) =>
            h('tr', null, h('td', { class: 'num', text: dayLabel(d.day) }), moneyCell(num(d.deposited)), moneyCell(num(d.withdrawn)), moneyCell(num(d.withdrawn) - num(d.deposited), true)),
          ),
        ),
        daily.length > LIMIT
          ? h(
              'div',
              { class: 'list-foot' },
              h('span', { class: 'muted', text: `${fmtInt(shown.length)} of ${fmtInt(daily.length)} days` }),
              h('button', {
                type: 'button',
                class: 'btn',
                'data-fk': 'daily-toggle',
                text: state.dailyAll ? 'Show fewer' : 'Show all days',
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
