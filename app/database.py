"""SQLite persistence layer.

Tables (as required by the specification):
  settings, broker, watchlist, instruments, market_data, option_chain,
  qlib_analysis, signals, signal_history, logs

All writes are serialized with a process-wide lock so multiple background
threads and Flask request handlers can share this module safely.
"""
import json
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
import os

# pyqlib records experiments through MLflow; allow its default file store.
os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")

import config

_lock = threading.RLock()
_conn = None


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ts_ms: int = None) -> str:
    t = ts_ms if ts_ms is not None else now_ms()
    return datetime.fromtimestamp(t / 1000, tz=timezone.utc).astimezone().isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def init_schema() -> None:
    with _lock:
        c = _connect()
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS broker (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                api_key TEXT, api_secret TEXT, redirect_url TEXT,
                access_token TEXT, token_expiry INTEGER, connected INTEGER,
                updated_at TEXT);
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT UNIQUE NOT NULL, instrument_key TEXT,
                enabled INTEGER DEFAULT 1, added_at TEXT,
                last_price REAL, last_change_pct REAL, last_ts INTEGER);
            CREATE TABLE IF NOT EXISTS instruments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instrument_key TEXT UNIQUE, trading_symbol TEXT, short_name TEXT,
                underlying TEXT, underlying_key TEXT, expiry TEXT, strike REAL, option_type TEXT,
                lot_size INTEGER, exchange TEXT, segment TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS market_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT, symbol TEXT, instrument_key TEXT,
                ts INTEGER, date TEXT,
                open REAL, high REAL, low REAL, close REAL,
                volume REAL, oi REAL, change_pct REAL, ltp REAL,
                UNIQUE(kind, symbol, instrument_key, ts));
            CREATE TABLE IF NOT EXISTS option_chain (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT, expiry TEXT, strike REAL, option_type TEXT,
                instrument_key TEXT, trading_symbol TEXT,
                ts INTEGER, date TEXT,
                ltp REAL, bid REAL, ask REAL, spread REAL,
                oi REAL, chg_oi REAL, volume REAL,
                iv REAL, delta REAL, gamma REAL, theta REAL, vega REAL,
                ltq REAL, lot_size INTEGER,
                UNIQUE(symbol, expiry, strike, option_type, ts));
            CREATE TABLE IF NOT EXISTS qlib_analysis (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT, symbol TEXT,
                strike REAL, option_type TEXT, premium REAL,
                qlib_score REAL, confidence REAL, direction TEXT,
                momentum TEXT, volume_state TEXT, oi_state TEXT,
                iv REAL, delta REAL, liquidity TEXT, activity TEXT,
                expected_move REAL, risk_reward REAL,
                strategy_type TEXT, status TEXT, reason TEXT,
                metrics TEXT, ts INTEGER,
                UNIQUE(kind, symbol, strike, option_type));
            CREATE TABLE IF NOT EXISTS signals (
                symbol TEXT PRIMARY KEY,
                signal TEXT, strategy TEXT, expiry TEXT, strike REAL,
                option_type TEXT, instrument_key TEXT, trading_symbol TEXT,
                premium REAL, entry_min REAL, entry_max REAL,
                t1 REAL, t2 REAL, t3 REAL, sl REAL,
                lots INTEGER, lot_size INTEGER, quantity INTEGER,
                capital REAL, max_risk REAL, gross REAL, charges REAL,
                net REAL, rr REAL, qlib_direction TEXT, confidence REAL,
                reason TEXT, ts INTEGER, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS signal_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT, signal TEXT, strategy TEXT, strike REAL,
                option_type TEXT, premium REAL, ts INTEGER, snapshot TEXT);
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT, source TEXT, message TEXT, ts INTEGER);
            CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
            CREATE INDEX IF NOT EXISTS idx_chain_lookup
                ON option_chain(symbol, expiry, strike, option_type, ts);
            CREATE INDEX IF NOT EXISTS idx_md_lookup
                ON market_data(kind, symbol, ts);
            """
        )
        try:
            c.execute("ALTER TABLE instruments ADD COLUMN underlying_key TEXT")
        except Exception:
            pass
        c.commit()


# ------------------------------------------------------------------ logs ----
def log(level: str, source: str, message: str) -> None:
    try:
        with _lock:
            c = _connect()
            c.execute(
                "INSERT INTO logs(level, source, message, ts) VALUES (?,?,?,?)",
                (level, source, str(message)[:2000], now_ms()),
            )
            c.commit()
    except Exception:
        pass  # logging must never take the app down


def tail_logs(limit: int = 50):
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT level, source, message, ts FROM logs ORDER BY ts DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# --------------------------------------------------------------- settings ---
def get_settings() -> dict:
    with _lock:
        c = _connect()
        rows = c.execute("SELECT key, value FROM settings").fetchall()
    out = dict(config.DEFAULT_SETTINGS)
    out.update({r["key"]: r["value"] for r in rows})
    return out


def save_settings(values: dict) -> None:
    allowed = set(config.DEFAULT_SETTINGS.keys())
    with _lock:
        c = _connect()
        for k, v in values.items():
            if k in allowed:
                c.execute(
                    "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                    (k, str(v), iso()),
                )
        c.commit()


def settings_float(key: str, default: float = 0.0) -> float:
    try:
        return float(get_settings().get(key, default))
    except (TypeError, ValueError):
        return default


# ----------------------------------------------------------------- broker ---
def get_broker() -> dict:
    with _lock:
        c = _connect()
        row = c.execute("SELECT * FROM broker WHERE id=1").fetchone()
    if row is None:
        return {
            "api_key": "", "api_secret": "", "redirect_url": config.DEFAULT_SETTINGS["redirect_url"],
            "access_token": "", "token_expiry": 0, "connected": 0,
        }
    return dict(row)


def save_broker(**kw) -> None:
    cur = get_broker()
    cur.update({k: v for k, v in kw.items() if k in cur and v is not None})
    cur["updated_at"] = iso()
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO broker(id, api_key, api_secret, redirect_url, access_token, "
            "token_expiry, connected, updated_at) VALUES (1,:api_key,:api_secret,:redirect_url,"
            ":access_token,:token_expiry,:connected,:updated_at) "
            "ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, "
            "api_secret=excluded.api_secret, redirect_url=excluded.redirect_url, "
            "access_token=excluded.access_token, token_expiry=excluded.token_expiry, "
            "connected=excluded.connected, updated_at=excluded.updated_at",
            {**cur, "connected": int(cur.get("connected", 0) or 0)},
        )
        c.commit()


def token_valid(broker: dict = None) -> bool:
    b = broker or get_broker()
    return bool(b.get("access_token")) and (b.get("token_expiry") or 0) > now_ms() + 30_000


# -------------------------------------------------------------- watchlist ----
def watchlist():
    with _lock:
        c = _connect()
        rows = c.execute("SELECT * FROM watchlist ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def enabled_watchlist():
    return [w for w in watchlist() if w.get("enabled")]


def watchlist_add(symbol: str, instrument_key: str = "") -> None:
    symbol = symbol.strip().upper()
    if not symbol:
        return
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO watchlist(symbol, instrument_key, enabled, added_at) VALUES (?,?,1,?) "
            "ON CONFLICT(symbol) DO UPDATE SET enabled=1",
            (symbol, instrument_key, iso()),
        )
        c.commit()


def watchlist_remove(symbol: str) -> None:
    with _lock:
        c = _connect()
        c.execute("DELETE FROM watchlist WHERE symbol=?", (symbol.upper(),))
        c.commit()


def watchlist_toggle(symbol: str, enabled: bool) -> None:
    with _lock:
        c = _connect()
        c.execute("UPDATE watchlist SET enabled=? WHERE symbol=?", (1 if enabled else 0, symbol.upper()))
        c.commit()


def watchlist_update_quote(symbol: str, price, change_pct, ts: int) -> None:
    with _lock:
        c = _connect()
        c.execute(
            "UPDATE watchlist SET last_price=?, last_change_pct=?, last_ts=? WHERE symbol=?",
            (price, change_pct, ts, symbol),
        )
        c.commit()


def watchlist_resolve_keys() -> dict:
    """symbol -> (instrument_key, lot_size, underlying kind) using instruments table."""
    out = {}
    for w in enabled_watchlist():
        sym = w["symbol"]
        if w.get("instrument_key"):
            out[sym] = w["instrument_key"]
            continue
        key = resolve_underlying_key(sym)
        if key:
            out[sym] = key
            watchlist_set_key(sym, key)
    return out


def watchlist_set_key(symbol: str, key: str) -> None:
    with _lock:
        c = _connect()
        c.execute("UPDATE watchlist SET instrument_key=? WHERE symbol=?", (key, symbol))
        c.commit()


# ------------------------------------------------------------- instruments ---
def replace_instruments(rows: list) -> int:
    with _lock:
        c = _connect()
        c.execute("DELETE FROM instruments")
        ts = iso()
        c.executemany(
            "INSERT OR REPLACE INTO instruments(instrument_key, trading_symbol, short_name, "
            "underlying, underlying_key, expiry, strike, option_type, lot_size, exchange, "
            "segment, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    r.get("instrument_key"), r.get("trading_symbol"), r.get("short_name"),
                    r.get("underlying"), r.get("underlying_key") or "",
                    r.get("expiry"), r.get("strike"), r.get("option_type"),
                    r.get("lot_size"), r.get("exchange"), r.get("segment"), ts,
                )
                for r in rows
            ],
        )
        c.commit()
        n = c.execute("SELECT COUNT(*) n FROM instruments").fetchone()["n"]
    return n


def instruments_count() -> int:
    with _lock:
        c = _connect()
        return c.execute("SELECT COUNT(*) n FROM instruments").fetchone()["n"]


def resolve_underlying_key(symbol: str) -> str:
    """Best instrument_key for an underlying symbol (index/equity cash key)."""
    sym = symbol.upper()
    with _lock:
        c = _connect()
        # 1) exact trading symbol (e.g. RELIANCE, SENSEX)
        row = c.execute(
            "SELECT instrument_key FROM instruments WHERE UPPER(trading_symbol)=? "
            "ORDER BY (segment LIKE '%IDX%' OR segment LIKE '%INDEX%') DESC, "
            "(segment LIKE '%FNO%') LIMIT 1",
            (sym,),
        ).fetchone()
        if row:
            return row["instrument_key"]
        # 2) index style trading symbols like "NIFTY 50"
        row = c.execute(
            "SELECT instrument_key FROM instruments WHERE UPPER(trading_symbol) LIKE ? "
            "ORDER BY (segment LIKE '%IDX%' OR segment LIKE '%INDEX%') DESC LIMIT 1",
            (sym + " %",),
        ).fetchone()
        if row:
            return row["instrument_key"]
        # 3) key suffix match e.g. "...|NIFTY" or "...|Nifty 50"
        row = c.execute(
            "SELECT instrument_key FROM instruments "
            "WHERE UPPER(instrument_key) LIKE ? OR UPPER(instrument_key) LIKE ? "
            "ORDER BY (segment LIKE '%IDX%' OR segment LIKE '%INDEX%') DESC LIMIT 1",
            ("%" + "|" + sym, "%" + "|" + sym + " %"),
        ).fetchone()
        if row:
            return row["instrument_key"]
        # 4) underlying_key stored on this underlying's option contracts
        row = c.execute(
            "SELECT underlying_key FROM instruments WHERE UPPER(underlying)=? "
            "AND underlying_key IS NOT NULL AND underlying_key != '' LIMIT 1",
            (sym,),
        ).fetchone()
    return row["underlying_key"] if row else ""


def underlying_contracts(symbol: str, expiry: str = None) -> list:
    """Option contracts for underlying (option_type CE/PE) with lot sizes."""
    q = ("SELECT * FROM instruments WHERE underlying=? AND option_type IN ('CE','PE')")
    args = [symbol.upper()]
    if expiry:
        q += " AND expiry=?"
        args.append(expiry)
    with _lock:
        c = _connect()
        rows = c.execute(q, args).fetchall()
    return [dict(r) for r in rows]


def underlying_expiries(symbol: str) -> list:
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT DISTINCT expiry FROM instruments WHERE underlying=? AND expiry IS NOT NULL "
            "AND expiry != '' ORDER BY expiry",
            (symbol.upper(),),
        ).fetchall()
    return [r["expiry"] for r in rows]


def search_underlyings(q: str) -> list:
    """Distinct underlyings matching a query (watchlist search)."""
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT UPPER(underlying) u, "
            "MIN(CASE WHEN underlying_key != '' THEN underlying_key END) ukey, "
            "MIN(CASE WHEN segment LIKE '%IDX%' OR segment LIKE '%INDEX%' "
            "THEN instrument_key END) idx_key, "
            "MIN(instrument_key) any_key, MAX(lot_size) lot "
            "FROM instruments WHERE UPPER(underlying) LIKE ? AND underlying != '' "
            "GROUP BY UPPER(underlying) LIMIT 15",
            (f"%{q.upper()}%",),
        ).fetchall()
    return [
        {
            "symbol": r["u"],
            "key": r["ukey"] or r["idx_key"] or r["any_key"] or "",
            "lot": r["lot"] or 0,
        }
        for r in rows
    ]


def lot_and_step(symbol: str):
    """Lot size + strike step for an underlying, from the instruments master."""
    with _lock:
        c = _connect()
        row = c.execute(
            "SELECT MAX(lot_size) lot FROM instruments WHERE underlying=? "
            "AND option_type='CE'",
            (symbol.upper(),),
        ).fetchone()
        strikes = [
            r["strike"]
            for r in c.execute(
                "SELECT DISTINCT strike FROM instruments WHERE underlying=? "
                "AND option_type='CE' AND strike IS NOT NULL ORDER BY strike",
                (symbol.upper(),),
            ).fetchall()
        ]
    lot = int(row["lot"] or 0) if row else 0
    step = None
    if len(strikes) >= 2:
        diffs = [round(b - a, 6) for a, b in zip(strikes, strikes[1:]) if b > a]
        diffs = [d for d in diffs if d > 0]
        if diffs:
            step = min(diffs)
    return lot, step


def contract_meta(instrument_key: str) -> dict:
    with _lock:
        c = _connect()
        row = c.execute("SELECT * FROM instruments WHERE instrument_key=?", (instrument_key,)).fetchone()
    return dict(row) if row else {}


def lot_size_for(symbol: str, option_type: str, strike: float, expiry: str) -> int:
    with _lock:
        c = _connect()
        row = c.execute(
            "SELECT lot_size FROM instruments WHERE underlying=? AND option_type=? "
            "AND strike=? AND (expiry=? OR ?='') LIMIT 1",
            (symbol.upper(), option_type, strike, expiry, expiry or ""),
        ).fetchone()
    if row and row["lot_size"]:
        return int(row["lot_size"])
    row2 = c.execute(
        "SELECT lot_size FROM instruments WHERE underlying=? AND option_type IN ('CE','PE') "
        "AND lot_size IS NOT NULL LIMIT 1",
        (symbol.upper(),),
    ).fetchone() if row is None else None
    return int(row2["lot_size"]) if row2 and row2["lot_size"] else 0


# ------------------------------------------------------------- market data ---
def upsert_market_row(kind, symbol, instrument_key, ts, date, **kw) -> None:
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO market_data(kind, symbol, instrument_key, ts, date, open, high, low, "
            "close, volume, oi, change_pct, ltp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(kind, symbol, instrument_key, ts) DO UPDATE SET "
            "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
            "volume=excluded.volume, oi=excluded.oi, change_pct=excluded.change_pct, ltp=excluded.ltp",
            (kind, symbol, instrument_key, ts, date,
             kw.get("open"), kw.get("high"), kw.get("low"), kw.get("close"),
             kw.get("volume"), kw.get("oi"), kw.get("change_pct"), kw.get("ltp")),
        )
        c.commit()


def last_candles(symbol: str, instrument_key: str, limit: int = 400) -> list:
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT * FROM market_data WHERE kind='candle' AND symbol=? AND instrument_key=? "
            "ORDER BY date DESC LIMIT ?",
            (symbol, instrument_key, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ------------------------------------------------------------ option chain ---
def upsert_chain_rows(symbol: str, expiry: str, ts: int, date: str, rows: list) -> None:
    with _lock:
        c = _connect()
        for r in rows:
            c.execute(
                "INSERT INTO option_chain(symbol, expiry, strike, option_type, instrument_key, "
                "trading_symbol, ts, date, ltp, bid, ask, spread, oi, chg_oi, volume, iv, "
                "delta, gamma, theta, vega, ltq, lot_size) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(symbol, expiry, strike, option_type, ts) DO UPDATE SET "
                "ltp=excluded.ltp, bid=excluded.bid, ask=excluded.ask, spread=excluded.spread, "
                "oi=excluded.oi, chg_oi=excluded.chg_oi, volume=excluded.volume, iv=excluded.iv, "
                "delta=excluded.delta, gamma=excluded.gamma, theta=excluded.theta, "
                "vega=excluded.vega, ltq=excluded.ltq, lot_size=excluded.lot_size",
                (symbol, expiry, r.get("strike"), r.get("option_type"), r.get("instrument_key"),
                 r.get("trading_symbol"), ts, date, r.get("ltp"), r.get("bid"), r.get("ask"),
                 r.get("spread"), r.get("oi"), r.get("chg_oi"), r.get("volume"), r.get("iv"),
                 r.get("delta"), r.get("gamma"), r.get("theta"), r.get("vega"), r.get("ltq"),
                 r.get("lot_size")),
            )
        c.commit()


def latest_chain(symbol: str, expiry: str = None, at_ts: int = None) -> list:
    """Latest snapshot rows for a symbol (optionally one expiry)."""
    at = at_ts or now_ms()
    with _lock:
        c = _connect()
        if expiry:
            maxrow = c.execute(
                "SELECT MAX(ts) m FROM option_chain WHERE symbol=? AND expiry=? AND ts<=?",
                (symbol, expiry, at),
            ).fetchone()
            if not maxrow or maxrow["m"] is None:
                return []
            rows = c.execute(
                "SELECT * FROM option_chain WHERE symbol=? AND expiry=? AND ts=?",
                (symbol, expiry, maxrow["m"]),
            ).fetchall()
        else:
            maxrow = c.execute(
                "SELECT MAX(ts) m FROM option_chain WHERE symbol=? AND ts<=?", (symbol, at)
            ).fetchone()
            if not maxrow or maxrow["m"] is None:
                return []
            rows = c.execute(
                "SELECT * FROM option_chain WHERE symbol=? AND ts=?", (symbol, maxrow["m"])
            ).fetchall()
    return [dict(r) for r in rows]


def latest_chain_ts(symbol: str) -> int:
    with _lock:
        c = _connect()
        row = c.execute("SELECT MAX(ts) m FROM option_chain WHERE symbol=?", (symbol,)).fetchone()
    return row["m"] or 0 if row else 0


# ----------------------------------------------------------- qlib analysis ---
def upsert_candidate(symbol: str, strike, option_type, values: dict) -> None:
    with _lock:
        c = _connect()
        cols = ["kind", "symbol", "strike", "option_type", "premium", "qlib_score",
                "confidence", "direction", "momentum", "volume_state", "oi_state", "iv",
                "delta", "liquidity", "activity", "expected_move", "risk_reward",
                "strategy_type", "status", "reason", "metrics", "ts"]
        values = dict(values)
        values.update(kind="candidate", symbol=symbol, strike=strike, option_type=option_type)
        placeholders = ",".join(":" + k for k in cols)
        updates = ", ".join(f"{k}=excluded.{k}" for k in cols if k not in ("kind", "symbol", "strike", "option_type"))
        c.execute(
            f"INSERT INTO qlib_analysis({','.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(kind, symbol, strike, option_type) DO UPDATE SET {updates}",
            {k: values.get(k) for k in cols},
        )
        c.commit()


def upsert_model_metrics(symbol: str, metrics: dict, status: str, reason: str) -> None:
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO qlib_analysis(kind, symbol, strike, option_type, status, reason, "
            "metrics, ts) VALUES ('model', ?, NULL, NULL, ?, ?, ?, ?) "
            "ON CONFLICT(kind, symbol, strike, option_type) DO UPDATE SET "
            "status=excluded.status, reason=excluded.reason, metrics=excluded.metrics, "
            "ts=excluded.ts",
            (symbol, status, reason, json.dumps(metrics), now_ms()),
        )
        c.commit()


def candidates_for(symbol: str) -> list:
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT * FROM qlib_analysis WHERE kind='candidate' AND symbol=? "
            "ORDER BY strike, option_type",
            (symbol,),
        ).fetchall()
    return [dict(r) for r in rows]


def model_row(symbol: str = "*") -> dict:
    with _lock:
        c = _connect()
        row = c.execute(
            "SELECT * FROM qlib_analysis WHERE kind='model' AND symbol=? ORDER BY ts DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    if row is None and symbol != "*":
        return model_row("*")
    if row is None:
        return {}
    out = dict(row)
    try:
        out["metrics_parsed"] = json.loads(out.get("metrics") or "{}")
    except json.JSONDecodeError:
        out["metrics_parsed"] = {}
    return out


# ---------------------------------------------------------------- signals ----
def upsert_signal(symbol: str, s: dict) -> None:
    s = dict(s)
    s["symbol"] = symbol
    s["updated_at"] = iso()
    keys = ["signal", "strategy", "expiry", "strike", "option_type", "instrument_key",
            "trading_symbol", "premium", "entry_min", "entry_max", "t1", "t2", "t3", "sl",
            "lots", "lot_size", "quantity", "capital", "max_risk", "gross", "charges",
            "net", "rr", "qlib_direction", "confidence", "reason", "ts", "updated_at"]
    with _lock:
        c = _connect()
        old = c.execute("SELECT signal, strike, option_type FROM signals WHERE symbol=?", (symbol,)).fetchone()
        sets = ", ".join(f"{k}=:{k}" for k in keys)
        c.execute(
            f"INSERT INTO signals(symbol, {','.join(keys)}) VALUES (:symbol, {','.join(':'+k for k in keys)}) "
            f"ON CONFLICT(symbol) DO UPDATE SET {sets}, updated_at=:updated_at",
            {k: s.get(k) for k in ["symbol"] + keys},
        )
        changed = (
            old is None
            or old["signal"] != s.get("signal")
            or old["strike"] != s.get("strike")
            or old["option_type"] != s.get("option_type")
        )
        if changed:
            c.execute(
                "INSERT INTO signal_history(symbol, signal, strategy, strike, option_type, "
                "premium, ts, snapshot) VALUES (?,?,?,?,?,?,?,?)",
                (symbol, s.get("signal"), s.get("strategy"), s.get("strike"),
                 s.get("option_type"), s.get("premium"), s.get("ts") or now_ms(),
                 json.dumps({k: s.get(k) for k in keys})),
            )
        c.commit()


def all_signals() -> list:
    with _lock:
        c = _connect()
        rows = c.execute("SELECT * FROM signals ORDER BY symbol").fetchall()
    return [dict(r) for r in rows]


def get_signal(symbol: str):
    with _lock:
        c = _connect()
        row = c.execute("SELECT * FROM signals WHERE symbol=?", (symbol,)).fetchone()
    return dict(row) if row else None


def signal_history(limit: int = 20) -> list:
    with _lock:
        c = _connect()
        rows = c.execute(
            "SELECT symbol, signal, strategy, strike, option_type, premium, ts "
            "FROM signal_history ORDER BY id DESC LIMIT ?", (limit,),
        ).fetchall()
    return [dict(r) for r in rows]
