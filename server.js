// ─────────────────────────────────────────────────────────────────────────────
// QlibPro server — serves the built SPA + same-origin /api proxy to Groww.
// Security: access token lives ONLY in server memory (or GROWW_ACCESS_TOKEN env).
// The browser never sees the token; it only learns connection status.
// ─────────────────────────────────────────────────────────────────────────────
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const GROWW_BASE = process.env.GROWW_BASE_URL || 'https://api.groww.in';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// token state (memory only — secrets never touch disk or the browser)
let tokenMemory = process.env.GROWW_ACCESS_TOKEN || null;
let connectedAt = process.env.GROWW_ACCESS_TOKEN ? Date.now() : null;
let tokenIssuedAt = process.env.GROWW_ACCESS_TOKEN ? Date.now() : 0;
let tokenAuthMode = process.env.GROWW_ACCESS_TOKEN ? 'env-token' : null; // 'env-token' | 'manual-token' | 'approval' | 'totp'
let lastAuthError = null;
// credentials for silent daily re-auth (from env or a connect-keys call). 6-digit codes are never stored.
let credsMemory = null;
if (process.env.GROWW_TOTP_KEY && process.env.GROWW_TOTP_SECRET) {
  credsMemory = { mode: 'totp', apiKey: process.env.GROWW_TOTP_KEY, totpSecret: process.env.GROWW_TOTP_SECRET };
  tokenAuthMode = tokenAuthMode || 'totp';
} else if (process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET) {
  credsMemory = { mode: 'approval', apiKey: process.env.GROWW_API_KEY, secret: process.env.GROWW_API_SECRET };
  tokenAuthMode = tokenAuthMode || 'approval';
}
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


// ── RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) — no dependency ─────────────
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(b32) {
  let bits = '';
  for (const ch of String(b32).replace(/=+$/, '').toUpperCase()) {
    const v = B32_ALPHA.indexOf(ch);
    if (v < 0) throw new Error('invalid base32 secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpCode(secretB32, timeMs = Date.now()) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(timeMs / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

// Exchange API key + secret (approval) or TOTP for a daily access token.
// POST /v1/token/api/access — see https://groww.in/trade-api/docs/curl
async function generateAccessToken({ mode, apiKey, secret, totpSecret, totp }) {
  const post = async (body, checksumKind) => {
    const payload = { ...body };
    if (checksumKind) payload.checksum = checksumKind === 'hex'
      ? crypto.createHash('sha256').update(secret + body.timestamp).digest('hex')
      : crypto.createHash('sha256').update(secret + body.timestamp).digest('base64');
    const r = await growwCall('/v1/token/api/access', {
      method: 'POST', body: payload, token: apiKey, timeoutMs: 8000,
      // apiKey IS the Bearer here (it is the API/TOTP key, not an access token)
    });
    return r;
  };
  const tryApproval = async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    for (const kind of ['hex', 'base64']) {
      const r = await post({ key_type: 'approval', timestamp: ts }, kind);
      if (r.networkError) return { ok: false, reason: `Groww unreachable: ${r.error}` };
      if (r.json?.status === 'SUCCESS') return { ok: true, token: extractToken(r.json), raw: r.json };
      if (r.httpOk === false && (r.status === 401 || r.status === 403)) {
        return { ok: false, reason: `Groww rejected the API key (HTTP ${r.status}): ${r.json?.error?.message || 'unauthorized'}` };
      }
      if (kind === 'hex') continue; // retry with base64 checksum once
      return { ok: false, reason: r.json?.error?.message || `token request failed (HTTP ${r.status})`, raw: r.json ?? r.text };
    }
  };
  const tryTotp = async () => {
    let code = totp;
    try { code = code || totpCode(totpSecret); } catch (e) { return { ok: false, reason: `TOTP secret invalid: ${e.message}` }; }
    const r = await growwCall('/v1/token/api/access', { method: 'POST', body: { key_type: 'totp', totp: code }, token: apiKey, timeoutMs: 8000 });
    if (r.networkError) return { ok: false, reason: `Groww unreachable: ${r.error}` };
    if (r.json?.status === 'SUCCESS') return { ok: true, token: extractToken(r.json), raw: r.json };
    return { ok: false, reason: r.json?.error?.message || `TOTP rejected (HTTP ${r.status})`, raw: r.json ?? r.text };
  };
  const parsed = mode === 'totp' ? await tryTotp() : await tryApproval();
  if (!parsed.ok) { lastAuthError = parsed.reason; return parsed; }
  if (!parsed.token) { lastAuthError = 'Groww returned SUCCESS but no recognizable token field'; return { ok: false, reason: lastAuthError, raw: parsed.raw }; }
  lastAuthError = null;
  return { ok: true, token: parsed.token };
}
function extractToken(json) {
  const p = json?.payload ?? {};
  const candidates = [p.access_token, p.token, p.auth_token, p.accessToken, p.jwt, json?.access_token, json?.token];
  for (const c of candidates) if (typeof c === 'string' && c.length > 10) return c;
  if (typeof p === 'string' && p.length > 10) return p;
  return null; // caller surfaces rawPreview — never guess field names silently
}

// silent re-auth: tokens expire daily at 06:00 IST; if we hold credentials
// (env or a connect-keys call) and the token is older than ~20h, mint a fresh one.
async function maybeAutoRefresh() {
  if (!credsMemory) return;
  const ageMs = tokenIssuedAt ? Date.now() - tokenIssuedAt : Infinity;
  if (tokenMemory && ageMs < 20 * 3600 * 1000) return;
  const r = await generateAccessToken(credsMemory);
  if (r.ok) { tokenMemory = r.token; tokenIssuedAt = Date.now(); connectedAt = Date.now(); tokenAuthMode = credsMemory.mode; console.log('[qlibpro] Groww access token auto-refreshed via', credsMemory.mode); }
  else console.warn('[qlibpro] Groww auto-refresh failed:', r.reason);
}

// candidate endpoints used ONLY to validate a token on connect
const VALIDATION_PATHS = [
  '/v1/live-data/ltp?segment=CASH&exchange_symbols=NSE_RELIANCE',
  '/v1/holdings/user',
  '/v1/order/list?segment=CASH',
  '/v1/margin/detail?segment=CASH',
];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'qlibpro', uptimeSec: Math.round((Date.now() - startedAt) / 1000), ts: Date.now() });
});

