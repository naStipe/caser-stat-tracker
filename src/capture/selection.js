// Reads the upgrade the user has currently selected on the upgrade page, for the overlay.
// The site keeps the selection in a private store, so it is read from the page through the
// site's own data-testid attributes. Desktop and mobile use different names (checked on caser.gg 2026-11-04):
// desktop "upgrade-user-items-card" / "upgrade-user-single-item-card" and "upgrade-desired-target-card" inside
// "upgrade-desired-card"; mobile names end in "own-item-card" / "own-multi-card" and "target-item-card".

const PRICE_RE = /^\d[\d\s  ]*(?:[.,]\d+)?$/;

/** "1 234,56" / "26,14" / "26.14" -> number */
export function parsePrice(text) {
  const t = String(text).replace(/[\s  ]/g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function firstPrice(card) {
  if (!card) return null;
  for (const el of card.querySelectorAll('span, div')) {
    if (el.children.length) continue;
    const t = el.textContent.trim();
    if (PRICE_RE.test(t)) return parsePrice(t);
  }
  return null;
}

const OWN_SELECTORS = [
  '[data-testid="upgrade-user-single-item-card"]',
  '[data-testid="upgrade-user-items-card"]',
  '[data-testid$="own-item-card"]',
  '[data-testid$="own-multi-card"]',
];
const TARGET_SELECTORS = [
  '[data-testid="upgrade-desired-target-card"]',
  '[data-testid="upgrade-desired-card"]',
  '[data-testid$="target-item-card"]',
];

/** First match, trying the selectors in order (most specific first). */
function findCard(doc, selectors) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** @returns {{stake:number, targetPrice:number, chanceShown:number|null} | null} */
export function readUpgradeSelection(doc) {
  if (!/\/upgrade(\/|$)/.test(doc.location.pathname)) return null;
  const own = findCard(doc, OWN_SELECTORS);
  const target = findCard(doc, TARGET_SELECTORS);
  if (!own || !target) return null;

  const targetPrice = firstPrice(target);
  if (!(targetPrice > 0)) return null; // nothing chosen, or mystery mode (target hidden)
  const ownPrice = firstPrice(own);
  if (!(ownPrice > 0)) return null; // the site keeps a target after the stake is cleared

  const chanceText = doc.querySelector('[data-testid="upgrade-spinner-chance-value"]')?.textContent ?? '';
  const chanceShown = parsePrice(chanceText.replace('%', ''));

  // The site shows chance = stake / target * 103 %. Below 100% that gives the exact stake,
  // including several items and added balance. At the 100% cap fall back to the card's price.
  let stake = null;
  if (chanceShown !== null && chanceShown > 0 && chanceShown < 100) stake = (chanceShown / 103) * targetPrice;
  else stake = ownPrice;
  if (!(stake > 0)) return null;

  return { stake, targetPrice, chanceShown };
}
