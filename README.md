# OptionSignal — Windows 11 Python Option-Buying **Signal** Application

Upstox (real market data) + **Microsoft Qlib** (genuine quantitative engine) + SQLite.
Four pages only · no charts · **signal generation only — never places orders**.

> UI design: **LOCKED · FINAL v1.0** — see `app/ui_layout.html` for the reviewed reference.

---

## Repository layout

```
qlibpro/
├── app/                    OptionSignal build code
│   ├── app.py              Flask entry point (run from repo root)
│   ├── config.py           paths, Upstox endpoints, default settings
│   ├── database.py         SQLite layer (all 10 tables)
│   ├── upstox_client.py    OAuth + REST client + instruments
│   ├── collector.py        live data collection cycles
│   ├── qlib_dump.py        SQLite → qlib binary dump
│   ├── qlib_engine.py      Qlib pipeline: features → train → OOS → inference
│   ├── strategy_engine.py  Normal + Small-Premium candidate comparison
│   ├── risk_engine.py      capital / risk / lots / R-R enforcement
│   ├── signal_engine.py    BUY CE / BUY PE / NO TRADE decision
│   ├── scheduler.py        background workers
│   ├── ws_feed.py          feed monitor (reconnect/backoff)
│   ├── templates/          the 4 pages
│   ├── static/             style.css + app.js
│   ├── tests/              test_units.py, smoke_qlib.py
│   └── ui_layout.html      locked UI reference
├── qlib/                   Microsoft Qlib — cloned from
│                           github.com/microsoft/qlib @ be725493
├── .venv/                  created by run.bat (not in git)
├── requirements.txt
├── run.bat
└── README.md

(runtime, created on first run: data/ — SQLite DB, qlib dataset, model)
```

---

## Quick start (Windows 11)

1. Install **Python 3.11 (64-bit)** from python.org (check *Add to PATH*) and
   **Build Tools for Visual Studio** with the *Desktop development with C++*
   workload — Qlib (`./qlib`) is compiled from source on first run.
2. Double-click **`run.bat`** — it creates `.venv`, installs `requirements.txt`,
   and starts the app at **http://127.0.0.1:5000** (the default Upstox redirect URL).
3. Open the browser at `http://127.0.0.1:5000`.

### Microsoft Qlib — the cloned repo at `./qlib`

The official [microsoft/qlib](https://github.com/microsoft/qlib) source is
**committed to this repository** at `qlib/` (pinned commit
`be725493eb1a6bbb42bf11b37aa7669f59610ff1`, full upstream tree). `requirements.txt`
installs it from that local copy:

```
./qlib
```

* `pip install` builds the local source — the two Cython extensions under
  `qlib/qlib/data/_libs/` are the reason the C++ build tools are required on
  Windows. No network fetch of Qlib happens at install time.
* The installed package records its origin as this repository's `qlib/` path
  (`direct_url.json` → `file:…/qlib`), and the app runs against that build.
* The app drives Qlib through its real APIs: `qlib.init` → binary dataset →
  `QlibDataLoader` expression features → `LightGBModel` fit/predict with
  out-of-sample evaluation and recorder metrics.

**Local patches vs upstream (both documented, everything else byte-identical):**

1. `qlib/pyproject.toml` — `fallback_version = "0.1.dev1"` added to
   `[tool.setuptools_scm]` (the `.git` history is stripped, so setuptools-scm
   cannot detect the version from tags).
2. `qlib/qlib/workflow/expm.py` (`_get_or_create_exp`) — upstream built the
   file-store lock path with `os.path.join(pr.netloc, pr.path.lstrip("/"), "filelock")`;
   for a `file:` URI the netloc is empty, producing a cwd-relative
   `home/user/…/mlruns/filelock` that polluted the working directory. The patch
   keeps the absolute URI path when netloc is empty (non-empty netloc unchanged).

**Refreshing to a newer upstream commit:**

```
git clone https://github.com/microsoft/qlib.git /tmp/qlib-new
cd /tmp/qlib-new && git checkout <new-commit>
# copy the tree (excluding .git and build artifacts) over qlib/
# re-apply the two patches above if pyproject.toml / expm.py changed
pip install ./qlib     # rebuild, then run the tests
python app/tests/test_units.py && python app/tests/smoke_qlib.py
```

### Upstox connection (Settings page)

1. Create an app at [Upstox Developer](https://upstox.com/developer/) with redirect URL
   `http://127.0.0.1:5000/upstox/callback`.
2. Enter **API Key / API Secret / Redirect URL** → **Save credentials** (stored in
   the SQLite `broker` table) → **CONNECT**.
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
| 4 | **Settings** | Upstox credentials (Save + CONNECT), instruments, strategy constraints (ATM Range, Small Premium Min/Max, Max Risk, Max Capital, Min R/R, Max Lots), logs |

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
| Start | `run.bat` or `python app\app.py` |
| Rebuild venv | delete `.venv`, run `run.bat` |
| Data location | `data/optionsignal.db`, `data/qlib_data/`, `data/qlib_model.pkl` |
| Tests (engineering) | `python app/tests/smoke_qlib.py`, `python app/tests/test_units.py` |

## Notes

* Upstox discontinued its market-data WebSocket feed (official docs) — live data uses
  REST quote/option-chain polling; the WS monitor still runs with reconnect/backoff
  and reports feed status.
* Charge amounts are estimates (constants in `app/config.py`, adjustable) — verify against
  the current Upstox brokerage calculator.
* Signal only. Orders are **never** placed by this application.