// ── Live market data via Groww (real API, no simulated fallback) ────────────
// Maps UI symbols -> Groww instruments. Indices live in the CASH segment;
// they are not orderable on Groww's equity API (F&O handles those) — paper only.
const LIVE_MAP = {
  // stocks
  RELIANCE: { exchange: 'NSE', segment: 'CASH', trading_symbol: 'RELIANCE' },
  HDFCBANK: { exchange: 'NSE', segment: 'CASH', trading_symbol: 'HDFCBANK' },
  ICICIBANK:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'ICICIBANK' },
  INFY:     { exchange: 'NSE', segment: 'CASH', trading_symbol: 'INFY' },
  TCS:      { exchange: 'NSE', segment: 'CASH', trading_symbol: 'TCS' },
  SBIN:     { exchange: 'NSE', segment: 'CASH', trading_symbol: 'SBIN' },
  BHARTIARTL:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'BHARTIARTL' },
  ITC:      { exchange: 'NSE', segment: 'CASH', trading_symbol: 'ITC' },
  LT:       { exchange: 'NSE', segment: 'CASH', trading_symbol: 'LT' },
  TATAMOTORS:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'TATAMOTORS' },
  BAJFINANCE:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'BAJFINANCE' },
  MARUTI:   { exchange: 'NSE', segment: 'CASH', trading_symbol: 'MARUTI' },
  // indices / benchmark instruments
  NIFTY50:  { exchange: 'NSE', segment: 'CASH', trading_symbol: 'NIFTY' },
  BANKNIFTY:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'BANKNIFTY' },
  SENSEX:   { exchange: 'BSE', segment: 'CASH', trading_symbol: 'SENSEX' },
  NIFTYIT:  { exchange: 'NSE', segment: 'CASH', trading_symbol: 'NIFTYIT' },
  FINNIFTY: { exchange: 'NSE', segment: 'CASH', trading_symbol: 'FINNIFTY' },
  NIFTY500: { exchange: 'NSE', segment: 'CASH', trading_symbol: 'NIFTY500' },
  MIDCAP100:{ exchange: 'NSE', segment: 'CASH', trading_symbol: 'NIFTYMIDCAP100' },
  INDIAVIX: { exchange: 'NSE', segment: 'CASH', trading_symbol: 'INDIAVIX' },
};

