// Numeric building blocks for the stats module. Pure functions, no dependencies.

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const EPS = 1e-15;
const TINY = 1e-300;
const MAX_ITER = 500;

/** Natural log of the gamma function (Lanczos approximation, g = 7). */
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized lower incomplete gamma P(a, x) by series; converges fast for x < a + 1.
function gammaSeries(a, x) {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < MAX_ITER; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

// Regularized upper incomplete gamma Q(a, x) by Lentz continued fraction; for x >= a + 1.
function gammaContinuedFraction(a, x) {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Regularized upper incomplete gamma function Q(a, x) = 1 - P(a, x). */
export function gammaQ(a, x) {
  if (!(x > 0)) return 1;
  if (!Number.isFinite(x)) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/** Survival function of the chi-square distribution: P(X >= x), X ~ chi2(df). */
export function chiSquareSf(x, df) {
  if (!(df > 0) || Number.isNaN(x)) return NaN;
  return gammaQ(df / 2, x / 2);
}

// Continued fraction for the regularized incomplete beta function.
function betaContinuedFraction(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function betaI(x, a, b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Survival function of the F distribution: P(F >= f) with (d1, d2) degrees of freedom. */
export function fSf(f, d1, d2) {
  if (!(d1 > 0) || !(d2 > 0) || Number.isNaN(f)) return NaN;
  if (f <= 0) return 1;
  if (!Number.isFinite(f)) return 0;
  return betaI(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x) {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  // erfc(|x|/sqrt2) = Q(1/2, x^2/2), so the lower tail is half of that.
  const tail = 0.5 * gammaQ(0.5, (x * x) / 2);
  return x < 0 ? tail : 1 - tail;
}

/** Two-sided p-value for a standard normal statistic. */
export function normalTwoSidedP(z) {
  if (Number.isNaN(z)) return NaN;
  return gammaQ(0.5, (z * z) / 2);
}

/**
 * Wilson score interval for a proportion.
 * Returns [0, 1] (no information) when n <= 0.
 * @param {number} k successes
 * @param {number} n trials
 * @param {number} [z] normal quantile, 1.96 for 95%
 * @returns {[number, number]}
 */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return [0, 1];
  const p = Math.min(Math.max(k / n, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Holm-Bonferroni step-down procedure.
 * Non-finite p-values are untestable: they are never rejected and do not count towards m.
 * @param {Array<number|null>} pValues
 * @param {number} [alpha]
 * @returns {boolean[]} true where the null hypothesis is rejected
 */
export function holm(pValues, alpha = 0.05) {
  const out = pValues.map(() => false);
  const order = pValues
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const m = order.length;
  for (let rank = 0; rank < m; rank++) {
    if (order[rank].p > alpha / (m - rank)) break;
    out[order[rank].i] = true;
  }
  return out;
}

/**
 * Poisson-binomial normal approximation for a win count.
 * z = (W - sum p) / sqrt(sum p(1-p)); returns nulls when the variance is zero.
 * @returns {{z:number|null, p:number|null}}
 */
export function poissonBinomialZ(wins, sumP, sumVar) {
  if (!(sumVar > 1e-12)) return { z: null, p: null };
  const z = (wins - sumP) / Math.sqrt(sumVar);
  return { z, p: normalTwoSidedP(z) };
}

/** Binomial probability mass function: array of P(K = k) for k = 0..n. */
export function binomialPmf(n, p) {
  const pmf = new Array(n + 1).fill(0);
  if (p <= 0) { pmf[0] = 1; return pmf; }
  if (p >= 1) { pmf[n] = 1; return pmf; }
  const lnFactN = lnGamma(n + 1);
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  for (let k = 0; k <= n; k++) {
    const logC = lnFactN - lnGamma(k + 1) - lnGamma(n - k + 1);
    pmf[k] = Math.exp(logC + k * lp + (n - k) * lq);
  }
  return pmf;
}

/** Smallest k whose cumulative probability reaches q. */
export function pmfQuantile(pmf, q) {
  let cum = 0;
  for (let k = 0; k < pmf.length; k++) {
    cum += pmf[k];
    if (cum >= q - 1e-12) return k;
  }
  return pmf.length - 1;
}

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Sample standard deviation (n - 1 denominator). */
export function sampleSd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * One-way ANOVA F test over groups of numbers. Empty groups are ignored.
 * Returns nulls (df 0) with fewer than 2 groups or no within-group degrees of freedom,
 * and a null statistic/p when the within-group variance is zero.
 * @param {number[][]} groups
 * @returns {{statistic:number|null, df:number, dfWithin:number, p:number|null}}
 */
export function oneWayAnova(groups) {
  const gs = groups.filter((g) => g.length > 0);
  const k = gs.length;
  const total = gs.reduce((s, g) => s + g.length, 0);
  if (k < 2 || total - k < 1) return { statistic: null, df: 0, dfWithin: 0, p: null };
  const grand = mean(gs.flat());
  let ssBetween = 0;
  let ssWithin = 0;
  for (const g of gs) {
    const m = mean(g);
    ssBetween += g.length * (m - grand) ** 2;
    ssWithin += g.reduce((s, x) => s + (x - m) ** 2, 0);
  }
  const df = k - 1;
  const dfWithin = total - k;
  if (!(ssWithin > 0)) return { statistic: null, df, dfWithin, p: null };
  const statistic = ssBetween / df / (ssWithin / dfWithin);
  return { statistic, df, dfWithin, p: fSf(statistic, df, dfWithin) };
}
