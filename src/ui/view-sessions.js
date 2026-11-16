// Sessions tab: upgrade sessions checked against the shown odds, and loss streaks against what luck produces.
// Gets the dashboard's shared helpers through ctx, like the views in views-v2.js.

import { h } from './dom.js';
import { fmtMoney, fmtNumber, fmtInt, fmtPct, fmtPEq, fmtZ, fmtDateShort, fmtTime, fmtDuration, signClass, DASH } from './format.js';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const settledUpgrade = (e) => e && e.kind === 'upgrade' && e.status !== 'pending';
const SESSION_PAGE = 30;
/** Chance of a loss run at least this long; nothing to show when there were no losses. */
const runChance = (len, p) => (len > 0 ? fmtPct(p, 0) : DASH);

function kpiSub(k, v, sub, cls) {
  return h(
    'div',
    { class: 'kpi' },
    h('div', { class: 'k', text: k }),
    h('div', { class: ['v', 'num', cls], text: v, title: v }),
    sub ? h('div', { class: 's', text: sub, title: sub }) : null,
  );
}

export function viewSessions(ctx) {
  const { state, memo, call, cur, render, errorBox, emptyState, goDataButton, table, th, sigBadge } = ctx;
  const ev = state.events;
  if (!ev.some(settledUpgrade)) {
    return emptyState(
      'No upgrades yet',
      'This tab splits your upgrades into sessions and checks each one against the shown odds. Make some upgrades or import your history from the Data tab.',
      goDataButton(),
    );
  }
  const ce = state.edges && state.edges.chance;
  const res = memo(`upgradeSessions:${ce ? ce.join(',') : 'default'}`, () =>
    call('upgradeSessions', ev, ce ? { chanceEdges: ce } : {}),
  );
  if (res.error) return [errorBox(res.error)];
  const { summary: s = {}, sessions = [], streaks = [], gapMinutes = 60 } = res.value || {};
  const c = cur();
  if (!state.sessionOpen) state.sessionOpen = new Set();
  if (!state.sessionLimit) state.sessionLimit = SESSION_PAGE;
  const luckSide = `luck: about ${fmtNumber(s.expectedEachSide, 1)}`;
  const out = [];

  out.push(
    h(
      'section',
      null,
      luckCallout(s),
      h(
        'div',
        { class: 'kpis' },
        kpiSub('Sessions', fmtInt(s.sessions || 0), `${fmtInt(s.tested || 0)} tested`),
        kpiSub('Below the odds', fmtPct(s.unluckyShare, 0), 'luck: about 50%'),
        kpiSub('Clearly unlucky', fmtInt(s.below || 0), luckSide),
        kpiSub('Clearly lucky', fmtInt(s.above || 0), luckSide),
      ),
      h('p', {
        class: 'hint',
        text: `A session ends after ${fmtInt(gapMinutes)} minutes with no upgrade, case open or deposit. Tested sessions have 10 or more normal upgrades. "Below the odds" is the share of tested sessions where you won fewer upgrades than the shown chances predict. "Clearly" means p below 0.05 for that session alone: pure luck puts about 1 session in 40 there on each side. Win rates use normal upgrades without the super-drop card.`,
      }),
    ),
  );

  if (streaks.length) out.push(streakSection(streaks));

  const shown = sessions.slice(0, state.sessionLimit);
  out.push(
    h(
      'section',
      null,
      h('h3', { text: 'Sessions' }),
      h('div', { class: 'list' }, shown.map(sessionRow)),
      sessions.length > shown.length
        ? h('button', {
            class: 'btn',
            type: 'button',
            style: { marginTop: '10px' },
            text: `Show ${fmtInt(Math.min(SESSION_PAGE, sessions.length - shown.length))} more`,
            on: {
              click: () => {
                state.sessionLimit += SESSION_PAGE;
                render();
              },
            },
          })
        : null,
      h('p', { class: 'hint', text: 'Newest first. Open a session for its win rate per shown chance.' }),
    ),
  );
  return out;

  function streakSection(rows) {
    const cell = (r, k) =>
      h(
        'td',
        { class: 'num' },
        h('span', {
          class: ok(r.share[k]) && r.stretches >= 20 ? signClass(r.expected[k] - r.share[k]) : '',
          text: fmtPct(r.share[k], 1),
        }),
        h('span', { class: 'ci', text: `luck ${fmtPct(r.expected[k], 1)}` }),
      );
    return h(
      'section',
      null,
      h('h3', { text: 'Losses in a row' }),
      table(
        [
          th('Shown chance'),
          th('Upgrades'),
          th('Gaps', 'Stretches of losses that ended in a win (or are still running)'),
          th('10+ losses', 'Share of gaps with 10 or more losses in a row. Second line: the share fair draws at the shown chance give'),
          th('20+ losses'),
          th('30+ losses'),
          th('Longest', 'Longest run of losses. Second line: chance of a run that long or longer at the shown odds'),
        ],
        rows.map((r) =>
          h(
            'tr',
            null,
            h('td', { class: 'num', text: r.label }),
            h('td', { class: 'num', text: fmtInt(r.n) }),
            h('td', { class: 'num', text: fmtInt(r.stretches) }),
            cell(r, 10),
            cell(r, 20),
            cell(r, 30),
            h('td', { class: 'num' }, fmtInt(r.longestLosses), h('span', { class: 'ci', text: `chance ${runChance(r.longestLosses, r.longestP)}` })),
          ),
        ),
      ),
      h('p', {
        class: 'hint',
        text: 'Between two wins, how often did you lose 10, 20 or 30 times in a row? The second line is how often that happens when every upgrade is a fair draw at the shown chance. At 10% a run of 10+ losses is normal (about 1 gap in 3) and 20+ happens about 1 gap in 8. Long runs feel common because they are the ones you remember. Upgrades are counted per chance bucket in time order.',
      }),
    );
  }

  function sessionRow(x) {
    const id = String(x.start);
    const open = state.sessionOpen.has(id);
    const d = h(
      'details',
      { class: 'sess', open },
      h(
        'summary',
        { class: 'row' },
        h(
          'div',
          { class: 'l' },
          h('div', { class: 't num', text: `${fmtDateShort(x.start)}, ${fmtTime(x.start)}${DASH}${fmtTime(x.end)}` }),
          h('div', {
            class: 'd',
            text: [
              `${fmtInt(x.upgrades)} ${x.upgrades === 1 ? 'upgrade' : 'upgrades'}`,
              x.oddsN ? `won ${fmtInt(x.wins)} of ${fmtInt(x.oddsN)}, ${fmtNumber(x.expectedWins, 1)} expected` : null,
              fmtDuration(x.end - x.start),
            ]
              .filter(Boolean)
              .join(' · '),
          }),
        ),
        h(
          'div',
          { class: 'r' },
          h('div', { class: ['num', signClass(x.net)], text: fmtMoney(x.net, c, { sign: true }) }),
          h('div', { style: { marginTop: '3px' } }, sigBadge(x)),
        ),
      ),
      open ? sessionBody(x) : null,
    );
    d.addEventListener('toggle', () => {
      if (d.open === state.sessionOpen.has(id)) return;
      if (d.open) state.sessionOpen.add(id);
      else state.sessionOpen.delete(id);
      render();
    });
    return d;
  }

  function sessionBody(x) {
    const judged = x.oddsN < 10
      ? 'Fewer than 10 upgrades: too few to judge.'
      : x.significant
        ? 'Too far from the shown odds to be luck, even after correcting for the number of sessions.'
        : 'Within what luck produces.';
    return h(
      'div',
      { class: 'sess-body' },
      h(
        'div',
        { class: 'kpis', style: { marginTop: '0' } },
        kpiSub(
          'Real win rate',
          fmtPct(x.winRate, 1),
          `shown ${fmtPct(x.expectedRate, 1)}`,
          ok(x.winRate) && ok(x.expectedRate) && x.oddsN >= 10 ? signClass(x.winRate - x.expectedRate) : '',
        ),
        kpiSub('RTP', fmtPct(x.rtp, 1), `staked ${fmtMoney(x.cost, c)}`, ok(x.rtp) ? signClass(x.rtp - 1) : ''),
        kpiSub('Longest losing run', fmtInt(x.longestLosses), x.longestLosses > 0 ? `chance ${fmtPct(x.longestP, 0)}` : null),
        kpiSub(
          'Deposits',
          fmtInt(x.deposits),
          x.deposits ? fmtMoney(x.deposited, c) : x.cases ? `${fmtInt(x.cases)} case opens` : null,
        ),
      ),
      x.oddsN ? h('p', { class: 'hint', text: `z = ${fmtZ(x.z)}, ${fmtPEq(x.p)}. ${judged}` }) : null,
      (x.byChance || []).length
        ? table(
            [
              th('Shown chance'),
              th('Upgrades'),
              th('Wins'),
              th('Expected', 'Sum of the shown chances'),
              th('Real'),
              th('Shown'),
              th('Longest', 'Longest run of losses. Second line: chance of a run that long or longer at these odds'),
            ],
            x.byChance.map((r) =>
              h(
                'tr',
                null,
                h('td', { class: 'num', text: r.label }),
                h('td', { class: 'num', text: fmtInt(r.n) }),
                h('td', { class: 'num', text: fmtInt(r.wins) }),
                h('td', { class: 'num', text: fmtNumber(r.expectedWins, 1) }),
                h('td', {
                  class: ['num', ok(r.winRate) && r.n >= 10 ? signClass(r.winRate - r.expectedRate) : ''],
                  text: fmtPct(r.winRate, 1),
                }),
                h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
                h('td', { class: 'num' }, fmtInt(r.longestLosses), h('span', { class: 'ci', text: runChance(r.longestLosses, r.longestP) })),
              ),
            ),
          )
        : null,
    );
  }
}

