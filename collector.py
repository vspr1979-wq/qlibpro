"""Live data collection: watchlist -> option chain -> SQLite.

Data flow (per specification):
  Upstox -> Live Market Data -> Watchlist Filter -> Option Chain -> SQLite

All live values come from the real Upstox API. Signals are suppressed when
quotes are stale.
"""
import threading
import time
from datetime import datetime

import config
import database as db
from upstox_client import UpstoxClient, UpstoxError

STATE = {
    "market": "UNKNOWN",
    "last_cycle_ts": 0,
    "last_error": "",
    "feed": "REST live feed",
    "ws_status": "not started",
    "last_instruments": None,
}

_ws_stop = threading.Event()


def _nearest_expiry(symbol: str) -> str:
    exps = db.underlying_expiries(symbol)
    today = datetime.now().date().isoformat()
    future = [e for e in exps if e and e >= today]
    if future:
        return future[0]
    return exps[0] if exps else ""


def collect_once(client: UpstoxClient) -> dict:
    """One collection cycle for every enabled watchlist symbol."""
    summary = {"symbols": 0, "rows": 0, "error": ""}
    if not db.token_valid():
        STATE["last_error"] = "not connected"
        summary["error"] = "not connected"
        return summary

    # market status
    try:
        ms = client.market_status()
        STATE["market"] = _market_word(ms) if ms else "UNKNOWN"
    except UpstoxError as e:
        STATE["market"] = "UNKNOWN"
        STATE["last_error"] = str(e)

    wl = db.enabled_watchlist()
    if not wl:
        STATE["last_cycle_ts"] = db.now_ms()
        return summary

    # underlying quotes (batch)
    keys = db.watchlist_resolve_keys()
    try:
        qmap = client.quotes(list(keys.values()))
    except UpstoxError as e:
        STATE["last_error"] = str(e)
        db.log("error", "collector", f"quotes failed: {e}")
        qmap = {}

    ts = db.now_ms()
    now_date = datetime.now().date().isoformat()
    for w in wl:
        sym = w["symbol"]
        k = keys.get(sym)
        q = qmap.get(k) if k else None
        if q and q.get("ltp") is not None:
            db.watchlist_update_quote(sym, q["ltp"], q.get("pct"), ts)
            db.upsert_market_row("tick", sym, k or sym, ts, now_date,
                                 ltp=q["ltp"], change_pct=q.get("pct"),
                                 volume=q.get("volume"), oi=q.get("oi"))

    # option chains (one request per enabled symbol)
    for w in wl:
        sym = w["symbol"]
        k = keys.get(sym)
        if not k:
            db.log("warn", "collector", f"{sym}: no instrument key found for symbol")
            continue
        expiry = _nearest_expiry(sym)
        try:
            spot, pcr, rows = client.option_chain(sym, k, expiry)
        except UpstoxError as e:
            STATE["last_error"] = str(e)
            db.log("error", "collector", f"{sym}: option chain failed: {e}")
            time.sleep(config.API_DELAY_SECONDS)
            continue
        if not rows:
            db.log("warn", "collector", f"{sym}: empty option chain for expiry {expiry}")
            time.sleep(config.API_DELAY_SECONDS)
            continue

        # enrich greeks/ltq (batch) for rows lacking ltq
        keys_opt = [r["instrument_key"] for r in rows if r.get("instrument_key")]
        gmap = {}
        if keys_opt:
            try:
                gmap = client.option_greeks(keys_opt)
            except UpstoxError:
                gmap = {}
        for r in rows:
            g = gmap.get(r.get("instrument_key"))
            if g:
                if r.get("ltq") is None:
                    r["ltq"] = g.get("ltq")
                for f in ("iv", "delta", "gamma", "theta", "vega"):
                    if r.get(f) is None:
                        r[f] = g.get(f)
                if r.get("ltp") is None:
                    r["ltp"] = g.get("ltp")
                if r.get("oi") is None:
                    r["oi"] = g.get("oi")
                if r.get("volume") is None:
                    r["volume"] = g.get("volume")

        # lot size / trading symbol from instruments table
        for r in rows:
            meta = db.contract_meta(r.get("instrument_key") or "") if r.get("instrument_key") else {}
            r["lot_size"] = meta.get("lot_size") or 0
            r["trading_symbol"] = meta.get("trading_symbol") or ""
            if r.get("ltp") is not None and r.get("ask") is None and r.get("bid") is not None:
                r["spread"] = None

        if spot is not None:
            pct = None
            cur = db.watchlist()
            for c in cur:
                if c["symbol"] == sym and c.get("last_price"):
                    prev = c["last_price"]
                    if prev:
                        pct = (spot - prev) / prev * 100.0
            db.watchlist_update_quote(sym, spot, pct, ts)
            db.upsert_market_row("tick", sym, k, ts, now_date, ltp=spot, change_pct=pct)

        db.upsert_chain_rows(sym, expiry, ts, now_date, rows)
        summary["symbols"] += 1
        summary["rows"] += len(rows)
        time.sleep(config.API_DELAY_SECONDS)

    STATE["last_cycle_ts"] = ts
    STATE["last_error"] = ""
    return summary


