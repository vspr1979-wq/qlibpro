# QlibPro — Indian Markets Algo Trading Terminal (Draft Plan v0.1)

> Status: **DRAFT for review** · 2026-11-08 · Inspired by the reference screenshot (`WhatsApp Image 2026-11-08 at 7.47.44 AM.jpeg`, the "AI-powered auto-trading desk" style).
> This document is the first-draft plan. A working single-page **example is implemented in this repo** (see `README` quickstart) and run in **PAPER (simulated) mode** by default. Live trading via Groww API requires credentials and your explicit opt-in.

---

## 1. Objective

Build a **single-page, all-in-one algo trading desk for Indian markets (NSE/BSE: Equity CASH + F&O)** that connects to the **Groww Trading API**, in the spirit of the reference image:

- One dense, glanceable dark terminal — no tab-hopping between broker app, charts, and screener.
- Live watchlist, candle chart with EMA overlays + signal markers, depth book, order ticket, positions with live P&L, strategy equity curve, market breadth, risk guard and kill switch — all on **one page**.
- AI/quant signal scan across the watchlist with confidence score, entry / target / stop-loss.
- Interactive, fast (<16 ms render budget), reliable (degrades gracefully: paper mode when Groww is unreachable).

**Not in v0.1 scope:** MCX commodities (Groww API does not support them today), multi-broker routing, options strategy builder, mobile native app.

---

## 2. What the reference screenshot teaches us

The reference image is a social-media shot of a dense pro-trading desk ("GROK DESK"). Design takeaways we adopt:

| Element in reference | QlibPro equivalent (Indian markets) |
|---|---|
| Ticker tape with prices/links | NSE/BSE tape: NIFTY 50, BANKNIFTY, SENSEX, INDIA VIX, NIFTY IT, USD/INR — scrolling marquee |
| Big globe mode selector cards (EDGE/CLOSER/PRIOR/TAKER) | **Mode strip**: PAPER / GROWW LIVE toggle with connection badge in the header |
| Per-driver horizontal gauges (SPOKE) | Per-factor signal gauges: Trend (EMA9/21), Momentum (RSI-14), Volume, Breadth — confidence bars |
| Equity $81,192 + sparkline | ₹ Paper equity ₹10,00,000 start; equity curve canvas in center-bottom |
| Win rate 62.94 + target projection | Strategy stats: realized/unrealized P&L, win rate, charges |
| Probability distribution histogram | Confidence distribution of watchlist scans (future); v0.1 shows confidence list |
| Heatmap / spectrogram | Advance-decline breadth bar + sector heat strip (future) |
| Order book ladder | NSE depth ladder around LTP with qty bars (simulated feed / Groww live) |
| Candlestick chart + buy/sell markers | lightweight-charts candles + volume + EMA9/EMA21 + BUY/SELL markers |
| Bottom status line (latency, date, disclaimer) | QlibPro status bar: build, feed mode, simulated/live, latency, IST clock |

---

## 3. Groww API — connectivity facts (verified 2026-11-08)

