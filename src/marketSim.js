// ─────────────────────────────────────────────────────────────────────────────
// QlibPro market simulation engine — deterministic, seeded, in-memory.
// Produces realistic OHLCV candles, LTP ticks, sparklines, depth ladder and
// market breadth for liquid NSE symbols. Swap interface for Groww live feed
// in Phase 2 without changing the UI. Feed is clearly badged SIMULATED.
// ─────────────────────────────────────────────────────────────────────────────

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// `base` ≈ plausible Nov-2026 levels (fictional feed — for UI/paper use only)
export const INSTRUMENTS = [
  { symbol: 'RELIANCE',   name: 'Reliance Industries', type: 'stock', exchange: 'NSE', base: 3085.50, lot: 250,  sector: 'Energy' },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',           type: 'stock', exchange: 'NSE', base: 1012.40, lot: 550,  sector: 'Bank' },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',          type: 'stock', exchange: 'NSE', base: 1402.75, lot: 700,  sector: 'Bank' },
  { symbol: 'INFY',       name: 'Infosys',             type: 'stock', exchange: 'NSE', base: 2048.30, lot: 400,  sector: 'IT' },
  { symbol: 'TCS',        name: 'Tata Consultancy',    type: 'stock', exchange: 'NSE', base: 3221.60, lot: 175,  sector: 'IT' },
  { symbol: 'SBIN',       name: 'State Bank of India', type: 'stock', exchange: 'NSE', base: 836.20,  lot: 750,  sector: 'Bank' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel',       type: 'stock', exchange: 'NSE', base: 1742.10, lot: 475,  sector: 'Telecom' },
  { symbol: 'ITC',        name: 'ITC',                 type: 'stock', exchange: 'NSE', base: 468.90,  lot: 1600, sector: 'FMCG' },
  { symbol: 'LT',         name: 'Larsen & Toubro',     type: 'stock', exchange: 'NSE', base: 3642.00, lot: 150,  sector: 'Infra' },
  { symbol: 'TATAMOTORS', name: 'Tata Motors',         type: 'stock', exchange: 'NSE', base: 968.35,  lot: 550,  sector: 'Auto' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance',       type: 'stock', exchange: 'NSE', base: 913.50,  lot: 750,  sector: 'NBFC' },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',       type: 'stock', exchange: 'NSE', base: 10980.00, lot: 100, sector: 'Auto' },
];

// Indian benchmarks — selectable for charting/scanning.
// NOTE: indices are not directly orderable on Groww; live execution needs F&O.
// Paper fills are simulated. Lot sizes shown are indicative (NSE circular prevails).
export const INDICES = [
  { symbol: 'NIFTY50',   name: 'Nifty 50',            type: 'index', exchange: 'NSE', base: 25712.40, lot: 75, sector: 'Index' },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank',          type: 'index', exchange: 'NSE', base: 57318.85, lot: 30, sector: 'Index' },
  { symbol: 'SENSEX',    name: 'BSE Sensex',          type: 'index', exchange: 'BSE', base: 84132.20, lot: 20, sector: 'Index' },
  { symbol: 'NIFTYIT',   name: 'Nifty IT',            type: 'index', exchange: 'NSE', base: 38941.15, lot: 0,  sector: 'Index' },
  { symbol: 'FINNIFTY',  name: 'Nifty Fin Services',  type: 'index', exchange: 'NSE', base: 26108.55, lot: 65, sector: 'Index' },
  { symbol: 'NIFTY500',  name: 'Nifty 500',           type: 'index', exchange: 'NSE', base: 24122.90, lot: 0,  sector: 'Index' },
  { symbol: 'MIDCAP100', name: 'Nifty Midcap 100',    type: 'index', exchange: 'NSE', base: 53874.60, lot: 0,  sector: 'Index' },
  { symbol: 'INDIAVIX',  name: 'India VIX',           type: 'vix',   exchange: 'NSE', base: 12.86,    lot: 0,  sector: 'Volatility' },
];

