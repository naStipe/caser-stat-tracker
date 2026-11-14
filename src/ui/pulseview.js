// Pulse tab: how much players across the site get back right now, against a few hours ago.
// Data comes from the pulse collector (src/pulse/) through ctx.pulse; see main.js for the API:
//   pulse.snapshot() -> {collector, enabled, otherTab, source, summary, error, loading, updatedAt}
//   pulse.refresh()  -> reloads the summary (async; the panel refreshes when it is done)
//   pulse.setEnabled(on)

import { h } from './dom.js';
import { pulseChart } from './charts.js';
import { fmtInt, fmtNumber, fmtTime, fmtAgo, fmtMoney, signClass, DASH } from './format.js';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const STALE_MS = 60 * 1000;
const fmtR = (v) => (ok(v) ? fmtNumber(v, 3) : DASH);

const VERDICT = {
  better: ['good', 'Higher now'],
  worse: ['bad', 'Lower now'],
  same: ['neutral', 'No clear change'],
  few: ['neutral', 'Not enough data yet'],
};

function compareCallout(label, c) {
  const [cls, word] = VERDICT[c.verdict] ?? VERDICT.few;
  const r = c.recent;
  const b = c.base;
  const detail =
    c.verdict === 'few'
      ? `Needs at least 30 ${label.toLowerCase()} from 5 or more players in each window. Last hour: ${fmtInt(r.n)} from ${fmtInt(r.players)} players; the 3 hours before: ${fmtInt(b.n)}.`
      : `Players got back ${fmtR(r.ratio)} per 1 staked in the last hour (${fmtInt(r.n)} from ${fmtInt(r.players)} players), against ${fmtR(b.ratio)} in the 3 hours before (${fmtInt(b.n)}). ${
          c.verdict === 'same' ? 'The difference is within random noise' : 'The difference is too large to be luck'
        } (p = ${ok(c.p) ? fmtNumber(c.p, 3) : DASH}).`;
  return h('div', { class: ['callout', cls] }, h('div', { class: 'headline', text: `${label}: ${word}` }), h('div', { class: 'detail', text: detail }));
}

function ratioCell(r) {
  return h(
    'td',
    { class: 'num' },
    h('span', { class: ok(r?.ratio) ? signClass(r.ratio - 1) : 'faint', text: fmtR(r?.ratio) }),
    r?.ci ? h('span', { class: 'ci', text: `${fmtR(r.ci[0])} ${DASH} ${fmtR(r.ci[1])}` }) : null,
  );
}

function kpi(k, v, sub) {
  return h('div', { class: 'kpi' }, h('div', { class: 'k', text: k }), h('div', { class: 'v num', text: v, title: v }), sub ? h('div', { class: 's', text: sub }) : null);
}

function statusText(snap) {
  const c = snap.collector;
  if (snap.otherTab) return 'Collecting in another tab of this browser.';
  if (!c || !snap.enabled) return 'Off in this browser.';
  if (c.pausedUntil) return `Paused by the site until ${fmtTime(c.pausedUntil)}.`;
  if (!c.running) return c.error || 'Stopped.';
  return `Running. In the last hour: ${fmtInt(c.rowsLastHour)} rows (${fmtInt(c.backRowsLastHour)} from players’ recent history), ${fmtInt(c.requestsLastHour)} requests. ${fmtInt(c.recentPlayers)} players read in the last 2 hours, ${fmtInt(c.players)} followed now, ${fmtInt(c.queued)} waiting.`;
}