// Groww's multi-symbol LTP response shape is not contractually documented; pull the
// number out of whatever reasonable structure it returns. Returns {exSymbol: number|null}.
function extractLtp(json, exList) {
  const out = Object.fromEntries(exList.map(e => [e, null]));
  if (!json || typeof json !== 'object') return out;
  const roots = [json, json.payload, json.data].filter(x => x && typeof x === 'object');
  for (const root of roots) {
    for (const ex of exList) {
      if (out[ex] !== null) continue;
      // { "NSE_RELIANCE": 3085.5 } or { "NSE_RELIANCE": { ltp: ... } }
      const direct = root[ex];
      if (typeof direct === 'number' && Number.isFinite(direct)) { out[ex] = direct; continue; }
      if (direct && typeof direct === 'object') {
        const n = Number(direct.ltp ?? direct.last_price ?? direct.last ?? direct.close);
        if (Number.isFinite(n)) { out[ex] = n; continue; }
      }
      // { ltp: { "NSE_RELIANCE": 3085.5 } } or { symbolwise: [...] }
      const nested = root.ltp && root.ltp[ex];
      if (typeof nested === 'number' && Number.isFinite(nested)) { out[ex] = nested; continue; }
      if (nested && typeof nested === 'object') {
        const n = Number(nested.ltp ?? nested.last_price);
        if (Number.isFinite(n)) { out[ex] = n; continue; }
      }
    }
  }
  // last resort: deep scan (bounded) for any object keyed by the exchange symbol with ltp inside
  const walk = (node, depth) => {
    if (depth > 5 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (out[key] === null && val && typeof val === 'object') {
        const n = Number(val.ltp ?? val.last_price ?? val.close);
        if (Number.isFinite(n)) out[key] = n;
      }
      walk(val, depth + 1);
    }
  };
  walk(json, 0);
  return out;
}

// GET /api/ltp?symbols=RELIANCE,NIFTY50,... (max 50)
app.get('/api/ltp', async (req, res) => {
  const wanted = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!wanted.length) return res.status(400).json({ ok: false, reason: 'symbols query param required' });
  if (wanted.length > 50) return res.status(400).json({ ok: false, reason: 'max 50 symbols per call' });
  if (!tokenMemory) return res.status(401).json({ ok: false, connected: false, reason: 'Groww not connected — paste your Access Token in Settings (gear).' });
  const ltp = {}; const missing = [];
  const known = [];
  for (const s of wanted) {
    const m = LIVE_MAP[s];
    if (m) known.push([s, m]); else { ltp[s] = null; missing.push(s); }
  }
  if (known.length) {
    const ex = known.map(([, m]) => `${m.exchange}_${m.trading_symbol}`);
    const p = new URLSearchParams({ segment: 'CASH', exchange_symbols: ex.join(',') });
    const r = await growwCall(`/v1/live-data/ltp?${p}`, { token: tokenMemory, timeoutMs: 8000 });
    if (r.networkError) return res.status(502).json({ ok: false, connected: true, reason: `Groww unreachable from this server: ${r.error}` });
    if (!r.httpOk || r.json?.status === 'FAILURE') {
      return res.status(502).json({ ok: false, connected: true, reason: r.json?.error?.message || `Groww LTP failed (HTTP ${r.status})`, raw: JSON.stringify(r.json)?.slice(0, 300) });
    }
    const extracted = extractLtp(r.json, ex);
    for (const [s, m] of known) ltp[s] = extracted[`${m.exchange}_${m.trading_symbol}`] ?? null;
    const noData = known.filter(([s]) => ltp[s] == null).map(([s]) => s);
    return res.json({ ok: true, connected: true, ltp, ...(noData.length ? { missing: [...missing, ...noData], rawPreview: JSON.stringify(r.json)?.slice(0, 280) } : {}) });
  }
  res.json({ ok: true, connected: true, ltp, missing });
});

