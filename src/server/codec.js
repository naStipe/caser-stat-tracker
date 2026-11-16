// JSON for the stats server's requests and answers. Shared by the server and the userscript.

// ---- JSON with Infinity and NaN ----
// Bucket edges end at Infinity, which plain JSON turns into null. Both directions use these.
const INF = '__inf__';
const NINF = '__-inf__';
const NAN = '__nan__';

export function encode(value) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? NAN : v > 0 ? INF : NINF;
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    }),
  );
}

export function decode(value) {
  if (value === INF) return Infinity;
  if (value === NINF) return -Infinity;
  if (value === NAN) return NaN;
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}