export function viewPulse(ctx) {
  const { pulse, table, th, errorBox, render, contentWidth } = ctx;
  if (!pulse) return [errorBox('The pulse module is not loaded')];
  const snap = pulse.snapshot();
  if (!snap.loading && (!snap.updatedAt || Date.now() - snap.updatedAt > STALE_MS)) pulse.refresh();
  const out = [];
  const s = snap.summary;

  if (snap.error) out.push(errorBox(snap.error, 'Could not load the pulse'));
  if (!s) {
    out.push(h('p', { class: 'muted', text: snap.loading ? 'Loading…' : 'No pulse data yet.' }));
  } else {
    out.push(h('section', null, compareCallout('Upgrades', s.compare.upgrade), compareCallout('Cases', s.compare.case)));
    const v = s.volume;
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'Last hour against the 3 hours before' }),
        h(
          'div',
          { class: 'kpis' },
          kpi('Upgrades, return per 1', fmtR(s.compare.upgrade.recent.ratio), `before ${fmtR(s.compare.upgrade.base.ratio)}`),
          kpi('Cases, return per 1', fmtR(s.compare.case.recent.ratio), `before ${fmtR(s.compare.case.base.ratio)}`),
          kpi('Site upgrades / min', ok(v.recent.upgradesPerMin) ? fmtInt(v.recent.upgradesPerMin) : DASH, `before ${ok(v.base.upgradesPerMin) ? fmtInt(v.base.upgradesPerMin) : DASH}`),
          kpi('Site case opens / min', ok(v.recent.casesPerMin) ? fmtInt(v.recent.casesPerMin) : DASH, `before ${ok(v.base.casesPerMin) ? fmtInt(v.base.casesPerMin) : DASH}`),
        ),
        h('p', {
          class: 'hint',
          text: 'Return per 1 is total value received divided by total staked, over every sampled upgrade or case open. 1.000 means players broke even at site prices. The site-wide rates come from the site’s public counters.',
        }),
      ),
    );

    // The chart shows the last 12 hours, so the two comparison windows are wide enough to read.
    const oldestFirst = [...s.hours].reverse().slice(-12);
    for (const [kind, label, what] of [['upgrade', 'Upgrades', 'upgrades'], ['case', 'Cases', 'case opens']]) {
      out.push(
        h(
          'section',
          null,
          h('h3', { text: `${label}: return per 1 staked by hour, last 12 hours` }),
          pulseChart({
            hours: oldestFirst.map((r) => ({ start: r.start, r: r[kind] })),
            compare: s.compare[kind],
            windows: s.windows,
            now: s.now,
            width: contentWidth(),
            what,
          }),
          kind === 'case'
            ? h('p', {
                class: 'hint',
                text: 'Dots are hours, with their 95% range; hollow dots have too few players for a range. The bands are the last hour (right) and the 3 hours before it, each with its 95% range: when the bands overlap a lot, the change is noise. The dashed line at 1 is break-even at site prices.',
              })
            : null,
        ),
      );
    }

    const rows = s.hours.filter((r) => r.upgrade.n || r.case.n || ok(r.volume.casesPerMin));
    out.push(
      h(
        'section',
        null,
        h('h3', { text: 'By hour, last 24 hours' }),
        rows.length
          ? table(
              [
                th('Hour'),
                th('Upgrades', 'Sampled upgrades'),
                th('Return', 'Upgrades: returned per 1 staked. Second line: 95% range, clustered by player'),
                th('Cases', 'Sampled paid case opens'),
                th('Return', 'Cases: returned per 1 spent. Second line: 95% range, clustered by player'),
                th('Staked', 'Total staked on sampled upgrades and cases'),
                th('Site / min', 'Site-wide upgrades and case opens per minute'),
                th('Online', 'Average users online'),
              ],
              rows.map((r) =>
                h(
                  'tr',
                  null,
                  h('td', { class: 'num', text: fmtTime(r.start) }),
                  h('td', { class: 'num', text: fmtInt(r.upgrade.n) }),
                  ratioCell(r.upgrade),
                  h('td', { class: 'num', text: fmtInt(r.case.n) }),
                  ratioCell(r.case),
                  h('td', { class: 'num', text: fmtMoney(r.upgrade.staked + r.case.staked) }),
                  h('td', {
                    class: 'num',
                    text: ok(r.volume.upgradesPerMin) ? `${fmtInt(r.volume.upgradesPerMin)} / ${fmtInt(r.volume.casesPerMin)}` : DASH,
                  }),
                  h('td', { class: 'num', text: ok(r.volume.online) ? fmtInt(r.volume.online) : DASH }),
                ),
              ),
            )
          : h('p', { class: 'muted', text: 'Nothing collected in the last 24 hours.' }),
      ),
    );
  }

  // Collector controls.
  const c = snap.collector;
  out.push(
    h(
      'section',
      null,
      h('h3', { text: 'Collector' }),
      h('p', { class: 'muted', text: statusText(snap) }),
      c?.error && c.running ? h('p', { class: 'warnline', text: c.error }) : null,
      h('p', {
        class: 'muted',
        text: `Data shown: ${snap.source === 'cloud' ? 'the cloud (every browser with your sync key)' : 'this browser only'}.${snap.updatedAt ? ` Updated ${fmtAgo(snap.updatedAt)}.` : ''}`,
      }),
      h(
        'div',
        { class: 'btns' },
        h('button', {
          type: 'button',
          class: ['btn', snap.enabled ? '' : 'primary'],
          'data-fk': 'pulse-toggle',
          disabled: snap.otherTab,
          text: snap.enabled ? 'Stop collecting in this browser' : 'Start collecting in this browser',
          on: {
            click: () => {
              try {
                pulse.setEnabled(!snap.enabled);
              } catch (e) {
                window.alert(String(e?.message ?? e));
              }
              render();
            },
          },
        }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Reload', disabled: snap.loading, on: { click: () => pulse.refresh() } }),
      ),
      h('p', {
        class: 'warnline',
        text: 'Run the collector only on the account you set aside for it. It reads other players’ histories with that account’s login, about one request every 4 seconds. The site can see this, may limit or ban that account, and may link it to your other accounts. If the site starts refusing requests, the collector pauses or stops by itself; do not work around it.',
      }),
      h('p', {
        class: 'hint',
        text: 'How it samples: players come from the live-drop feed, which shows big wins, so the sample leans towards big spenders. When a player is found, their latest page of upgrades and case drops is read at once (their recent history), leaving out the feed wins that found them. Then they are followed for up to 2 hours for new rows, the same for winners and losers. Players still playing now are more likely to be found, so the hours before were played by people who kept going. Players are stored as a salted hash, never by name.',
      }),
    ),
  );
  return out;
}