// GET /api/quote?symbol=RELIANCE — full snapshot incl. depth (for the ladder)
app.get('/api/quote', async (req, res) => {
  const sym = String(req.query.symbol || '').toUpperCase();
  const meta = LIVE_MAP[sym];
  if (!meta) return res.status(400).json({ ok: false, reason: 'unknown symbol' });
  if (!tokenMemory) return res.status(401).json({ ok: false, connected: false, reason: 'Groww not connected' });
  const p = new URLSearchParams({ exchange: meta.exchange, segment: meta.segment, trading_symbol: meta.trading_symbol });
  const r = await growwCall(`/v1/live-data/quote?${p}`, { token: tokenMemory, timeoutMs: 8000 });
  if (r.networkError) return res.status(502).json({ ok: false, connected: true, reason: `Groww unreachable: ${r.error}` });
  res.status(r.httpOk ? 200 : 502).json({ ok: Boolean(r.httpOk) && r.json?.status !== 'FAILURE', connected: true, groww: r.json ?? { raw: r.text } });
});

// GET /api/candles?symbol=RELIANCE&minutes=5&days=15 — OHLCV history
app.get('/api/candles', async (req, res) => {
  const sym = String(req.query.symbol || '').toUpperCase();
  const meta = LIVE_MAP[sym];
  if (!meta) return res.status(400).json({ ok: false, reason: 'unknown symbol' });
  if (!tokenMemory) return res.status(401).json({ ok: false, connected: false, reason: 'Groww not connected' });
  const minutes = Math.max(1, Math.min(10080, Number(req.query.minutes) || 5));
  const days = Math.max(0.2, Math.min(400, Number(req.query.days) || 15));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const p = new URLSearchParams({ exchange: meta.exchange, segment: meta.segment, trading_symbol: meta.trading_symbol, start_time: fmt(start), end_time: fmt(end), interval_in_minutes: String(minutes) });
  const r = await growwCall(`/v1/historical/candle/range?${p}`, { token: tokenMemory, timeoutMs: 12000 });
  if (r.networkError) return res.status(502).json({ ok: false, connected: true, reason: `Groww unreachable: ${r.error}` });
  const candles = r.json?.payload?.candles ?? r.json?.candles;
  if (!Array.isArray(candles)) {
    return res.status(502).json({ ok: false, connected: true, reason: r.json?.error?.message || 'unexpected candles payload from Groww', raw: JSON.stringify(r.json)?.slice(0, 300) });
  }
  res.json({ ok: true, connected: true, symbol: sym, interval_in_minutes: minutes, candles: candles.map(c => Array.isArray(c) ? c : [c?.timestamp ?? c?.time, c?.open, c?.high, c?.low, c?.close, c?.volume]) });
});

