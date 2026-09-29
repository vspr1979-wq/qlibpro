# OptionSignal — Windows 11 Python Option-Buying **Signal** Application

Upstox (real market data) + **Microsoft Qlib** (genuine quantitative engine) + SQLite.
Four pages only · no charts · **signal generation only — never places orders**.

> UI design: **LOCKED · FINAL v1.0** — see `ui_layout.html` for the reviewed reference.

---

## Quick start (Windows 11)

1. Install **Python 3.11 (64-bit)** from python.org (check *Add to PATH*).
2. Double-click **`run.bat`** — it creates `.venv`, installs `requirements.txt`,
   and starts the app at **http://127.0.0.1:5000** (the default Upstox redirect URL).
3. Open the browser at `http://127.0.0.1:5000`.

### Upstox connection (Settings page)
1. Create an app at [Upstox Developer](https://upstox.com/developer/) with redirect URL
   `http://127.0.0.1:5000/upstox/callback`.
2. Enter **API Key / API Secret / Redirect URL** → **CONNECT**.
3. Approve in the browser; the callback exchanges the code for an access token
   automatically and downloads the instrument master
   (`complete.json.gz`) into SQLite **once** (reused afterwards; manual refresh button only
   when needed).

---

## The 4 pages

| # | Page | Contents |
|---|------|----------|
| 1 | **Dashboard** | Main signal card (`BUY CE / BUY PE / NO TRADE`), Market/Selection, Signal Board (all enabled symbols), Trade Plan table (one row per symbol) |
| 2 | **Watchlist & Option Chain** | Search / Add / Remove / Enable-Disable, lot sizes from instruments master, ATM ±15 chain (CE+PE: premium, bid, ask, spread, OI, chg OI, volume, IV, greeks, LQ) with symbol dropdown |
| 3 | **QLib Analysis** | Model status (OOS metrics, backtest gate), Candidate Analysis table for every CE/PE in the window with symbol filter + optional manual **Run Analysis** |
| 4 | **Settings** | Upstox credentials, CONNECT/DISCONNECT, instruments, strategy constraints (ATM Range, Small Premium Min/Max, Max Risk, Max Capital, Min R/R, Max Lots), logs |

---

## Architecture (fully automatic)

```
UPSTOX (REST live quotes + option chain; WS monitor with reconnect fallback)
   ↓
WATCHLIST FILTER (service layer — only enabled symbols are analysed)
   ↓
SQLite (settings, broker, watchlist, instruments, market_data, option_chain,
        qlib_analysis, signals, signal_history, logs)
   ↓
MICROSOFT QLIB ENGINE  (auto, no button needed)
   export real data → qlib binary dump → qlib.init → QlibDataLoader expression
   features → LightGBM train → out-of-sample evaluation (IC / direction accuracy /
   calibrated confidence / model-derived target & stop quantiles) → live inference
   ↓
NORMAL OPTION BUYING  +  SMALL-PREMIUM QUICK-MOVE   (candidates compared)
   ↓
RISK CHECK (capital, max risk, lot multiples, min R/R, charges)
   ↓
BUY CE / BUY PE / NO TRADE      (signal only — no order execution, ever)
```

* **No mock data.** Everything displayed comes from Upstox / SQLite / Qlib.
* **No hardcoded trading rules.** Direction, confidence, entry/target/stop levels
  come from Qlib's out-of-sample results; the app only enforces your configured
  non-trading constraints (capital, risk, lots, R/R).
* **Continuous learning:** trains after enough data, then daily at 16:00 IST and
  whenever meaningful new data arrives; a failed out-of-sample validation keeps
  signals at **NO TRADE**.
* **Manual `Run Analysis`** on page 3 is an optional override only.

## Commands

| Action | Where |
|--------|-------|
| Start | `run.bat` or `python app.py` |
| Rebuild venv | delete `.venv`, run `run.bat` |
| Data location | `data/optionsignal.db`, `data/qlib_data/`, `data/qlib_model.pkl` |
| Tests (engineering) | `python tests/smoke_qlib.py`, `python tests/test_units.py` |

## Notes

* Upstox discontinued its market-data WebSocket feed (official docs) — live data uses
  REST quote/option-chain polling; the WS monitor still runs with reconnect/backoff
  and reports feed status.
* Charge amounts are estimates (constants in `config.py`, adjustable) — verify against
  the current Upstox brokerage calculator.
* Signal only. Orders are **never** placed by this application.