const ALL_INSTRUMENTS = [...INSTRUMENTS, ...INDICES];

export const TAPE = [
  { symbol: 'NIFTY 50',   value: 25712.40, chg: 0.62, kind: 'index' },
  { symbol: 'BANKNIFTY',  value: 57318.85, chg: 0.84, kind: 'index' },
  { symbol: 'SENSEX',     value: 84132.20, chg: 0.58, kind: 'index' },
  { symbol: 'INDIA VIX',  value: 12.86,    chg: -4.10, kind: 'vix' },
  { symbol: 'NIFTY IT',   value: 38941.15, chg: -0.34, kind: 'index' },
  { symbol: 'NIFTY FIN',  value: 26108.55, chg: 0.71, kind: 'index' },
  { symbol: 'INDIA 500',  value: 24122.90, chg: 0.49, kind: 'index' },
  { symbol: 'USD/INR',    value: 88.42,    chg: 0.08, kind: 'fx' },
];

export const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '1D': 86400 };
export const TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1H': '1H', '1D': '1D' };

class MarketEngine {
  constructor() {
    this.instruments = {};
    for (const ins of ALL_INSTRUMENTS) {
      const rnd = mulberry32(hashStr(ins.symbol + ':init'));
      const prevClose = ins.base * (0.985 + rnd() * 0.03);
      const open = prevClose * (1 + (rnd() - 0.5) * 0.012);
      this.instruments[ins.symbol] = {
        ...ins,
        prevClose,
        open,
        high: Math.max(open, ins.base),
        low: Math.min(open, ins.base),
        ltp: ins.base,
        volume: Math.floor(rnd() * 4_000_000) + 800_000,
        dir: 0, // -1 down, 0 flat, 1 up (flash marker)
        tickCount: 0,
      };
    }
    // breadth snapshot (simulated)
    this.breadth = { advancing: 1642, declining: 1187, unchanged: 210, pcr: 0.92, unchangedAll: 210 };
    this._candleCache = new Map();
    this._lastCandleKey = new Map();
  }

  get(symbol) { return this.instruments[symbol]; }
  list() { return INSTRUMENTS.map(i => this.instruments[i.symbol]); }

  // One simulated tick across all instruments + breadth drift
  tick() {
    for (const sym of Object.keys(this.instruments)) {
      const s = this.instruments[sym];
      // mean-reverting micro random walk, sigma scales with price
      const sigma = s.ltp * 0.00085;
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // approx normal in [-1,1]
      const drift = (s.prevClose - s.ltp) * 0.0006; // gentle pull to anchor
      const next = Math.max(1, s.ltp + shock * sigma + drift);
      s.dir = next > s.ltp ? 1 : next < s.ltp ? -1 : 0;
      s.ltp = next;
      s.high = Math.max(s.high, next);
      s.low = Math.min(s.low, next);
      s.volume += Math.floor(Math.random() * 4200) + 120;
      s.tickCount += 1;
    }
    // breadth random walk, keep inside sane band
    const b = this.breadth;
    b.advancing = Math.min(2400, Math.max(600, b.advancing + Math.round((Math.random() - 0.45) * 24)));
    b.declining = Math.min(2400, Math.max(600, b.declining + Math.round((Math.random() - 0.55) * 24)));
    b.pcr = Math.min(1.6, Math.max(0.4, b.pcr + (Math.random() - 0.5) * 0.02));
  }

  change(sym) {
    const s = this.instruments[sym];
    const chg = s.ltp - s.prevClose;
    return { chg, pct: (chg / s.prevClose) * 100 };
  }

