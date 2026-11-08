// ─────────────────────────────────────────────────────────────────────────────
// Paper-ledger helpers: Indian market charges model + persistence.
// Charges are ESTIMATES for realism — verify against your broker's contract note.
// ─────────────────────────────────────────────────────────────────────────────

export const INITIAL_CAPITAL = 1_000_000; // ₹10,00,000 paper capital
export const DAILY_LOSS_LIMIT = 25_000;    // ₹ — auto-HALT when breached
export const MAX_ORDER_NOTIONAL = 200_000; // ₹ per-order guard
export const MAX_QTY = 10_000;

// Delivery (CNC) charges estimate: brokerage 0 for delivery at Groww; show full stack
export function estimateCharges(side, qty, price, product) {
  const turnover = qty * price;
  const brokerage = product === 'MIS' ? Math.min(20, turnover * 0.0003) : 0;
  const stt = side === 'SELL' ? turnover * 0.001 : turnover * 0.001; // 0.1% both sides for delivery; simplified
  const exchangeTxn = turnover * 0.0000345;   // NSE
  const gst = (brokerage + exchangeTxn) * 0.18;
  const sebi = turnover * 0.000001;           // ₹10 per crore
  const stamp = side === 'BUY' ? turnover * 0.00015 : 0;
  const total = brokerage + stt + exchangeTxn + gst + sebi + stamp;
  return { brokerage, stt, exchangeTxn, gst, sebi, stamp, total: round2(total) };
}

export function formatINR(n, opts = {}) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-IN', {
    maximumFractionDigits: opts.decimals ?? 2,
    minimumFractionDigits: opts.decimals ?? 2,
  });
  return `${sign}₹${s}`;
}

export function formatSignedINR(n) {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function formatNumberIN(n, decimals = 2) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function round2(n) { return Math.round(n * 100) / 100; }

// Apply a fill to the ledger → new positions array + realized P&L of the closing part.
// Same-side adds average in; opposite-side fills reduce/flip and realize P&L.
export function applyFillToPositions(positions, fill) {
  const { symbol, side, qty, price, product } = fill;
  const next = positions.map(p => ({ ...p }));
  const round2 = (n) => Math.round(n * 100) / 100;

  const sameIdx = next.findIndex(p => p.symbol === symbol && p.product === product && p.side === side);
  if (sameIdx >= 0) {
    const p = next[sameIdx];
    const totalQty = p.qty + qty;
    p.avg = round2((p.avg * p.qty + price * qty) / totalQty);
    p.qty = totalQty;
    return { positions: next, realized: 0, closed: 0, wins: 0 };
  }

  const oppSide = side === 'BUY' ? 'SELL' : 'BUY';
  const oppIdx = next.findIndex(p => p.symbol === symbol && p.product === product && p.side === oppSide);
  if (oppIdx < 0) {
    next.push({
      id: `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      symbol, side, qty, avg: round2(price), product, openedAt: Date.now(),
    });
    return { positions: next, realized: 0, closed: 0, wins: 0 };
  }

  const p = next[oppIdx];
  const closing = Math.min(p.qty, qty);
  const dir = p.side === 'BUY' ? 1 : -1;
  const realized = round2((price - p.avg) * closing * dir);
  p.qty -= closing;
  if (p.qty === 0) next.splice(oppIdx, 1);
  const leftover = qty - closing;
  if (leftover > 0) {
    next.push({
      id: `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      symbol, side, qty: leftover, avg: round2(price), product, openedAt: Date.now(),
    });
  }
  return { positions: next, realized, closed: 1, wins: realized >= 0 ? 1 : 0 };
}

const LS_POSITIONS = 'qlibpro.positions.v1';
const LS_ORDERS = 'qlibpro.orders.v1';
const LS_EQUITY = 'qlibpro.equity.v1';

function safeParse(raw, fallback) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

export const store = {
  loadPositions: () => safeParse(localStorage.getItem(LS_POSITIONS), []),
  loadOrders: () => safeParse(localStorage.getItem(LS_ORDERS), []),
  loadEquity: () => safeParse(localStorage.getItem(LS_EQUITY), [INITIAL_CAPITAL]),
  savePositions: (p) => localStorage.setItem(LS_POSITIONS, JSON.stringify(p)),
  saveOrders: (o) => localStorage.setItem(LS_ORDERS, JSON.stringify(o)),
  saveEquity: (e) => localStorage.setItem(LS_EQUITY, JSON.stringify(e.slice(-240))),
  clearAll() {
    localStorage.removeItem(LS_POSITIONS);
    localStorage.removeItem(LS_ORDERS);
    localStorage.removeItem(LS_EQUITY);
  },
};
