// ─────────────────────────────────────────────────────────────────────────────
// QlibPro server — serves the built SPA + same-origin /api proxy to Groww.
// Security: access token lives ONLY in server memory (or GROWW_ACCESS_TOKEN env).
// The browser never sees the token; it only learns connection status.
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const GROWW_BASE = process.env.GROWW_BASE_URL || 'https://api.groww.in';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// token state (memory only)
let tokenMemory = process.env.GROWW_ACCESS_TOKEN || null;
let connectedAt = process.env.GROWW_ACCESS_TOKEN ? Date.now() : null;
const startedAt = Date.now();

const growwHeaders = (token) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'X-API-VERSION': '1.0',
});

async function growwCall(pathname, { method = 'GET', body, token, timeoutMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GROWW_BASE}${pathname}`, {
      method,
      headers: growwHeaders(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { httpOk: res.ok, status: res.status, json, text: json ? undefined : text.slice(0, 400) };
  } catch (err) {
    return { httpOk: false, status: 0, networkError: true, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// candidate endpoints used ONLY to validate a token on connect
const VALIDATION_PATHS = [
  '/v1/holdings/user',
  '/v1/order/list?segment=CASH',
  '/v1/margin/detail?segment=CASH',
];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'qlibpro', uptimeSec: Math.round((Date.now() - startedAt) / 1000), ts: Date.now() });
});

app.get('/api/groww/status', (_req, res) => {
  res.json({
    ok: true,
    mode: tokenMemory ? 'live' : 'paper',
    connected: Boolean(tokenMemory),
    connectedAt,
    tokenSource: tokenMemory ? (process.env.GROWW_ACCESS_TOKEN ? 'env' : 'session') : null,
    tokenExpiryNote: 'Access tokens expire daily at 06:00 IST — reconnect each morning or use the TOTP flow',
    docs: 'https://groww.in/trade-api/docs',
    rateLimits: { orders: '10/s · 250/min', liveData: '10/s · 300/min', nonTrading: '20/s · 500/min' },
    instruments: 'NSE/BSE · CASH + FNO only (no MCX)',
  });
});

app.post('/api/groww/connect', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 20) {
    return res.status(400).json({ ok: false, reason: 'Token looks too short — paste the full access token from Groww → Settings → Trading APIs.' });
  }
  // validate against the real API; try common read endpoints (all are cheap, idempotent GETs)
  let sawNetworkError = false; let lastStatus = null; let lastMessage = '';
  for (const p of VALIDATION_PATHS) {
    const r = await growwCall(p, { token, timeoutMs: 6000 });
    if (r.networkError) { sawNetworkError = true; continue; }
    lastStatus = r.status;
    const status = r.json?.status;
    if (r.httpOk && status === 'SUCCESS') {
      tokenMemory = token;
      connectedAt = Date.now();
      return res.json({ ok: true, mode: 'live', validatedVia: p });
    }
    lastMessage = r.json?.error?.message || r.text || '';
    if (r.status === 401 || r.status === 403 || status === 'FAILURE') {
      // definitive auth failure — stop trying
      return res.status(401).json({ ok: false, reason: `Groww rejected the token${r.status ? ` (HTTP ${r.status})` : ''}${lastMessage ? `: ${lastMessage}` : ''}. Check that the token is fresh (they expire daily at 06:00 IST) and that your Trading API subscription is active.` });
    }
    // 404/405-ish → try next candidate
  }
  if (sawNetworkError) {
    return res.status(502).json({ ok: false, reason: 'Could not reach api.groww.in from this server (network/egress blocked or Groww is down). Token NOT stored. In production this server needs outbound HTTPS to api.groww.in.' });
  }
  return res.status(400).json({ ok: false, reason: `Groww did not accept the token${lastStatus ? ` (last HTTP ${lastStatus})` : ''}. ${lastMessage}`.trim() });
});

app.post('/api/groww/disconnect', (_req, res) => {
  tokenMemory = null;
  connectedAt = null;
  res.json({ ok: true, mode: 'paper' });
});

// Generic authenticated proxy → https://api.groww.in/v1/*
// e.g. GET /api/groww/proxy/holdings/user · POST /api/groww/proxy/order/create
app.all('/api/groww/proxy/*', async (req, res) => {
  if (!tokenMemory) return res.status(401).json({ ok: false, reason: 'Groww not connected — add your access token in Settings.' });
  const sub = req.params[0] || '';
  if (sub.includes('..')) return res.status(400).json({ ok: false, reason: 'bad path' });
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const method = req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : req.body;
  const r = await growwCall(`/v1/${sub}${qs}`, { method, body, token: tokenMemory, timeoutMs: 8000 });
  if (r.networkError) return res.status(502).json({ ok: false, reason: `Groww unreachable from server: ${r.error}` });
  res.status(r.status || 502).json(r.json ?? { ok: false, raw: r.text });
});

// Order router: paper by default; live only when token present
app.post('/api/order', async (req, res) => {
  const o = req.body || {};
  const side = String(o.side || '').toUpperCase();
  const symbol = String(o.symbol || '').toUpperCase();
  const qty = Number(o.qty);
  const orderType = String(o.orderType || 'MARKET').toUpperCase();
  const product = String(o.product || 'CNC').toUpperCase();
  const priceType = orderType === 'LIMIT' ? Number(o.price) : 0;
  if (!['BUY', 'SELL'].includes(side) || !symbol || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, reason: 'side must be BUY/SELL, symbol and qty>0 required' });
  }
  if (qty > 10000) return res.status(400).json({ ok: false, reason: 'qty exceeds per-order guard (10,000)' });

  const orderRef = `QLB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  if (tokenMemory) {
    const payload = {
      validity: 'DAY',
      exchange: 'NSE',
      segment: 'CASH',
      trading_symbol: symbol,
      transaction_type: side,
      order_type: orderType,
      product,
      quantity: Math.floor(qty),
      price: orderType === 'LIMIT' ? priceType : 0,
      order_reference_id: orderRef,
    };
    const r = await growwCall('/v1/order/create', { method: 'POST', body: payload, token: tokenMemory });
    if (r.networkError) return res.status(502).json({ ok: false, reason: `Groww unreachable: ${r.error}`, orderRef });
    if (r.json?.status === 'SUCCESS') return res.json({ ok: true, mode: 'live', orderRef, groww: r.json.payload ?? r.json });
    return res.status(r.status || 400).json({ ok: false, mode: 'live', orderRef, reason: r.json?.error?.message || 'Groww rejected the order', code: r.json?.error?.code, raw: r.json ?? r.text });
  }

  // paper mode: deterministic simulated fill at caller-supplied price (client LTP)
  const fill = Number(o.clientPrice) > 0 ? Number(o.clientPrice) : null;
  if (!fill) return res.status(400).json({ ok: false, reason: 'clientPrice required in paper mode' });
  const slip = fill * (side === 'BUY' ? 1.0004 : 0.9996);
  res.json({
    ok: true,
    mode: 'paper',
    orderRef,
    paperFill: { price: Math.round(slip * 100) / 100, qty: Math.floor(qty), side, symbol, product, orderType },
  });
});

// static SPA (built) — long cache for hashed assets
const distDir = path.join(__dirname, 'dist');
app.use('/assets', express.static(path.join(distDir, 'assets'), { maxAge: '30d', immutable: true }));
app.use(express.static(distDir, { maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[qlibpro] listening on http://0.0.0.0:${PORT}  (mode: ${tokenMemory ? 'GROWW LIVE' : 'PAPER'})`);
});
