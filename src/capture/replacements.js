// Item replacement ("Change" on an inventory item): the site offers cheaper items to swap into and credits the
// price difference to the balance.
// GET  /api/inventory/items/{inventoryId}/replacements?limit=50&offset=0 -> [{id, item:{id, marketName, price, image, ...}, price, refund}]
// POST /api/inventory/items/{inventoryId}/replace {itemId} (the tracker never sends this)

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const unwrap = (body) => (obj(body)?.data && typeof body.data === 'object' ? body.data : body);
const numOrNull = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Inventory item id from a replacements request path, else null. */
export function replacementItemId(path) {
  const m = String(path || '').split('?')[0].match(/^\/inventory\/items\/([^/]+)\/replacements$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * @typedef {{id: string, itemId: string, name: string, price: number, refund: number|null, image: string|null}} Candidate
 * @returns {Candidate[]}
 */
export function candidatesFromResponse(body) {
  const d = unwrap(body);
  const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.candidates) ? d.candidates : [];
  const out = [];
  list.forEach((raw, i) => {
    const e = obj(raw);
    if (!e) return;
    const it = obj(e.item) ?? {};
    const name = String(it.marketName ?? e.marketName ?? e.market_name ?? '').trim();
    const price = numOrNull(e.price ?? it.price);
    if (!name || price === null) return;
    out.push({
      id: String(e.id ?? it.id ?? i),
      itemId: String(it.id ?? e.id ?? ''),
      name,
      price,
      refund: numOrNull(e.refund),
      image: typeof (it.image ?? e.image) === 'string' ? it.image ?? e.image : null,
    });
  });
  return out;
}
