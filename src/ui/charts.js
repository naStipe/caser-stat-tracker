// Hand-written inline SVG charts. Flat strokes and fills, no gradients, no filters.

import { h, s } from './dom.js';
import { fmtNumber, fmtMoney, fmtDateShort, fmtDateTime, fmtPct, signClass } from './format.js';

const COLORS = {
  line: '#7ea6f6',
  grid: '#22272e',
  zero: '#3a414b',
  pos: '#45c486',
  neg: '#ef6b6b',
  whisker: '#c3c8cf',
  marker: '#e6e8eb',
  band: '#181c22',
  diag: '#6b7480',
  deposit: '#ef6b6b',
  withdrawal: '#45c486',
  fast: '#d8a650',
};

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const d = Math.abs(min) || 1;
    min -= d;
    max += d;
  }
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { lo, hi, ticks };
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return fmtNumber(v / 1e6, a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return fmtNumber(v / 1e3, 0) + 'k';
  if (a >= 1e3) return fmtNumber(v / 1e3, 1) + 'k';
  if (a === 0) return '0';
  return fmtNumber(v, a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

/**
 * Cumulative line chart.
 * points: [{ts, v}] in order; x is the event index (equal spacing), labels show dates.
 */
export function lineChart({ points, width, height = 170, currency = '' }) {
  const W = Math.max(200, Math.floor(width));
  const H = height;
  const padL = 44;
  const padR = 10;
  const padT = 8;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  // Downsample to about one point per pixel, keeping the last one.
  let pts = points;
  if (pts.length > iw) {
    const stride = pts.length / iw;
    const out = [];
    for (let i = 0; i < iw; i++) out.push(pts[Math.floor(i * stride)]);
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  const all = [0, ...pts.map((p) => p.v)];
  const { lo, hi, ticks } = niceTicks(Math.min(...all), Math.max(...all), 4);
  const n = pts.length;
  const x = (i) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => padT + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const readout = h('div', { class: 'readout', 'aria-live': 'off' });
  const last = pts[n - 1];
  const setIdle = () => {
    readout.replaceChildren(
      'Now ',
      h('span', { class: ['num', signClass(last.v)], text: fmtMoney(last.v, currency, { sign: true }) }),
      h('span', { class: 'faint', text: `  after ${fmtNumber(points.length, 0)} events` }),
    );
  };

  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Cumulative net over ${points.length} events, now ${fmtMoney(last.v, currency, { sign: true })}`,
  });

  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svg.append(
      s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: t === 0 ? COLORS.zero : COLORS.grid, 'stroke-width': 1 }),
      s('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', text: compact(t) }),
    );
  }
  svg.append(
    s('text', { x: padL, y: H - 6, 'text-anchor': 'start', text: fmtDateShort(pts[0].ts) }),
    s('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', text: fmtDateShort(last.ts) }),
  );

  let d = '';
  pts.forEach((p, i) => {
    d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
  });
  svg.append(
    s('path', { d, fill: 'none', stroke: COLORS.line, 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    s('circle', { cx: x(n - 1), cy: y(last.v), r: 3, fill: last.v >= 0 ? COLORS.pos : COLORS.neg }),
  );

  const guide = s('line', { y1: padT, y2: padT + ih, stroke: COLORS.zero, 'stroke-width': 1, visibility: 'hidden' });
  const dot = s('circle', { r: 3.5, fill: COLORS.marker, visibility: 'hidden' });
  const hit = s('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent' });
  svg.append(guide, dot, hit);

  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / iw) * (n - 1))));
    const p = pts[i];
    const xx = x(i);
    guide.setAttribute('x1', xx);
    guide.setAttribute('x2', xx);
    dot.setAttribute('cx', xx);
    dot.setAttribute('cy', y(p.v));
    guide.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    readout.replaceChildren(
      h('span', { class: 'num', text: fmtDateTime(p.ts) }),
      '  ',
      h('span', { class: ['num', signClass(p.v)], text: fmtMoney(p.v, currency, { sign: true }) }),
    );
  };
  const hide = () => {
    guide.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    setIdle();
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
  setIdle();

  return h('div', { class: 'chart' }, readout, svg);
}

/**
 * Horizontal diverging bars around zero with CI whiskers.
 * rows: [{label, value, lo, hi, n, significant}] where value/lo/hi are fractions.
 * clamp: [min, max] domain limit so one tiny row cannot squash the rest.
 */
export function diffBars({
  rows,
  width,
  clamp = [-1, 2],
  caption,
  fmt = (v) => fmtPct(v, 0, { sign: true }),
  minSpan = 0.1,
  band = null,
}) {
  const W = Math.max(200, Math.floor(width));
  const rowH = 26;
  const labelW = Math.min(118, Math.round(W * 0.28));
  const valueW = 58;
  const padT = 18;
  const x0 = labelW + 8;
  const x1 = W - valueW;
  const H = padT + rows.length * rowH + 4;

  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  const vals = [0];
  if (band) vals.push(band[0], band[1]);
  for (const r of rows) for (const v of [r.value, r.lo, r.hi]) if (ok(v)) vals.push(v);
  let lo = Math.max(clamp[0], Math.min(...vals));
  let hi = Math.min(clamp[1], Math.max(...vals));
  if (hi - lo < minSpan) {
    lo -= minSpan / 2;
    hi += minSpan / 2;
  }
  const edgeLo = lo;
  const edgeHi = hi;
  const pad = (hi - lo) * 0.04;
  lo -= pad;
  hi += pad;
  const x = (v) => x0 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (x1 - x0);

  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': caption || 'Bar chart',
  });

  const zx = Math.round(x(0)) + 0.5;
  if (band) {
    // Flat "noise band": values inside it are what luck alone produces.
    svg.append(s('rect', { x: x(band[0]), y: padT - 2, width: Math.max(0, x(band[1]) - x(band[0])), height: H - padT, fill: COLORS.band }));
  }
  svg.append(s('text', { x: zx, y: 11, 'text-anchor': 'middle', text: '0' }));
  // Axis end labels at the data range, skipped when they would collide with the zero label.
  if (x(0) - x(edgeLo) > 40) svg.append(s('text', { x: x(edgeLo), y: 11, 'text-anchor': 'middle', text: fmt(edgeLo) }));
  if (x(edgeHi) - x(0) > 40) svg.append(s('text', { x: x(edgeHi), y: 11, 'text-anchor': 'middle', text: fmt(edgeHi) }));

  rows.forEach((r, i) => {
    const cy = padT + i * rowH + rowH / 2;
    const label = String(r.label ?? '');
    svg.append(
      s('text', { class: 'lbl', x: 0, y: cy + 4, 'text-anchor': 'start', text: label.length > 16 ? label.slice(0, 15) + '…' : label }),
    );
    if (!ok(r.value) || !r.n) {
      svg.append(s('text', { x: x1 + valueW, y: cy + 4, 'text-anchor': 'end', text: 'no data' }));
      return;
    }
    const bx = x(Math.min(0, r.value));
    const bw = Math.max(1, Math.abs(x(r.value) - x(0)));
    svg.append(
      s('rect', {
        x: bx,
        y: cy - 6,
        width: bw,
        height: 12,
        rx: 2,
        fill: r.value >= 0 ? COLORS.pos : COLORS.neg,
        'fill-opacity': r.significant ? 0.95 : 0.45,
      }),
    );
    if (ok(r.lo) && ok(r.hi)) {
      const wl = x(r.lo);
      const wh = x(r.hi);
      svg.append(
        s('line', { x1: wl, x2: wh, y1: cy, y2: cy, stroke: COLORS.whisker, 'stroke-width': 1 }),
        s('line', { x1: wl, x2: wl, y1: cy - 4, y2: cy + 4, stroke: COLORS.whisker, 'stroke-width': 1 }),
        s('line', { x1: wh, x2: wh, y1: cy - 4, y2: cy + 4, stroke: COLORS.whisker, 'stroke-width': 1 }),
      );
    }
    svg.append(s('text', { x: W, y: cy + 4, 'text-anchor': 'end', text: fmt(r.value) }));
  });
  svg.insertBefore(s('line', { x1: zx, x2: zx, y1: padT - 2, y2: H - 2, stroke: COLORS.zero, 'stroke-width': 1 }), band ? svg.childNodes[1] : svg.firstChild);

  return h('div', { class: 'chart' }, svg);
}

function hoverLayer(svg, { x0, y0, w, h: hh, onMove, onLeave }) {
  const hit = s('rect', { x: x0, y: y0, width: w, height: hh, fill: 'transparent' });
  // Local x (and y, for charts that pick the nearest point in 2D) in viewBox units.
  const move = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / (r.width || 1)) * Number(svg.getAttribute('width'));
    const py = ((e.clientY - r.top) / (r.height || 1)) * Number(svg.getAttribute('height'));
    onMove(px, py);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', onLeave);
  svg.append(hit);
}

const okNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Calibration plot: x = shown chance, y = real win rate, dashed diagonal = shown odds.
 * rows: calibrationCurve rows (rates are fractions, lo/hi are percent edges).
 */
export function calibrationChart({ rows, width }) {
  const pts = rows.filter((r) => r && r.n > 0 && okNum(r.winRate) && okNum(r.expectedRate));
  const W = Math.max(200, Math.floor(width));
  const H = Math.round(Math.min(340, Math.max(220, W * 0.66)));
  const padL = 42;
  const padR = 14;
  const padT = 10;
  const padB = 34;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  let top = 0.1;
  for (const r of pts) {
    top = Math.max(top, r.expectedRate, r.winRate, okNum(r.hi) ? r.hi / 100 : 0);
    if (Array.isArray(r.winRateCI) && okNum(r.winRateCI[1])) top = Math.max(top, r.winRateCI[1]);
  }
  const step = top > 0.5 ? 0.25 : top > 0.2 ? 0.1 : 0.05;
  const D = Math.min(1, Math.ceil(top / step - 1e-9) * step);
  const x = (v) => padL + (Math.max(0, Math.min(D, v)) / D) * iw;
  const y = (v) => padT + ih - (Math.max(0, Math.min(D, v)) / D) * ih;

  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Real win rate against shown chance per bucket. Points above the dashed diagonal win more often than shown.',
  });
  for (let i = 0; i * step <= D + 1e-9; i++) {
    const t = i * step;
    const yy = Math.round(y(t)) + 0.5;
    const xx = Math.round(x(t)) + 0.5;
    svg.append(
      s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: COLORS.grid, 'stroke-width': 1 }),
      s('line', { x1: xx, x2: xx, y1: padT, y2: padT + ih, stroke: COLORS.grid, 'stroke-width': 1 }),
      s('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', text: fmtPct(t, 0) }),
      s('text', { x: xx, y: padT + ih + 14, 'text-anchor': i === 0 ? 'start' : t >= D - 1e-9 ? 'end' : 'middle', text: fmtPct(t, 0) }),
    );
  }
  svg.append(
    s('text', { x: padL + iw / 2, y: H - 3, 'text-anchor': 'middle', text: 'Shown chance' }),
    s('text', { x: 10, y: padT + ih / 2, 'text-anchor': 'middle', transform: `rotate(-90 10 ${padT + ih / 2})`, text: 'Real win rate' }),
    s('line', { x1: x(0), y1: y(0), x2: x(D), y2: y(D), stroke: COLORS.diag, 'stroke-width': 1.25, 'stroke-dasharray': '5 4' }),
  );

  const marks = pts.map((r) => {
    const color = r.winRate >= r.expectedRate ? COLORS.pos : COLORS.neg;
    const cx = x(r.expectedRate);
    const ci = Array.isArray(r.winRateCI) ? r.winRateCI : [];
    if (okNum(ci[0]) && okNum(ci[1])) {
      svg.append(
        s('line', { x1: cx, x2: cx, y1: y(ci[0]), y2: y(ci[1]), stroke: COLORS.whisker, 'stroke-width': 1 }),
        s('line', { x1: cx - 4, x2: cx + 4, y1: y(ci[0]), y2: y(ci[0]), stroke: COLORS.whisker, 'stroke-width': 1 }),
        s('line', { x1: cx - 4, x2: cx + 4, y1: y(ci[1]), y2: y(ci[1]), stroke: COLORS.whisker, 'stroke-width': 1 }),
      );
    }
    svg.append(s('circle', { cx, cy: y(r.winRate), r: 4.5, fill: r.significant ? color : '#0f1114', stroke: color, 'stroke-width': 1.75 }));
    return { r, cx };
  });

  const readout = h('div', { class: 'readout' });
  const idle = () => readout.replaceChildren(h('span', { class: 'faint', text: 'Hover or tap a dot for details.' }));
  idle();
  const ring = s('circle', { r: 8, fill: 'none', stroke: COLORS.marker, 'stroke-width': 1, visibility: 'hidden' });
  svg.append(ring);
  if (marks.length) {
    hoverLayer(svg, {
      x0: padL,
      y0: padT,
      w: iw,
      h: ih,
      onMove: (px) => {
        let best = marks[0];
        for (const m of marks) if (Math.abs(m.cx - px) < Math.abs(best.cx - px)) best = m;
        const r = best.r;
        ring.setAttribute('cx', best.cx);
        ring.setAttribute('cy', y(r.winRate));
        ring.setAttribute('visibility', 'visible');
        readout.replaceChildren(
          h('span', { class: 'num', text: `${r.label ?? ''}: shown ${fmtPct(r.expectedRate, 1)}, real ` }),
          h('span', { class: ['num', r.winRate >= r.expectedRate ? 'pos' : 'neg'], text: fmtPct(r.winRate, 1) }),
          h('span', { class: 'num faint', text: `  n = ${fmtNumber(r.n, 0)}` }),
        );
      },
      onLeave: () => {
        ring.setAttribute('visibility', 'hidden');
        idle();
      },
    });
  }
  const legend = h(
    'div',
    { class: 'legend' },
    h('span', null, h('i', { class: 'sw dash', 'aria-hidden': 'true' }), 'Shown odds'),
    h('span', null, h('i', { class: 'sw', style: { background: COLORS.pos }, 'aria-hidden': 'true' }), 'Beyond noise'),
    h('span', null, h('i', { class: 'sw hollow', 'aria-hidden': 'true' }), 'Within noise'),
  );
  return h('div', { class: 'chart' }, readout, svg, legend);
}

/** Vertical histogram of multiplier bins [{label, lo, hi, n}]. Bins below x1 are red, at or above x1 green. */
export function histogramChart({ bins, width }) {
  const W = Math.max(200, Math.floor(width));
  const H = 170;
  const padT = 18;
  const padB = 22;
  const ih = H - padT - padB;
  const total = bins.reduce((a, b) => a + (b.n || 0), 0) || 1;
  const maxN = Math.max(1, ...bins.map((b) => b.n || 0));
  const gap = 4;
  const bw = (W - gap * (bins.length - 1)) / Math.max(1, bins.length);
  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Histogram of mystery multipliers. ' + bins.map((b) => `${b.label}: ${b.n}`).join(', '),
  });
  svg.append(s('line', { x1: 0, x2: W, y1: padT + ih + 0.5, y2: padT + ih + 0.5, stroke: COLORS.zero, 'stroke-width': 1 }));
  const tick = (v) => (okNum(v) ? fmtNumber(v, v % 1 ? 2 : 0).replace(/^0\./, '.') : '');
  bins.forEach((b, i) => {
    const bx = i * (bw + gap);
    const bh = ((b.n || 0) / maxN) * ih;
    const win = okNum(b.lo) && b.lo >= 1;
    svg.append(
      s('rect', { x: bx, y: padT + ih - bh, width: bw, height: Math.max(0, bh), rx: 2, fill: win ? COLORS.pos : COLORS.neg, 'fill-opacity': 0.8 }),
      s('text', { x: bx + bw / 2, y: padT + ih - bh - 5, 'text-anchor': 'middle', text: b.n ? fmtPct(b.n / total, 0) : '' }),
      s('text', { x: bx + bw / 2, y: H - 6, 'text-anchor': 'middle', text: okNum(b.hi) ? `x${tick(b.lo)}` : `x${tick(b.lo)}+` }),
    );
  });
  return h('div', { class: 'chart' }, svg);
}

/**
 * Money flow: running "withdrawn minus deposited" over real time as a step line,
 * with deposit and withdrawal marks. series: [{ts, kind, amount, cumulativeNet}] ordered by ts.
 */
export function moneyChart({ series, width, currency = '' }) {
  const W = Math.max(200, Math.floor(width));
  const H = 180;
  const padL = 44;
  const padR = 10;
  const padT = 8;
  const padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const pts = series.filter((p) => p && okNum(p.ts) && okNum(p.cumulativeNet));
  const t0 = pts[0].ts;
  const t1 = Math.max(pts[pts.length - 1].ts, t0 + 1);
  const vals = pts.map((p) => p.cumulativeNet);
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * iw;
  const y = (v) => padT + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const last = pts[pts.length - 1];
  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Withdrawn minus deposited over time, now ${fmtMoney(last.cumulativeNet, currency, { sign: true })}`,
  });
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svg.append(
      s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: t === 0 ? COLORS.zero : COLORS.grid, 'stroke-width': 1 }),
      s('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', text: compact(t) }),
    );
  }
  svg.append(
    s('text', { x: padL, y: H - 6, 'text-anchor': 'start', text: fmtDateShort(t0) }),
    s('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', text: fmtDateShort(last.ts) }),
  );
  let d = `M${x(t0).toFixed(1)},${y(0).toFixed(1)}`;
  for (const p of pts) d += `H${x(p.ts).toFixed(1)}V${y(p.cumulativeNet).toFixed(1)}`;
  svg.append(s('path', { d, fill: 'none', stroke: COLORS.line, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
  const r = pts.length > 300 ? 1.75 : 2.75;
  for (const p of pts) svg.append(s('circle', { cx: x(p.ts), cy: y(p.cumulativeNet), r, fill: p.kind === 'withdrawal' ? COLORS.withdrawal : COLORS.deposit }));

  const readout = h('div', { class: 'readout' });
  const idle = () =>
    readout.replaceChildren(
      'Withdrawn minus deposited: ',
      h('span', { class: ['num', signClass(last.cumulativeNet)], text: fmtMoney(last.cumulativeNet, currency, { sign: true }) }),
    );
  idle();
  const ring = s('circle', { r: 6, fill: 'none', stroke: COLORS.marker, 'stroke-width': 1, visibility: 'hidden' });
  svg.append(ring);
  hoverLayer(svg, {
    x0: padL,
    y0: padT,
    w: iw,
    h: ih,
    onMove: (px) => {
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px)) best = p;
      ring.setAttribute('cx', x(best.ts));
      ring.setAttribute('cy', y(best.cumulativeNet));
      ring.setAttribute('visibility', 'visible');
      const wd = best.kind === 'withdrawal';
      readout.replaceChildren(
        h('span', { class: 'num', text: `${fmtDateTime(best.ts)}  ` }),
        h('span', { class: wd ? 'pos' : 'neg', text: wd ? 'Withdrawal ' : 'Deposit ' }),
        h('span', { class: 'num', text: fmtMoney(best.amount, currency) }),
        h('span', { class: 'faint', text: '  running ' }),
        h('span', { class: ['num', signClass(best.cumulativeNet)], text: fmtMoney(best.cumulativeNet, currency, { sign: true }) }),
      );
    },
    onLeave: () => {
      ring.setAttribute('visibility', 'hidden');
      idle();
    },
  });
  const legend = h(
    'div',
    { class: 'legend' },
    h('span', null, h('i', { class: 'sw', style: { background: COLORS.deposit } }), 'Deposit'),
    h('span', null, h('i', { class: 'sw', style: { background: COLORS.withdrawal } }), 'Withdrawal'),
  );
  return h('div', { class: 'chart' }, readout, svg, legend);
}

