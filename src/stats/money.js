// Money flow: deposits in, withdrawals out, what is still held.
import { num } from '../schema.js';

const DAY_MS = 86400000;

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * Deposits, withdrawals, current holdings and the overall net result.
 * Only deposits with status 'completed' count as money in (others only show in failedN / failedSum).
 * deposits.perDay = sum / days between first and last completed deposit (at least 1 day).
 * holdings = balance + inventoryValue, null when both are unknown (one unknown counts as 0).
 * net = withdrawn value + holdings - deposited sum: positive means you are ahead.
 * series and daily use event ts as given (imported withdrawals have approximate times).
 * @param {object[]} events
 * @param {{balance?:number|null, inventoryValue?:number|null}} [holdingsIn]
 */
export function moneyFlow(events, { balance = null, inventoryValue = null } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const deposits = list.filter((e) => e.kind === 'deposit');
  const done = deposits.filter((e) => e.status === 'completed');
  const failed = deposits.filter((e) => e.status !== 'completed');
  const withdrawals = list.filter((e) => e.kind === 'withdrawal');
  const valueOf = (w) => num(w.value ?? (w.item && w.item.price));

  const sum = done.reduce((s, e) => s + num(e.amount), 0);
  const doneTs = done.map((e) => num(e.ts));
  const firstTs = doneTs.length ? Math.min(...doneTs) : null;
  const lastTs = doneTs.length ? Math.max(...doneTs) : null;
  const withdrawn = withdrawals.reduce((s, w) => s + valueOf(w), 0);
  const known = (balance !== null && balance !== undefined) || (inventoryValue !== null && inventoryValue !== undefined);
  const holdings = known ? num(balance) + num(inventoryValue) : null;

  const moves = [
    ...done.map((e) => ({ ts: num(e.ts), kind: 'deposit', amount: num(e.amount) })),
    ...withdrawals.map((w) => ({ ts: num(w.ts), kind: 'withdrawal', amount: valueOf(w) })),
  ].sort((a, b) => a.ts - b.ts);
  let cumulativeNet = 0;
  const series = moves.map((m) => {
    cumulativeNet += m.kind === 'deposit' ? -m.amount : m.amount;
    return { ...m, cumulativeNet };
  });

  const days = new Map();
  for (const m of moves) {
    const key = dayKey(m.ts);
    const row = days.get(key) ?? { day: key, deposited: 0, withdrawn: 0 };
    if (m.kind === 'deposit') row.deposited += m.amount;
    else row.withdrawn += m.amount;
    days.set(key, row);
  }

  return {
    deposits: {
      n: done.length,
      sum,
      failedN: failed.length,
      failedSum: failed.reduce((s, e) => s + num(e.amount), 0),
      firstTs,
      lastTs,
      perDay: done.length ? sum / Math.max(1, (lastTs - firstTs) / DAY_MS) : null,
    },
    withdrawals: { n: withdrawals.length, value: withdrawn, exactTimeN: withdrawals.filter((w) => w.exactTime === true).length },
    holdings,
    net: withdrawn + (holdings ?? 0) - sum,
    series,
    daily: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