Source: Groww Trading API docs (<https://groww.in/trade-api/docs>), cURL + Python SDK pages.

| Area | Detail |
|---|---|
| Base URL | `https://api.groww.in` |
| Auth (simplest) | **Access Token** — generated at Groww → Profile → Settings → Trading APIs → "Generate API keys" → Access Token. Sent as `Authorization: Bearer <token>`. **Expires daily 6:00 AM IST**. |
| Auth (automation-friendly) | **API Key + Secret** (daily approval on Groww Cloud API Keys page) → `POST /v1/token/api/access` with SHA-256 checksum (`sha256(secret + epochSeconds)`), returns access token. |
| Auth (no-expiry style) | **TOTP flow**: API key + TOTP (`pyotp`) → same `/v1/token/api/access` endpoint, `key_type: "totp"`. |
| Required headers | `Authorization: Bearer …`, `Accept: application/json`, `X-API-VERSION: 1.0` |
| Python SDK | `pip install growwapi` → `GrowwAPI(access_token)`; methods like `place_order(...)`, `get_holdings_for_user(timeout=5)`; constants `EXCHANGE_NSE`, `SEGMENT_CASH/SEGMENT_FNO`, `PRODUCT_CNC/PRODUCT_MIS`, `ORDER_TYPE_MARKET/LIMIT/SL/SL_M`. |
| Segments | **CASH (equity) and FNO only** — no MCX commodities today. Exchange: NSE, BSE. |
| Key endpoints | `POST /v1/order/create`, `POST /v1/order/modify`, `POST /v1/order/cancel`, `GET /v1/order/detail/{id}`, orders/trades list, positions, holdings, margin, live LTP/quote/OHLC, historical candles (backtesting). |
| Rate limits (per second / per minute, shared per type) | Authentication 5/30 · Orders 10/250 · Live Data 10/300 · Non-trading (positions/holdings/margin/lists) 20/500 · `/v1/token/api/access` also capped at 150 / 24 h. |
| Prerequisites | Groww account + **Trading API subscription** (reported ~₹499/mo + GST) + daily token/approval rituals. |
| Failure model | JSON `{status:"FAILURE", error:{code:GA###, message}}`; GA005 unauthorised, GA006 cannot process, GA007 duplicate order reference id. |
| Streaming | WebSocket live feed (up to 1000 subscriptions) — Phase 2. |

**Implication for design:** the browser never talks to Groww directly (CORS + secret safety). A thin **server-side proxy** holds the token and forwards calls. The UI always knows the current `mode: paper | live` and never silently places a live order.

---

## 4. Architecture (v0.1 → Phase 2)

```
┌────────────────────────────── Browser (single page, React + Vite) ─────────────────────────────┐
│ Header: logo · mode badge PAPER/GROWW LIVE · NSE open/closed (IST) · IST clock · HALT · settings│
│ Ticker tape (marquee) ── Watchlist+sparklines │ Chart (candles+EMA+markers, tf switch) │ Signal │
│ Breadth (A/D, PCR)     │ EMA9/EMA21 state     │ Equity curve + strategy stats          │ Ladder │
│                        │ Watchlist AI scan    │ Realized/Unrealized/Win rate/Charges   │ Ticket │
│ Status bar: build · feed · latency · disclaimer                                      │ Pos’s │
└───────┬─────────────────────────────────────────────────────────────────────────────────────────┘
        │ same-origin /api/*
┌───────▼──────────────── Node/Express server (server.js) ───────────────────────────────────────┐
│ Serves dist/ · /api/health · /api/groww/status · /api/groww/connect | disconnect               │
│ /api/groww/proxy/* → https://api.groww.in/v1/* (Authorization injected server-side, timeout 6s) │
│ /api/order → live: forward to Groww /v1/order/create · paper: echo simulated fill               │
│ Token: memory only (or GROWW_ACCESS_TOKEN env). Never logged, never sent to browser.            │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Simulated feed (default):** deterministic seeded random-walk engine (`src/marketSim.js`) generates realistic OHLCV + depth for ~12 liquid NSE symbols and 7 index/FX tape items. Replaces seamlessly with Groww quotes/WebSocket in Phase 2 without UI changes (same interface: `ltp/change/candles/depth`).

**Paper ledger:** client-side, persisted in `localStorage` (`qlibpro.positions`, `qlibpro.orders`). Charges modelled (broking + STT + exchange txn + GST + SEBI + stamp) so P&L feels honest. Reset button included.

---

## 5. Screens / panels (the one page)

1. **Header** — brand `QLIBPRO · Indian Algo Desk`, connection badge, NSE session state dot (IST 09:15–15:30, Mon–Fri), live IST clock, **HALT** kill-switch (blocks all order placement + strategies), settings gear.
2. **Ticker tape** — marquee, pause on hover, ₹/points formatting via `en-IN` locale.
3. **Watchlist (left)** — symbol, name, LTP (2 dp Indian grouping), change % pill, sparkline canvas, click-to-select chart, flash on tick direction; AI scan confidence column.
4. **Market breadth (left-bottom)** — advancers/decliners bar, India VIX, PCR proxy; updates with feed.
5. **Chart (center)** — lightweight-charts candles, volume histogram, EMA9/EMA21 lines, BUY/SELL markers from the strategy scan, timeframe switch 1/5/15/60/D, crosshair, resize-observer.
6. **Strategy equity (center-bottom)** — paper-equity area chart (session), baseline ₹10L dashed, stats: Realized / Unrealized / Win rate / Est. charges; strategy state for selected symbol (EMA cross, RSI, signal, target, SL).
7. **Signal panel (right)** — top watchlist signals by confidence (BUY green / SELL red, confidence bar, entry/target/SL), updates ~1 Hz.
8. **Depth ladder (right, tab A)** — 12 bids/asks around LTP with cumulative qty bars, spread highlight.
9. **Positions (right, tab B)** — open positions: qty, avg, LTP, P&L ₹/%, exit button; empty-state guidance.
10. **Order ticket (right)** — BUY/SELL segmented control, qty stepper, order type MARKET/LIMIT, product CNC/MIS, price (limit), est. value + charges + margin, validation, one-click place → toast; disabled when HALTED or (LIVE && disconnected).
11. **Status bar** — `QlibPro v0.1-draft · feed: SIMULATED|GROWW · latency · IST date · "Not investment advice — F&O involves risk…"`.

Principles: **dense but scannable** (tabular numerals, 2 dp), **everything is clickable/hoverable**, **no dead buttons**, **HALT is always visible**.

---

## 6. Safety & risk controls (non-negotiable before LIVE)

- **Paper-first:** live orders are impossible unless (a) you paste a valid Groww access token in Settings → validated by a real API call, (b) status shows `GROWW LIVE`, and (c) HALT is off.
- **HALT kill-switch** in header — instantly disables ticket + any auto strategy; banner shown.
- Order-level guards: max qty per order, max notional per order (₹2L default), daily order count cap, **daily loss limit ₹25,000 → auto-HALT**.
- SEBI/Groww reality: order placed is **your responsibility**; algo orders must originate from your own API subscription; duplicate client `order_reference_id` reused → Groww rejects (GA007) — we always send unique refs.
- Token hygiene: token only in server memory/env; HTTPS only in production; rotate daily (6 AM expiry). For unattended automation use **TOTP flow** + daily approval; never commit tokens (`.env` git-ignored).
- Idempotent order placement (client ref id = `QLB-<ts>-<rand>`), 6 s timeout, explicit error surface for GA005/GA006/GA007.
- Compliance note: F&O losses are common; backtest ≠ live. QlibPro is a tool, not investment advice.

## 7. Reliability & performance

- **Sim feed is in-memory** and deterministic — app works fully offline from Groww (and from the internet at runtime).
- Canvas rendering (lightweight-charts, sparklines, equity curve) — 60 fps capable, <5 MB JS gz target.
- Tick loop 1 s; depth jitter 1 s; clock 1 s; chart updates only on tf/symbol change.
- Server: 6 s upstream timeout, typed error mapping, no crashes on Groww downtime (`/api/groww/*` returns structured `{ok:false, reason}` → UI falls back to paper read-only).
- Frontend bundle pinned deps; no CDN at runtime (works behind corporate proxies).
- Planned: WS reconnect w/ exponential backoff, IndexedDB candle cache, service worker, error telemetry (Sentry-like), synthetic monitoring of `/api/health`.

## 8. Roadmap

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P0 (this repo)** | Example single-page desk, paper engine, Groww proxy wired, settings flow, risk guards | `npm install && npm run build && npm start` → full terminal at `:8787`; order → position → P&L loop works |
| P1 | Real Groww **market data** in UI (LTP/quotes/OHLC via proxy + WS feed) | Live NIFTY/RELIANCE quotes with <1 s latency; candle cache warm |
| P2 | **Live order placement** behind HALT + daily-loss guard; order sync (list/modify/cancel); holdings/positions reconciliation | 1-click + bracket orders on NSE; GA-error surfacing; E2E on a small qty |
| P3 | Strategy engine v2: backtester (Groww historical candles), EMA/RSI + VWAP + Supertrend library, walk-forward eval, parameter sweep | Backtest report per symbol/tf; Sharpe/maxDD shown |
| P4 | AI signal layer (LLM-assisted reasoning over technicals + news), options-chain analytics, Greeks, F&O basket orders | Paper FNO strategies; margin checks vs `groww.get_margin` |
| P5 | Broker-agnostic adapter (OpenAlgo/Shoonya), multi-account, tax P&L export | One codepath, pluggable brokers |

## 9. Tech stack & repo layout

- Frontend: React 18 + Vite 5, **lightweight-charts 4.2** (Apache-2.0), vanilla CSS (no UI kit → tiny bundle), `en-IN` number/date formatting, IST via `Asia/Kolkata`.
- Backend: Node 22 + Express 4, built-in `fetch`, zero native deps.
- Repo: `docs/PLAN.md` (this file) · `server.js` (static + proxy + order router) · `src/marketSim.js` (seeded feed) · `src/strategy.js` (EMA/RSI scan) · `src/components/*` · `src/App.jsx` (layout/state) · `src/styles.css` (terminal theme).

## 10. Known limitations of v0.1 (honest list)

- Feed is **simulated** (clearly badged). Numbers are realistic but fictional; not for trading decisions.
- Depth ladder is synthetic; Groww depth arrives via `market-quote` endpoint in P2.
- Paper charges are estimates; brokerage is shown separately from statutory levies.
- Single user, single account; no auth on the local page — **do not expose port 8787 to the internet** without putting auth in front.
- Groww token expiry daily 6 AM IST → reconnect each morning (or TOTP automation in P2).

## 11. Costs (indicative)

Groww Trading API subscription (~₹499/mo + GST — verify on Groww), zero additional infra for local use (server = your machine), or ~₹300–500/mo for a small VPS. No LLM calls in v0.1.

## 12. Disclaimer

Equity and F&O trading involves substantial risk of loss. Past/simulated performance does not guarantee future results. QlibPro is software, not investment advice. Verify every order before submission. Comply with SEBI regulations and Groww's Trading API terms.

---

### Open questions for you

1. **Capital & limits** — start paper with ₹10,00,000 and ₹25,000 daily-loss halt OK? Preferred max notional per order?
2. **Instruments** — which watchlist do you actually trade (Nifty 100? specific F&O lots?). Lot sizes needed for F&O paper trading.
3. **Strategies** — EMA-cross+RSI default: keep, or is there a specific strategy you want encoded first?
4. **Deployment** — local machine only, or a VPS (needs auth + HTTPS before anything live)?
5. **Groww subscription** — do you already have the Trading API subscription + static IP whitelisting (if any) set up?

## Front-ends (added 2026-11-08)

Two pages ship from the same Express server:

- `/` — Classic React pro-desk (watchlist, charts, ticket, positions, settings).
- `/desk.html` — **QlibPro Desk**, an adaptation of MIT-licensed [GrokDesk](https://github.com/GrokDesk/grokdesk)'s single-file terminal (`assets/terminal.html`), re-targeted to NSE/BSE instruments. Shares the same `localStorage` paper ledger and the same `/api/order` router and `qlibpro.halted` kill-switch flag (F1/`h`).
- Attribution: `NOTICE-GROKDESK.md` (MIT, (c) 2026 GrokDesk). No GrokDesk code is compiled into the React bundle; the desk page is a static file under `public/`.
- Live order guardrails apply identically; indices are paper-only (Groww equity API cannot route index instruments).

## Live data phase pulled forward (2026-11-08)

- New server routes: `GET /api/ltp?symbols=`, `GET /api/quote?symbol=`, `GET /api/candles?symbol=&minutes=&days=` (Groww `live-data` + `historical/candle/range`, token memory-only, no mock fallback — 401/502 with explicit reasons).
- Frontend `src/liveFeed.js`: paper engine (now opt-in via Settings → PAPER SIMULATION, default OFF) and live mode share one facade. Live mode drives every price/candle/depth read from Groww; breadth/PCR/multi-TF spectrogram have no Groww equity-API source and render `—` (honest gaps, not fake numbers).
- `public/desk.html` mirrors the same behavior: ribbon/ticker/positions/VAULT read the shared ledger + Groww LTPs; hive/stream/corr-matrix/run-rate either compute from real 5m candles or render dashes; the scripted “+8.6% banked” reel plays only in paper mode.
- Verified end-to-end against a local Groww API stub (connect → LTP → candles → quote → order): full path works; live SENSEX orders route to BSE. Real `api.groww.in` egress is blocked from Arena’s sandbox (HTTP 000), so production use needs a host with normal outbound HTTPS.
- Failure honesty: 401 when disconnected, 502 “could not reach api.groww.in” when egress blocked, 401 with Groww’s own message for bad tokens — never silently falls back to simulated prices.

## Groww auth in-app (added 2026-11-08)

- `POST /api/groww/connect-keys` — mints a daily access token from **TOTP** (`key_type:'totp'`; server-side RFC 6238 over the Base32 secret — zero daily clicks) or **API Key+Secret** (`key_type:'approval'`; SHA-256 checksum, hex with base64 fallback). Validates the minted token against a live read path before marking connected; failures never store anything.
- Server auto-refresh: boot-time silent auth when `GROWW_TOTP_KEY`/`GROWW_TOTP_SECRET` (or `GROWW_API_KEY`/`GROWW_API_SECRET`) are in `.env`, then every ~20h. Credentials held **in memory only**; a manual token paste clears auto-refresh (explicit choice wins); Disconnect stops it for the session.
- Settings gear now exposes all three methods (TOTP auto / approval / manual token) + PAPER simulation toggle. Secrets are typed into password fields, POSTed to the local server, and never persisted.
- Verified end-to-end against a local Groww stub v2 (token endpoint + LTP/quote/candles/orders): boot-time TOTP auth, typed-TOTP connect, one-shot 6-digit connect, approval connect, and wrong-credential rejection (token not stored).
