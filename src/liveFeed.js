// ─────────────────────────────────────────────────────────────────────────────
// QlibPro live market-data facade.
// PAPER mode  → the seeded simulator in marketSim.js (explicitly opt-in via the
//               PAPER toggle in Settings; persisted in localStorage qlibpro.paper)
// LIVE mode   → real Groww Trading API data via the server proxy:
//               /api/ltp      (batched CASH LTP, indices + stocks)
//               /api/candles  (OHLCV history — feeds charts, signals, heatmap)
//               /api/quote    (full snapshot incl. depth for the ladder)
// There is NO mock fallback: when Groww is not connected every consumer gets
// nulls and renders dashes / empty states. Paper simulation stays available
// behind the toggle, clearly badged.
// ─────────────────────────────────────────────────────────────────────────────
import { engine as paperEngine, INSTRUMENTS, INDICES, TF_SECONDS, TF_LABEL, nseOpenNow } from './marketSim.js';

export { INSTRUMENTS, INDICES, TF_SECONDS, TF_LABEL, nseOpenNow };

const ALL = [...INSTRUMENTS, ...INDICES];
const PAPER_KEY = 'qlibpro.paper';

export function isPaperEnabled() {
  try { return localStorage.getItem(PAPER_KEY) === '1'; } catch { return false; }
}
export function setPaperEnabled(on) {
  try { localStorage.setItem(PAPER_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('qlibpro:paper', { detail: on }));
}

const state = {
  connected: false,
  error: null,          // last fetch error / reason (null when healthy)
  ltp: {}, prevClose: {}, open: {}, high: {}, low: {}, volume: {}, dir: {},
  lastLtpAt: 0, lastDailyAt: 0, last5mAt: 0, lastLatencyMs: null,
  candles5m: {}, candles1d: {},
  depth: {}, depthAt: {},
  depthShapeSeen: false,
};
export const liveState = state; // read-only-ish, for status chips

const now = () => Date.now();
const stale = (at, ttlMs) => !at || now() - at > ttlMs;
const round2 = (n) => Math.round(n * 100) / 100;

async function jfetch(url) {
  const t0 = performance.now();
  const r = await fetch(url);
  const j = await r.json().catch(() => ({ ok: false, reason: 'bad JSON from server' }));
  j.__latencyMs = Math.round(performance.now() - t0);
  return j;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

export async function refreshLtp() {
  const j = await jfetch('/api/ltp?symbols=' + ALL.map(i => i.symbol).join(','));
  if (j.ok) {
    state.connected = true; state.error = null; state.lastLatencyMs = j.__latencyMs; state.lastLtpAt = now();
    for (const sym of Object.keys(j.ltp || {})) {
      const prev = state.ltp[sym];
      const v = typeof j.ltp[sym] === 'number' && Number.isFinite(j.ltp[sym]) ? j.ltp[sym] : null;
      if (v != null) state.dir[sym] = prev == null ? 0 : Math.sign(v - prev);
      state.ltp[sym] = v;
    }
    // symbols absent from the map (e.g. unknown index symbol) get an explicit null → dashes
    for (const meta of ALL) if (!(meta.symbol in state.ltp)) state.ltp[meta.symbol] = null;
    return true;
  }
  state.connected = false;
  state.error = j.reason || 'Groww LTP unavailable';
  state.lastLatencyMs = j.__latencyMs;
  return false;
}

export async function refreshDaily() {
  await mapLimit(ALL, 4, async (s) => {
    const j = await jfetch(`/api/candles?symbol=${s.symbol}&minutes=1440&days=12`);
    if (j.ok && Array.isArray(j.candles) && j.candles.length) {
      const rows = j.candles.map(c => ({ time: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
      state.candles1d[s.symbol] = rows;
      const today = rows[rows.length - 1];
      const prev = rows.length >= 2 ? rows[rows.length - 2] : null;
      state.prevClose[s.symbol] = prev ? prev.close : today.open;
      state.open[s.symbol] = today.open;
      state.high[s.symbol] = today.high;
      state.low[s.symbol] = today.low;
      state.volume[s.symbol] = today.volume;
    }
  });
  state.lastDailyAt = now();
}

export async function refresh5m() {
  await mapLimit(ALL, 4, async (s) => {
    const j = await jfetch(`/api/candles?symbol=${s.symbol}&minutes=5&days=18`);
    if (j.ok && Array.isArray(j.candles) && j.candles.length) {
      state.candles5m[s.symbol] = j.candles.map(c => ({ time: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
    }
  });
  state.last5mAt = now();
}

export async function refreshDepth(symbol) {
  const j = await jfetch('/api/quote?symbol=' + symbol);
  if (!j.ok) { state.depth[symbol] = null; state.depthAt[symbol] = now(); return null; }
  state.depth[symbol] = normaliseDepth(j.groww);
  state.depthAt[symbol] = now();
  return state.depth[symbol];
}

// Tolerant normaliser for Groww's quote payload market-depth block.
// Returns { bids:[{price,qty,cum}], asks:[...reversed], spread } like the paper engine, or null.
function normaliseDepth(g) {
  const d = g?.payload?.depth ?? g?.depth ?? g?.market_depth ?? g?.payload ?? null;
  const pickArr = (a) => Array.isArray(a) ? a : null;
  const mapSide = (arr) => {
    if (!arr) return null;
    const out = [];
    for (const x of arr) {
      const price = Number(x?.price ?? x?.p ?? x?.rate);
      const qty = Number(x?.quantity ?? x?.qty ?? x?.q ?? x?.size);
      if (Number.isFinite(price) && Number.isFinite(qty)) out.push({ price: round2(price), qty });
    }
    return out.length ? out : null;
  };
  let bids = mapSide(pickArr(d?.buy) ?? pickArr(d?.buy_depth) ?? pickArr(d?.bids) ?? pickArr(d?.BID));
  let asks = mapSide(pickArr(d?.sell) ?? pickArr(d?.sell_depth) ?? pickArr(d?.asks) ?? pickArr(d?.ASK));
  // some payloads ship arrays of arrays
  const pickRaw = (a) => Array.isArray(a) && Array.isArray(a[0]) ? a.map(r => ({ price: r[0], qty: r[1] })) : null;
  bids = bids ?? mapSide(pickRaw(d?.buy) ?? pickRaw(d?.bids));
  asks = asks ?? mapSide(pickRaw(d?.sell) ?? pickRaw(d?.asks));
  if (!bids || !asks) return null;
  bids = bids.slice(0, 9);
  asks = asks.slice(0, 9);
  const spread = asks.length && bids.length ? round2(asks[0].price - bids[0].price) : 0; // best ask − best bid (both arrays best-first at this point)
  const withCum = (arr) => { let cum = 0; return arr.map(x => ({ ...x, cum: (cum += x.qty) })); };
  return { bids: withCum(bids), asks: withCum(asks).reverse(), spread };
}

function aggregate(rows, bucket) {
  if (!rows?.length) return [];
  const out = [];
  let cur = null;
  for (const r of rows) {
    const key = Math.floor(r.time / (TF_SECONDS['5m'] * bucket)) * (TF_SECONDS['5m'] * bucket);
    if (!cur || key > cur.time) {
      if (cur) out.push(cur);
      cur = { time: key, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += r.volume;
    }
  }
  if (cur) out.push(cur);
  return out.map(c => ({ ...c, open: round2(c.open), high: round2(c.high), low: round2(c.low), close: round2(c.close) }));
}

// kick live fetches (fire-and-forget; renders happen on the App's tick loop)
function liveTick() {
  if (stale(state.lastLtpAt, 1200)) {
    state.lastLtpAt = now(); // throttle immediately
    refreshLtp();
  }
  if (stale(state.lastDailyAt, 5 * 60_000)) { state.lastDailyAt = now(); refreshDaily(); }
  if (stale(state.last5mAt, 60_000)) { state.last5mAt = now(); refresh5m(); }
}

function liveInstrument(meta) {
  const ltp = state.ltp[meta.symbol];
  return {
    ...meta,
    ltp: ltp == null ? null : ltp,
    prevClose: state.prevClose[meta.symbol] ?? null,
    open: state.open[meta.symbol] ?? null,
    high: state.high[meta.symbol] ?? null,
    low: state.low[meta.symbol] ?? null,
    volume: state.volume[meta.symbol] ?? 0,
    dir: state.dir[meta.symbol] ?? 0,
    tickCount: 0,
  };
}

// ── facade — mirrors marketSim.engine's interface ───────────────────────────
class FacadeEngine {
  get breadth() { return isPaperEnabled() ? paperEngine.breadth : null; }

  get(symbol) {
    if (isPaperEnabled()) return paperEngine.get(symbol);
    const meta = ALL.find(i => i.symbol === symbol);
    return meta ? liveInstrument(meta) : undefined;
  }

  list() { return ALL.map(m => this.get(m.symbol)); }

  tick() { if (isPaperEnabled()) paperEngine.tick(); else liveTick(); }

  change(symbol) {
    if (isPaperEnabled()) return paperEngine.change(symbol);
    const ltp = state.ltp[symbol], pc = state.prevClose[symbol];
    if (ltp == null || pc == null || pc === 0) return null;
    const chg = ltp - pc;
    return { chg, pct: (chg / pc) * 100 };
  }

  candles(symbol, tf = '5m', count = 160) {
    if (isPaperEnabled()) return paperEngine.candles(symbol, tf, count);
    let rows = null;
    if (tf === '5m') rows = state.candles5m[symbol];
    else if (tf === '15m') rows = aggregate(state.candles5m[symbol], 3);
    else if (tf === '1H') rows = aggregate(state.candles5m[symbol], 12);
    else if (tf === '1D') rows = state.candles1d[symbol];
    else if (tf === '1m') rows = []; // 1-minute bars intentionally not fetched (rate budget)
    return rows ? rows.slice(-count) : [];
  }

  sparkline(symbol, points = 30) {
    if (isPaperEnabled()) return paperEngine.sparkline(symbol, points);
    const rows = state.candles1d[symbol];
    if (!rows || rows.length < 2) return [];
    return rows.slice(-points).map(r => r.close);
  }

  depth(symbol, levels = 9) {
    if (isPaperEnabled()) return paperEngine.depth(symbol, levels);
    if (stale(state.depthAt[symbol], 2500)) { state.depthAt[symbol] = now(); refreshDepth(symbol); }
    const d = state.depth[symbol];
    return d ? { bids: d.bids.slice(0, levels), asks: d.asks.slice(-levels), spread: d.spread } : null;
  }

  tape() {
    if (isPaperEnabled()) return paperEngine.tape();
    // live marquee — from real indices; FX omitted (no source on Groww equity API)
    const out = [];
    const NAV = [['NIFTY 50', 'NIFTY50', 'index'], ['BANKNIFTY', 'BANKNIFTY', 'index'], ['SENSEX', 'SENSEX', 'index'], ['INDIA VIX', 'INDIAVIX', 'vix'], ['NIFTY IT', 'NIFTYIT', 'index'], ['NIFTY FIN', 'FINNIFTY', 'index'], ['NIFTY 500', 'NIFTY500', 'index']];
    for (const [label, sym, kind] of NAV) {
      const ltp = state.ltp[sym]; const ch = this.change(sym);
      if (ltp == null) continue;
      out.push({ symbol: label, value: ltp, chg: ch ? round2(ch.pct) : 0, kind });
    }
    return out;
  }
}

export const engine = new FacadeEngine();
