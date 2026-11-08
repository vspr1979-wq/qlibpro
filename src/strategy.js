// ─────────────────────────────────────────────────────────────────────────────
// QlibPro strategy scan — EMA(9/21) cross + RSI(14) filter with ATR-based
// target/stop. Pure functions over the candle array so results are stable
// (computed from closed candles, not the forming tick).
// ─────────────────────────────────────────────────────────────────────────────

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(50);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function atr(candles, period = 14) {
  if (candles.length < 2) return 1;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  let a = trs.slice(0, period).reduce((s, x) => s + x, 0) / Math.min(period, trs.length);
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a || 1;
}

export function scanSymbol(symbol, candles) {
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const r14 = rsi(closes, 14);
  const a = atr(candles, 14);
  const i = closes.length - 1;
  const last = closes[i];
  const fast = e9[i], slow = e21[i];
  const rsiNow = r14[i];
  const diffPct = ((fast - slow) / slow) * 100;

  // crossover strength over recent bars
  let crossedUp = false, crossedDown = false;
  for (let j = Math.max(1, i - 3); j <= i; j++) {
    if (e9[j - 1] <= e21[j - 1] && e9[j] > e21[j]) crossedUp = true;
    if (e9[j - 1] >= e21[j - 1] && e9[j] < e21[j]) crossedDown = true;
  }

  let action = 'NEUTRAL';
  if (fast > slow && rsiNow > 50) action = 'BUY';
  else if (fast < slow && rsiNow < 50) action = 'SELL';

  const strength = Math.min(1, Math.abs(diffPct) / 0.9); // 0..1
  const rsiEdge = Math.min(1, Math.abs(rsiNow - 50) / 30);
  let confidence = Math.round(52 + strength * 30 + rsiEdge * 12 + (crossedUp || crossedDown ? 6 : 0));
  confidence = Math.max(35, Math.min(97, confidence));
  if (action === 'NEUTRAL') confidence = Math.min(confidence, 55);

  const dir = action === 'SELL' ? -1 : 1;
  const stop = round2(last - dir * 1.35 * a);
  const target = round2(last + dir * 2.1 * a);

  return {
    symbol,
    action,
    confidence,
    ltp: last,
    ema9: round2(fast),
    ema21: round2(slow),
    emaDiffPct: round2(diffPct),
    rsi: round2(rsiNow),
    atr: round2(a),
    stop,
    target,
    crossed: crossedUp ? 'EMA9↑21 cross' : crossedDown ? 'EMA9↓21 cross' : (fast > slow ? 'Above EMA21' : 'Below EMA21'),
    time: new Date().toISOString(),
  };
}

export function scanWatchlist(candlesBySymbol) {
  const out = [];
  for (const [sym, candles] of Object.entries(candlesBySymbol)) {
    if (candles && candles.length > 40) out.push(scanSymbol(sym, candles));
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

function round2(n) { return Math.round(n * 100) / 100; }