  // Deterministic candle series ending near current LTP.
  // Walk backwards from LTP so the latest close is consistent with the tape.
  candles(symbol, tf = '5m', count = 160) {
    const key = `${symbol}:${tf}:${count}`;
    const s = this.instruments[symbol];
    const anchor = Math.round(s.ltp * 100) / 100;
    const cacheKey = key + ':' + Math.floor(s.tickCount / 20); // refresh occasionally
    if (this._candleCache.has(cacheKey)) return this._candleCache.get(cacheKey);

    const rnd = mulberry32(hashStr(key));
    const step = TF_SECONDS[tf] || 300;
    const now = Math.floor(Date.now() / 1000);
    const end = now - (now % step);
    const volBase = 80000 + rnd() * 320000;

    const arr = new Array(count);
    // Walk backwards from the live LTP so the newest candle closes at the tape price.
    // close(i) = open(i+1), giving a consistent OHLC chain across the series.
    let nextOpen = anchor;
    for (let i = count - 1; i >= 0; i--) {
      const t = end - (count - 1 - i) * step;
      const cClose = nextOpen;
      const range = cClose * (0.004 + rnd() * 0.011);
      const body = (rnd() - 0.46) * 2 * range * (0.35 + rnd() * 0.65);
      const cOpen = cClose - body;
      const hi = Math.max(cOpen, cClose) + range * rnd() * 0.6;
      const lo = Math.min(cOpen, cClose) - range * rnd() * 0.6;
      arr[i] = {
        time: t,
        open: round2(cOpen),
        high: round2(hi),
        low: round2(Math.max(0.5, lo)),
        close: round2(cClose),
        volume: Math.floor(volBase * (0.55 + rnd() * 1.15)),
      };
      nextOpen = cOpen;
    }
    this._candleCache.set(cacheKey, arr);
    // keep cache small
    if (this._candleCache.size > 60) {
      const first = this._candleCache.keys().next().value;
      this._candleCache.delete(first);
    }
    return arr;
  }

  sparkline(symbol, points = 30) {
    const s = this.instruments[symbol];
    const rnd = mulberry32(hashStr(symbol + ':spark'));
    const out = [];
    let v = s.prevClose;
    for (let i = 0; i < points - 1; i++) {
      v = v * (1 + (rnd() - 0.48) * 0.006);
      out.push(v);
    }
    out.push(s.ltp);
    return out;
  }

  // Synthetic depth ladder around LTP (qtys jitter every tick)
  depth(symbol, levels = 9) {
    const s = this.instruments[symbol];
    const rnd = mulberry32(hashStr(symbol + ':depth:' + Math.floor(s.tickCount / 2)));
    const tick = Math.max(0.05, round2(s.ltp * 0.0006));
    const bids = [], asks = [];
    let cumB = 0, cumA = 0;
    for (let i = 1; i <= levels; i++) {
      const bq = Math.floor(80 + rnd() * 4200 * (1 + i * 0.35));
      const aq = Math.floor(80 + rnd() * 4200 * (1 + i * 0.35));
      cumB += bq; cumA += aq;
      bids.push({ price: round2(s.ltp - i * tick), qty: bq, cum: cumB });
      asks.push({ price: round2(s.ltp + i * tick), qty: aq, cum: cumA });
    }
    return { bids, asks: asks.reverse(), spread: round2(asks[levels - 1].price - bids[0].price) };
  }

  tape() {
    // lightly jittered tape, deterministic-ish per call window
    const w = Math.floor(Date.now() / 3000);
    const rnd = mulberry32(w);
    return TAPE.map(t => {
      const j = (rnd() - 0.5) * 0.002 * t.value;
      const value = t.value + j;
      return { ...t, value: round2(value), chg: round2(t.chg + (rnd() - 0.5) * 0.1) };
    });
  }
}

function round2(n) { return Math.round(n * 100) / 100; }

export function nseOpenNow(date = new Date()) {
  // IST = UTC+5:30
  const ist = new Date(date.getTime() + (5.5 * 60 + date.getTimezoneOffset()) * 60000);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

export const engine = new MarketEngine();
