// Number and date formatting for the UI.
// Thousands use a thin space (U+2009), negatives use a real minus sign (U+2212).
// Rates from stats (roi, winRate, hitRate, expectedRate, evPct, probProfit, RTP) are fractions.
// Chances (chanceShown, chanceFair) are 0-100, as in the contract.

export const THIN = ' ';
export const NBSP = ' ';
export const MINUS = '−';
export const DASH = '–';

const ok = (v) => typeof v === 'number' && Number.isFinite(v);

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** Plain number. opts.sign shows "+" for positive values. */
export function fmtNumber(v, decimals = 2, opts = {}) {
  if (!ok(v)) return DASH;
  const fixed = Math.abs(v).toFixed(decimals);
  const [i, f] = fixed.split('.');
  const body = group(i) + (f ? '.' + f : '');
  const zero = Number(fixed) === 0;
  if (v < 0 && !zero) return MINUS + body;
  if (opts.sign && !zero) return '+' + body;
  return body;
}

export function fmtInt(v) {
  return fmtNumber(v, 0);
}

/** Money with 2 decimals and the currency label. opts.sign for net values. */
export function fmtMoney(v, currency = '', opts = {}) {
  const n = fmtNumber(v, 2, opts);
  if (n === DASH || !currency) return n;
  return n + NBSP + currency;
}

/** Fraction to percent: -0.123 -> "−12.3%". */
export function fmtPct(fraction, decimals = 1, opts = {}) {
  if (!ok(fraction)) return DASH;
  return fmtNumber(fraction * 100, decimals, opts) + '%';
}

/** Value already in percent (0-100). */
export function fmtChance(pct, decimals = 2) {
  if (!ok(pct)) return DASH;
  return fmtNumber(pct, decimals) + '%';
}

/** [lo, hi] fractions to "−20.1 … −4.5%". */
export function fmtCI(ci, decimals = 1) {
  if (!Array.isArray(ci) || !ok(ci[0]) || !ok(ci[1])) return '';
  return `${fmtNumber(ci[0] * 100, decimals)} ${DASH} ${fmtNumber(ci[1] * 100, decimals)}%`;
}

export function fmtRatio(v, decimals = 3) {
  return ok(v) ? fmtNumber(v, decimals) : DASH;
}

export function fmtMult(v) {
  return ok(v) ? 'x' + fmtNumber(v, 2) : DASH;
}

export function fmtP(p) {
  if (!ok(p)) return DASH;
  if (p < 0.001) return '<' + NBSP + '0.001';
  return p.toFixed(3);
}

/** "p = 0.123" or "p < 0.001". */
export function fmtPEq(p) {
  if (!ok(p)) return 'p = ' + DASH;
  return p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3);
}

export function fmtZ(z) {
  return ok(z) ? fmtNumber(z, 2) : DASH;
}

/** CSS class for the sign of a value. */
export function signClass(v) {
  if (!ok(v) || Math.abs(v) < 1e-9) return '';
  return v > 0 ? 'pos' : 'neg';
}

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(ts) {
  if (!ok(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateShort(ts) {
  if (!ok(ts)) return DASH;
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtTime(ts) {
  if (!ok(ts)) return DASH;
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(ts) {
  if (!ok(ts)) return DASH;
  return `${fmtDateShort(ts)} ${fmtTime(ts)}`;
}

export function fmtDuration(ms) {
  if (!ok(ms) || ms < 0) return DASH;
  const min = Math.round(ms / 60000);
  if (min < 1) return '<' + NBSP + '1 min';
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ok(ts)) return 'never';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
