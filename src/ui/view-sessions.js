// Upgrades → Sessions: upgrade sessions checked against the shown odds, and loss streaks against what luck produces.
// Gets the dashboard's shared helpers through ctx, like the views in views-v2.js.

import { h } from './dom.js';
import { fmtMoney, fmtNumber, fmtInt, fmtPct, fmtPEq, fmtZ, fmtDateShort, fmtTime, fmtDuration, signClass, DASH } from './format.js';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const settledUpgrade = (e) => e && e.kind === 'upgrade' && e.status !== 'pending';
const SESSION_PAGE = 20;
/** Chance of a loss run at least this long; nothing to show when there were no losses. */
const runChance = (len, p) => (len > 0 ? fmtPct(p, 0) : DASH);

export function viewSessions(ctx) {
  const { state, memo, call, cur, render, errorBox, emptyState, table, th, sigBadge, kpi, sectionHead, more, callout, edgeEditor } = ctx;
  const ev = state.events;
  if (!ev.some(settledUpgrade)) return emptyState('No upgrades yet', 'This view splits your upgrades into sessions and checks each one against the shown odds.');
  const ce = state.edges && state.edges.chance;
  const res = memo(`upgradeSessions:${ce ? ce.join(',') : 'default'}`, () => call('upgradeSessions', ev, ce ? { chanceEdges: ce } : {}));
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
        kpi('Sessions', fmtInt(s.sessions || 0), `${fmtInt(s.tested || 0)} tested`, null, `A session ends after ${fmtInt(gapMinutes)} minutes with no upgrade, case open or deposit. Sessions with 10 or more normal upgrades are tested.`),
        kpi('Below odds', fmtPct(s.unluckyShare, 0), 'luck: about 50%', null, 'Share of tested sessions where you won fewer upgrades than the shown chances predict.'),
        kpi('Unlucky', fmtInt(s.below || 0), luckSide, null, 'Sessions clearly below the odds on their own (p below 0.05). Pure luck puts about 1 session in 40 here.'),
        kpi('Lucky', fmtInt(s.above || 0), luckSide, null, 'Sessions clearly above the odds on their own (p below 0.05). Pure luck puts about 1 session in 40 here.'),
      ),
    ),
  );

  const shown = sessions.slice(0, state.sessionLimit);
  out.push(
    h(
      'section',
      null,
      sectionHead('Sessions', 'Newest first. Click a session for its win rate per chance level. Win rates use normal upgrades without the super-drop card.'),
      h('div', { class: 'list' }, shown.map(sessionRow)),
      sessions.length > shown.length
        ? h(
            'div',
            { class: 'list-foot' },
            h('span', { class: 'muted', text: `${fmtInt(shown.length)} of ${fmtInt(sessions.length)}` }),
            h('button', {
              class: 'btn',
              type: 'button',
              'data-fk': 'sessions-more',
              text: `Show ${fmtInt(Math.min(SESSION_PAGE, sessions.length - shown.length))} more`,
              on: {
                click: () => {
                  state.sessionLimit += SESSION_PAGE;
                  state.pendingFocus = 'sessions-more';
                  render();
                },
              },
            }),
          )
        : null,
    ),
  );

  if (streaks.length) out.push(streakSection(streaks));
  return out;

  function streakSection(rows) {
    const cell = (r, k) =>
      h(
        'td',
        { class: 'num' },
        h('span', { class: ok(r.share[k]) && r.stretches >= 20 ? signClass(r.expected[k] - r.share[k]) : '', text: fmtPct(r.share[k], 0) }),
        h('span', { class: 'ci', text: `luck ${fmtPct(r.expected[k], 0)}` }),
      );
    return h(
      'section',
      null,
      sectionHead(
        'Losses in a row',
        'Between two wins, how often did you lose 10, 20 or 30 times in a row? The grey line is how often that happens with fair odds. Long runs feel common because they are the ones you remember.',
      ),
      table(
        [
          th('Chance'),
          th('Gaps', 'Stretches of losses that ended in a win (or are still running)'),
          th('10+'),
          th('20+'),
          th('30+'),
          th('Longest', 'Longest run of losses. Grey line: chance of a run that long or longer at the shown odds'),
        ],
        rows.map((r) =>
          h(
            'tr',
            null,
            h('td', { class: 'num', text: r.label, 'data-tip': `${fmtInt(r.n)} upgrades` }),
            h('td', { class: 'num', text: fmtInt(r.stretches) }),
            cell(r, 10),
            cell(r, 20),
            cell(r, 30),
            h('td', { class: 'num' }, fmtInt(r.longestLosses), h('span', { class: 'ci', text: `chance ${runChance(r.longestLosses, r.longestP)}` })),
          ),
        ),
      ),
      more('chance-edges', 'Change chance groups', edgeEditor('chance', 'Edges, %'), 'Comma-separated percentages. Also used inside each session.'),
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
              x.oddsN ? `won ${fmtInt(x.wins)}, ${fmtNumber(x.expectedWins, 1)} expected` : null,
              fmtDuration(x.end - x.start),
            ]
              .filter(Boolean)
              .join(' · '),
          }),
        ),
        h('div', { class: 'r' }, h('div', { class: ['num', signClass(x.net)], text: fmtMoney(x.net, c, { sign: true }) }), x.significant ? h('div', { style: { marginTop: '3px' } }, sigBadge(x)) : null),
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
    const judged =
      x.oddsN < 10
        ? 'Fewer than 10 upgrades: too few to judge.'
        : x.significant
          ? 'Too far from the shown odds to be luck, even after correcting for the number of sessions.'
          : 'Within normal luck.';
    return h(
      'div',
      { class: 'sess-body' },
      h(
        'div',
        { class: 'kpis' },
        kpi('Won', fmtPct(x.winRate, 1), `shown ${fmtPct(x.expectedRate, 1)}`, ok(x.winRate) && ok(x.expectedRate) && x.oddsN >= 10 ? signClass(x.winRate - x.expectedRate) : ''),
        kpi('RTP', fmtPct(x.rtp, 1), `staked ${fmtMoney(x.cost, '')}`, ok(x.rtp) ? signClass(x.rtp - 1) : ''),
        kpi('Longest losing run', fmtInt(x.longestLosses), x.longestLosses > 0 ? `chance ${fmtPct(x.longestP, 0)}` : null),
        kpi('Deposits', fmtInt(x.deposits), x.deposits ? fmtMoney(x.deposited, '') : x.cases ? `${fmtInt(x.cases)} case opens` : null),
      ),
      x.oddsN ? h('p', { class: 'hint', text: judged, 'data-tip': `z = ${fmtZ(x.z)}, ${fmtPEq(x.p)}` }) : null,
      (x.byChance || []).length
        ? table(
            [th('Chance'), th('Upgrades'), th('Won'), th('Expected', 'Sum of the shown chances'), th('Rate'), th('Shown')],
            x.byChance.map((r) =>
              h(
                'tr',
                null,
                h('td', { class: 'num', text: r.label }),
                h('td', { class: 'num', text: fmtInt(r.n) }),
                h('td', { class: 'num', text: fmtInt(r.wins) }),
                h('td', { class: 'num', text: fmtNumber(r.expectedWins, 1) }),
                h('td', { class: ['num', ok(r.winRate) && r.n >= 10 ? signClass(r.winRate - r.expectedRate) : ''], text: fmtPct(r.winRate, 1) }),
                h('td', { class: 'num', text: fmtPct(r.expectedRate, 1) }),
              ),
            ),
          )
        : null,
    );
  }

  function luckCallout(s) {
    if (!s || !s.tested) return callout('neutral', 'Not enough sessions yet', 'A session needs at least 10 normal upgrades to be tested.');
    const swings = ok(s.spreadP) && s.spreadP < 0.05;
    const rigged = s.significantBelow > 0;
    const total = `Over all sessions: ${fmtInt(s.wins)} wins from ${fmtInt(s.n)} upgrades, ${fmtNumber(s.expectedWins, 1)} expected (${fmtPEq(s.p)}).`;
    const spread = ok(s.spreadP) ? `Spread test over ${fmtInt(s.spreadDf)} sessions: ${fmtPEq(s.spreadP)}.` : null;
    const details = more('sessions-test', 'Test details', total, spread);
    if (!swings && !rigged) {
      return callout('neutral', 'Your sessions swing the way luck does', 'Good and bad sessions come as often as fair odds produce. Nothing points to lowered odds in some sessions.', details);
    }
    return callout(
      rigged ? 'bad' : 'warn',
      rigged ? 'Some sessions are too far below the odds to be luck' : 'Sessions swing more than luck usually does',
      rigged
        ? `${fmtInt(s.significantBelow)} ${s.significantBelow === 1 ? 'session is' : 'sessions are'} below the shown odds even after correcting for the number of sessions. Look for the "Below odds" badge.`
        : 'Your win rate changes between sessions more than fair odds explain. Check again after more sessions.',
      details,
    );
  }
}
