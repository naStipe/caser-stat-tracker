// Outcome range and expected value of one case, from the site's published contents.

/**
 * @param {import('../capture/caseinfo.js').CaseInfo} info
 * @returns {{
 *   n: number, casePrice: number,
 *   min: {name:string, price:number}|null, max: {name:string, price:number}|null,
 *   hasChances: boolean, chanceSum: number|null,
 *   ev: number|null, evRatio: number|null,   // EV per open, and EV / case price
 *   items: Array<CaseItem & {mult: number|null}>  // sorted by price, highest first
 * }}
 */
export function caseOdds(info) {
  const items = Array.isArray(info?.items) ? info.items : [];
  const casePrice = Number(info?.price) > 0 ? Number(info.price) : 0;
  const sorted = items
    .map((i) => ({ ...i, mult: casePrice > 0 ? i.price / casePrice : null }))
    .sort((a, b) => b.price - a.price || String(a.name).localeCompare(String(b.name)));

  // Chances count only when every item has one and they add up to about 100%.
  const withChance = sorted.filter((i) => typeof i.chance === 'number' && Number.isFinite(i.chance));
  const chanceSum = withChance.length ? withChance.reduce((s, i) => s + i.chance, 0) : null;
  const hasChances = sorted.length > 0 && withChance.length === sorted.length && Math.abs(chanceSum - 100) < 0.5;

  // EV uses the chances normalized to 100%, so rounding in the site's numbers does not skew it.
  const ev = hasChances ? sorted.reduce((s, i) => s + i.price * (i.chance / chanceSum), 0) : null;
  const pick = (i) => (i ? { name: i.name, price: i.price } : null);
  return {
    n: sorted.length,
    casePrice,
    min: pick(sorted[sorted.length - 1]),
    max: pick(sorted[0]),
    hasChances,
    chanceSum,
    ev,
    evRatio: ev !== null && casePrice > 0 ? ev / casePrice : null,
    items: sorted,
  };
}