def _market_word(ms) -> str:
    if isinstance(ms, dict):
        for k in ("market_status", "status", "state", "segment_status"):
            v = ms.get(k)
            if isinstance(v, str) and v:
                return v.upper().replace("_", " ")
        # nested segments
        segs = ms.get("segments") or ms.get("data") or []
        if isinstance(segs, dict):
            for v in segs.values():
                if isinstance(v, dict) and v.get("market_status"):
                    return str(v["market_status"]).upper()
        if isinstance(ms.get("data"), str):
            return ms["data"].upper()
    return "OPEN" if ms else "UNKNOWN"


# --------------------------------------------------------------- backfill ----
_backfill_done = set()


def history_backfill_loop(client: UpstoxClient):
    """Fetch daily candles for enabled underlyings + their ATM±range contracts."""
    while not _ws_stop.is_set():
        try:
            _backfill_once(client)
        except Exception as e:  # pragma: no cover - defensive
            db.log("error", "backfill", f"history backfill error: {e}")
        for _ in range(60):
            if _ws_stop.is_set():
                return
            time.sleep(1)


def _backfill_once(client: UpstoxClient):
    if not db.token_valid():
        return
    settings = db.get_settings()
    atm_range = int(float(settings.get("atm_range") or 15))
    for w in db.enabled_watchlist():
        sym = w["symbol"]
        k = db.resolve_underlying_key(sym)
        if not k:
            continue
        tag = f"u:{sym}"
        if tag not in _backfill_done:
            _fetch_candles(client, sym, k, allow_partial=False)
            _backfill_done.add(tag)
            time.sleep(config.API_DELAY_SECONDS)
        # option contracts in stored window
        rows = db.latest_chain(sym)
        if not rows:
            continue
        spot = w.get("last_price")
        strikes = sorted({r["strike"] for r in rows if r.get("strike") is not None})
        if spot and strikes:
            atm = min(strikes, key=lambda s: abs(s - spot))
            idx = strikes.index(atm)
            window = set(strikes[max(0, idx - atm_range): idx + atm_range + 1])
        else:
            window = set(strikes)
        keys_done = 0
        for r in rows:
            if r.get("strike") not in window or not r.get("instrument_key"):
                continue
            tag = f"o:{r['instrument_key']}"
            if tag in _backfill_done:
                continue
            _fetch_candles(client, sym, r["instrument_key"], allow_partial=True)
            _backfill_done.add(tag)
            keys_done += 1
            time.sleep(config.API_DELAY_SECONDS)
            if keys_done >= 40:  # keep API usage bounded per pass
                return


def _fetch_candles(client: UpstoxClient, symbol: str, key: str, allow_partial: bool):
    try:
        candles = client.historical_candles(key)
    except UpstoxError as e:
        db.log("warn", "backfill", f"candles {key}: {e}")
        return
    for c in candles:
        db.upsert_market_row("candle", symbol, key, c["ts"], c["date"],
                             open=c["open"], high=c["high"], low=c["low"],
                             close=c["close"], volume=c["volume"])
    if candles:
        db.log("info", "backfill", f"{symbol}: {len(candles)} daily candles stored for {key}")