/**
 * Tiny sales sparkline for a list row: sale prices over time with the typical price as a flat line.
 * points: [{ts, price}] in any order. Returns null with fewer than 2 points.
 */
export function salesSparkline({ points, typical = null, width = 64, height = 22 }) {
  let pts = (points || []).filter((p) => okNum(p.ts) && okNum(p.price)).sort((a, b) => a.ts - b.ts);
  // Leave out outliers so one sticker craft does not flatten the line.
  const ref = okNum(typical) ? typical : [...pts].sort((a, b) => a.price - b.price)[pts.length >> 1]?.price;
  pts = pts.filter((p) => p.price >= ref * 0.5 && p.price <= ref * 1.5);
  if (pts.length < 2) return null;
  const W = width;
  const H = height;
  const pad = 2;
  const clip = (v) => Math.max(ref * 0.5, Math.min(ref * 1.5, v));
  const vs = pts.map((p) => clip(p.price));
  if (okNum(typical)) vs.push(typical);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const x = (t) => pad + (t1 === t0 ? (W - 2 * pad) / 2 : ((t - t0) / (t1 - t0)) * (W - 2 * pad));
  const y = (v) => pad + (H - 2 * pad) - ((clip(v) - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'spark' });
  if (okNum(typical)) {
    const yy = Math.round(y(typical)) + 0.5;
    svg.append(s('line', { x1: 0, x2: W, y1: yy, y2: yy, stroke: COLORS.zero, 'stroke-width': 1 }));
  }
  let d = '';
  pts.forEach((p, i) => (d += `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.price).toFixed(1)}`));
  const last = pts[pts.length - 1];
  svg.append(
    s('path', { d, fill: 'none', stroke: COLORS.line, 'stroke-width': 1.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': 0.85 }),
    s('circle', { cx: x(last.ts), cy: y(last.price), r: 2, fill: COLORS.marker }),
  );
  return svg;
}

/**
 * Sales history scatter: every returned sale as a dot (x = time, y = price) with the typical and fast-sale prices
 * as flat lines and CSFloat's base price as a dotted line. Sales older than 30 days are drawn fainter; sales far
 * from the typical price are pinned to the edge as hollow dots. Hover shows a sale's date, price and float.
 * points: [{ts, price, float}]; prices in USD.
 */
export function salesChart({ points, typical = null, fast = null, base = null, upper = null, width, height = 150, now = Date.now(), fmt = (v) => '$' + fmtNumber(v, 2) }) {
  const pts = (points || []).filter((p) => okNum(p.ts) && okNum(p.price)).sort((a, b) => a.ts - b.ts);
  if (!pts.length) return h('div', { class: 'chart' }, h('p', { class: 'faint', text: 'No CSFloat sales to draw.' }));
  const readout = h('div', { class: 'readout', 'aria-live': 'off' });
  const W = Math.max(200, Math.floor(width));
  const H = height;
  const padL = 40;
  const padR = 8;
  const padT = 6;
  const padB = 20;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const DAY = 86_400_000;

  const ref = okNum(typical) ? typical : pts.map((p) => p.price).sort((a, b) => a - b)[pts.length >> 1];
  const inRange = (v) => v >= ref * 0.5 && v <= ref * 1.5;
  const ys = pts.map((p) => p.price).filter(inRange);
  for (const v of [typical, fast, base, upper]) if (okNum(v) && inRange(v)) ys.push(v);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys), 3);
  // X spans the sales themselves up to now, so a liquid item whose 40 sales are all from today is not squeezed
  // into the right edge of a 30-day axis.
  const tEnd = Math.max(pts[pts.length - 1].ts, now);
  const span = Math.max(tEnd - pts[0].ts, 3_600_000);
  const t0 = pts[0].ts - span * 0.03;
  const t1 = tEnd;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * iw;
  const short = span < 2 * DAY;
  const tlabel = (t) => (short ? fmtDateTime(t) : fmtDateShort(t));
  const y = (v) => padT + ih - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * ih;

  const svg = s('svg', {
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `${pts.length} CSFloat sales from ${fmtDateShort(pts[0].ts)} to ${fmtDateShort(pts[pts.length - 1].ts)}${okNum(typical) ? `, typical ${fmt(typical)}` : ''}`,
  });
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svg.append(
      s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: COLORS.grid, 'stroke-width': 1 }),
      s('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', text: compact(t) }),
    );
  }
  // The last 30 days: the window the typical price comes from. Drawn only when older sales are on the chart.
  const x30 = Math.round(x(now - 30 * DAY)) + 0.5;
  const mark30 = x30 > padL + 60 && x30 < W - padR - 60;
  if (mark30) {
    svg.append(
      s('line', { x1: x30, x2: x30, y1: padT, y2: padT + ih, stroke: COLORS.zero, 'stroke-width': 1, 'stroke-dasharray': '2 3' }),
      s('text', { x: x30, y: H - 6, 'text-anchor': 'middle', text: '30 d ago' }),
    );
  } else {
    const tm = (pts[0].ts + tEnd) / 2;
    svg.append(s('text', { x: x(tm), y: H - 6, 'text-anchor': 'middle', text: tlabel(tm) }));
  }
  svg.append(
    s('text', { x: padL, y: H - 6, 'text-anchor': 'start', text: tlabel(pts[0].ts) }),
    s('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', text: 'now' }),
  );
  const flat = (v, attrs) => {
    if (!okNum(v)) return;
    const yy = Math.round(y(v)) + 0.5;
    svg.append(s('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, 'stroke-width': 1.25, ...attrs }));
  };
  flat(base, { stroke: COLORS.diag, 'stroke-dasharray': '1 3' });
  flat(upper, { stroke: COLORS.pos, 'stroke-opacity': 0.4, 'stroke-dasharray': '6 4' });
  flat(fast, { stroke: COLORS.fast, 'stroke-dasharray': '4 3' });
  flat(typical, { stroke: COLORS.pos });

  const cutoff = now - 30 * DAY;
  for (const p of pts) {
    const out = !inRange(p.price);
    svg.append(
      s('circle', {
        cx: x(p.ts),
        cy: y(p.price),
        r: 2.75,
        fill: out ? 'none' : COLORS.line,
        stroke: out ? COLORS.line : 'none',
        'stroke-width': 1.25,
        'fill-opacity': p.ts >= cutoff ? 0.9 : 0.4,
      }),
    );
  }

  const ring = s('circle', { r: 5, fill: 'none', stroke: COLORS.marker, 'stroke-width': 1.5, visibility: 'hidden' });
  svg.append(ring);
  const idle = () => {
    const last = pts[pts.length - 1];
    readout.replaceChildren(
      h('span', { class: 'faint', text: `${pts.length} sales · last ` }),
      h('span', { class: 'num', text: fmt(last.price) }),
      h('span', { class: 'faint', text: ` on ${fmtDateTime(last.ts)} · hover a dot` }),
    );
  };
  hoverLayer(svg, {
    x0: padL,
    y0: padT,
    w: iw,
    h: ih,
    onMove: (px, py) => {
      // Nearest dot in 2D: many sales can share almost the same time.
      const dist = (p) => Math.hypot(x(p.ts) - px, y(p.price) - py);
      let best = pts[0];
      for (const p of pts) if (dist(p) < dist(best)) best = p;
      ring.setAttribute('cx', x(best.ts));
      ring.setAttribute('cy', y(best.price));
      ring.setAttribute('visibility', 'visible');
      readout.replaceChildren(
        h('span', { class: 'num', text: `${fmtDateTime(best.ts)}  ` }),
        h('span', { class: 'num strong', text: fmt(best.price) }),
        okNum(best.float) ? h('span', { class: 'faint num', text: `  float ${best.float.toFixed(4)}` }) : null,
        okNum(typical) ? h('span', { class: ['num', signClass(best.price - typical)], text: `  ${fmtPct(best.price / typical - 1, 1, { sign: true })} vs typical` }) : null,
      );
    },
    onLeave: () => {
      ring.setAttribute('visibility', 'hidden');
      idle();
    },
  });
  idle();
  const legend = h(
    'div',
    { class: 'legend' },
    okNum(typical) ? h('span', null, h('i', { class: 'ln', style: { borderTopColor: COLORS.pos } }), `Typical ${fmt(typical)}`) : null,
    okNum(fast) ? h('span', null, h('i', { class: 'ln dash', style: { borderTopColor: COLORS.fast } }), `Fast sale ${fmt(fast)}`) : null,
    okNum(upper) ? h('span', null, h('i', { class: 'ln dash', style: { borderTopColor: COLORS.pos, opacity: 0.5 } }), `Upper group ${fmt(upper)}`) : null,
    okNum(base) ? h('span', null, h('i', { class: 'ln dot', style: { borderTopColor: COLORS.diag } }), `CSFloat base ${fmt(base)}`) : null,
  );
  return h('div', { class: 'chart' }, readout, svg, legend);
}
