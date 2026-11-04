// JSON and CSV export, JSON import.

import { SCHEMA_VERSION } from '../schema.js';

export function toJson(events) {
  return JSON.stringify({ app: 'caser-stat-tracker', schema: SCHEMA_VERSION, exportedAt: new Date().toISOString(), events }, null, 2);
}

const CSV_COLUMNS = [
  ['id', (e) => e.id],
  ['kind', (e) => e.kind],
  ['time', (e) => new Date(e.ts).toISOString()],
  ['site', (e) => e.site],
  ['source', (e) => e.source],
  ['cost', (e) => (e.kind === 'case' ? e.casePrice : e.stake)],
  ['returned', (e) => (e.kind === 'case' ? e.item.price : e.returned)],
  ['net', (e) => (e.kind === 'case' ? e.item.price - e.casePrice : e.net)],
  ['case', (e) => (e.kind === 'case' ? e.caseName : '')],
  ['drop', (e) => (e.kind === 'case' ? e.item.name : '')],
  ['free', (e) => (e.kind === 'case' ? e.free : '')],
  ['bet_items', (e) => (e.kind === 'upgrade' ? e.betItems.map((i) => i.name).join(' + ') : '')],
  ['added_balance', (e) => (e.kind === 'upgrade' ? e.addedBalance : '')],
  ['target', (e) => (e.kind === 'upgrade' ? e.target?.name ?? '' : '')],
  ['target_price', (e) => (e.kind === 'upgrade' ? e.target?.price ?? '' : '')],
  ['chance_shown', (e) => (e.kind === 'upgrade' ? e.chanceShown : '')],
  ['status', (e) => (e.kind === 'upgrade' ? e.status : '')],
  ['mystery', (e) => (e.kind === 'upgrade' ? e.mystery : '')],
  ['game_mode', (e) => e.gameMode],
  ['balance_before', (e) => e.balanceBefore ?? ''],
  ['balance_after', (e) => e.balanceAfter ?? ''],
];

export function toCsv(events) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const e of events) lines.push(CSV_COLUMNS.map(([, f]) => esc(f(e))).join(','));
  return lines.join('\n');
}

/** Accepts our own export file. Returns the events array or throws with a readable message. */
export function fromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  const events = Array.isArray(data) ? data : data?.events;
  if (!Array.isArray(events)) throw new Error('File has no events list.');
  const valid = events.filter((e) => e && typeof e.id === 'string' && (e.kind === 'case' || e.kind === 'upgrade') && Number.isFinite(e.ts));
  if (!valid.length && events.length) throw new Error('No valid events in file.');
  return valid;
}