app.get('/api/groww/status', (_req, res) => {
  res.json({
    ok: true,
    mode: tokenMemory ? 'live' : 'paper',
    connected: Boolean(tokenMemory),
    connectedAt,
    tokenSource: tokenMemory ? (tokenAuthMode === 'env-token' ? 'env' : 'session') : null,
    authMode: tokenMemory ? tokenAuthMode : null,
    autoRefresh: Boolean(credsMemory),
    autoRefreshIn: credsMemory ? (tokenIssuedAt ? Math.max(0, Math.round((tokenIssuedAt + 20 * 3600 * 1000 - Date.now()) / 60000)) : 0) : null,
    tokenAgeMin: tokenIssuedAt ? Math.round((Date.now() - tokenIssuedAt) / 60000) : null,
    lastAuthError,
    envKeys: { totp: Boolean(process.env.GROWW_TOTP_KEY && process.env.GROWW_TOTP_SECRET), approval: Boolean(process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET) },
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
      tokenIssuedAt = Date.now();
      tokenAuthMode = 'manual-token';
      credsMemory = null; // a manual token should not be silently overwritten by auto-refresh
      connectedAt = Date.now();
      return res.json({ ok: true, mode: 'live', validatedVia: p, authMode: 'manual-token' });
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
  tokenIssuedAt = 0;
  tokenAuthMode = null;
  credsMemory = null; // stop auto-refresh for this session (env creds re-arm on restart)
  res.json({ ok: true, mode: 'paper' });
});


// POST /api/groww/connect-keys — generate a daily access token from API credentials.
// Body: { mode:'totp', totpKey, totpSecret }           (Base32 secret — fully automatic)
//     | { mode:'totp', totpKey, totp:'123456' }        (manual 6-digit, one-shot)
//     | { mode:'approval', apiKey, apiSecret }          (SHA-256 checksum flow)
// Secrets are held in memory only; never logged, never written, never sent anywhere but api.groww.in.
app.post('/api/groww/connect-keys', async (req, res) => {
  const b = req.body || {};
  const mode = String(b.mode || '').toLowerCase();
  let gen = null;
  if (mode === 'totp') {
    const totpKey = String(b.totpKey || '').trim();
    const totpSecret = String(b.totpSecret || '').trim();
    const totp = String(b.totp || '').trim();
    if (!totpKey) return res.status(400).json({ ok: false, reason: 'TOTP key required — Groww → Settings → Trading APIs → Generate TOTP token.' });
    if (!totpSecret && !/^\d{6}$/.test(totp)) return res.status(400).json({ ok: false, reason: 'Provide either the Base32 TOTP secret (automatic) or the current 6-digit TOTP code.' });
    gen = { mode: 'totp', apiKey: totpKey, totpSecret: totpSecret || undefined, totp: totpSecret ? undefined : totp };
  } else if (mode === 'approval') {
    const apiKey = String(b.apiKey || '').trim();
    const apiSecret = String(b.apiSecret || '').trim();
    if (!apiKey || !apiSecret) return res.status(400).json({ ok: false, reason: 'API key and API secret are both required (Groww → Settings → Trading APIs → Generate API Key).' });
    gen = { mode: 'approval', apiKey, secret: apiSecret };
  } else {
    return res.status(400).json({ ok: false, reason: "mode must be 'totp' or 'approval'" });
  }
  const r = await generateAccessToken(gen);
  if (!r.ok) {
    return res.status(502).json({ ok: false, reason: r.reason, ...(r.raw ? { raw: JSON.stringify(r.raw).slice(0, 240) } : {}) });
  }
  // validate the freshly minted token before declaring victory
  let validatedVia = null;
  for (const p of VALIDATION_PATHS) {
    const chk = await growwCall(p, { token: r.token, timeoutMs: 6000 });
    if (chk.networkError) { lastAuthError = `token minted but Groww unreachable for validation: ${chk.error}`; return res.status(502).json({ ok: false, reason: lastAuthError }); }
    if (chk.httpOk && chk.json?.status === 'SUCCESS') { validatedVia = p; break; }
    if (chk.status === 401 || chk.status === 403) { lastAuthError = 'minted token was rejected by Groww'; return res.status(502).json({ ok: false, reason: lastAuthError }); }
  }
  tokenMemory = r.token; tokenIssuedAt = Date.now(); connectedAt = Date.now();
  tokenAuthMode = mode;
  credsMemory = totpProvided(gen) ? null : gen; // env-style auto path needs the secret; one-shot 6-digit can't re-auth
  function totpProvided(g) { return g.mode === 'totp' && !g.totpSecret; }
  res.json({ ok: true, mode: 'live', authMode: mode, validatedVia, autoRefresh: Boolean(credsMemory), tokenExpiresNote: 'Access tokens expire daily at 06:00 IST — auto-refresh is on while credentials are held in memory.' });
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
    const orderMeta = LIVE_MAP[symbol];
    const payload = {
      validity: 'DAY',
      exchange: orderMeta?.exchange || 'NSE',
      segment: 'CASH',
      trading_symbol: orderMeta?.trading_symbol || symbol,
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

// silent boot-time auth when credentials are configured via env
if (!tokenMemory && credsMemory) {
  maybeAutoRefresh().catch(e => console.warn('[qlibpro] boot auth failed:', e?.message || e));
}
setInterval(() => { maybeAutoRefresh().catch(() => {}); }, 20 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[qlibpro] listening on http://0.0.0.0:${PORT}  (mode: ${tokenMemory ? 'GROWW LIVE' : 'PAPER'})`);
});