function luckCallout(s) {
  if (!s || !s.tested) {
    return h(
      'div',
      { class: 'callout neutral' },
      h('div', { class: 'headline', text: 'Not enough sessions yet' }),
      h('p', { class: 'detail', text: 'A session needs at least 10 normal upgrades to be tested.' }),
    );
  }
  const swings = ok(s.spreadP) && s.spreadP < 0.05;
  const rigged = s.significantBelow > 0;
  const total = `Over all sessions: ${fmtInt(s.wins)} wins out of ${fmtInt(s.n)} upgrades, ${fmtNumber(s.expectedWins, 1)} expected from the shown odds (${fmtPEq(s.p)}).`;
  const spread = ok(s.spreadP) ? ` Spread test over ${fmtInt(s.spreadDf)} sessions: ${fmtPEq(s.spreadP)}.` : '';
  if (!swings && !rigged) {
    return h(
      'div',
      { class: 'callout neutral' },
      h('div', { class: 'headline', text: 'Your sessions swing the way luck does' }),
      h('p', {
        class: 'detail',
        text: 'Good and bad sessions come about as often as fair draws at the shown chance produce. Nothing points to the site lowering the odds in some sessions.',
      }),
      h('p', { class: 'detail', text: total + spread }),
    );
  }
  return h(
    'div',
    { class: ['callout', rigged ? 'bad' : 'warn'] },
    h('div', {
      class: 'headline',
      text: rigged ? 'Some sessions are too far below the odds to be luck' : 'Sessions swing more than luck usually does',
    }),
    h('p', {
      class: 'detail',
      text: rigged
        ? `${fmtInt(s.significantBelow)} ${s.significantBelow === 1 ? 'session is' : 'sessions are'} below the shown odds even after correcting for the number of sessions. Look for the "Below odds" badge in the list.`
        : 'The win rate changes from session to session more than fair draws explain. Check again after more sessions before acting on it.',
    }),
    h('p', { class: 'detail', text: total + spread }),
  );
}
