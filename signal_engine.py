"""Signal engine — runs the full pipeline each cycle:

  Upstox → Watchlist → Live Data → Option Chain ATM±R → Qlib
  → Normal + Small-Premium strategies → Strike selection → Risk check
  → BUY CE / BUY PE / NO TRADE

Only enabled watchlist symbols are ever evaluated (enforced here in the
service layer, not in the UI). Never places orders.
"""
import time
from collections import Counter

import config
import database as db
import qlib_engine
import strategy_engine
from collector import STATE as COLLECT_STATE

STATE = {"last_run_ts": 0, "last_summary": {}}


def _fresh(ts_ms: int) -> bool:
    return ts_ms and (db.now_ms() - ts_ms) <= config.QUOTE_STALE_AFTER_S * 1000


def run_cycle() -> dict:
    """Evaluate every enabled watchlist symbol; persist signals."""
    summary = {"signals": 0, "no_trade": 0, "errors": 0}
    wl = db.enabled_watchlist()
    if not wl:
        STATE["last_run_ts"] = db.now_ms()
        STATE["last_summary"] = summary
        return summary

    connected = db.token_valid()
    if not connected:
        COLLECT_STATE["last_error"] = "not connected"
        STATE["last_run_ts"] = db.now_ms()
        STATE["last_summary"] = summary
        return summary

    # Qlib inference for all candidate contracts (auto; None until validated)
    model_row = db.model_row()
    scores = qlib_engine.infer()
    model_meta = model_row if model_row else {"metrics": {}}
    if not model_meta.get("metrics"):
        model_meta["metrics"] = qlib_engine.STATE.get("metrics") or {}

    for w in wl:
        sym = w["symbol"]
        chain_ts = db.latest_chain_ts(sym)
        rows = db.latest_chain(sym) if chain_ts else []

        if not rows:
            _signal(sym, strategy_engine._no_trade(
                sym, {}, "No option chain data yet — waiting for live collection. "
                         "## Wait for a stronger setup."))
            summary["no_trade"] += 1
            continue
        if not _fresh(chain_ts) or not _fresh(w.get("last_ts") or 0):
            _signal(sym, strategy_engine._no_trade(
                sym, {}, f"Stale market data (last update {db.iso(chain_ts)}) — "
                         "signal suppressed until fresh quotes arrive."))
            summary["no_trade"] += 1
            continue
        if scores is None:
            status = qlib_engine.STATE.get("status", "IDLE")
            msg = qlib_engine.STATE.get("message", "model not ready")
            _signal(sym, strategy_engine._no_trade(
                sym, {}, f"Qlib status {status}: {msg}."))
            summary["no_trade"] += 1
            continue

        try:
            sig = strategy_engine.evaluate_symbol(
                sym, rows, w.get("last_price"), scores, model_meta)
        except Exception as e:
            db.log("error", "signal", f"{sym}: strategy error: {e}")
            sig = strategy_engine._no_trade(
                sym, {}, f"internal error during evaluation: {e}")
            summary["errors"] += 1
        _signal(sym, sig)
        if sig.get("signal") == "NO TRADE":
            summary["no_trade"] += 1
        else:
            summary["signals"] += 1
            db.log("info", "signal",
                   f"{sym} → {sig['signal']} {sig.get('trading_symbol') or ''} "
                   f"@ {sig.get('premium')} ({sig.get('quantity')} qty, "
                   f"{sig.get('lots')} lots × {sig.get('lot_size')})")

    STATE["last_run_ts"] = db.now_ms()
    STATE["last_summary"] = summary
    return summary


def _signal(sym: str, sig: dict) -> None:
    if not sig:
        return
    db.upsert_signal(sym, sig)


def ensure_no_trade_all(reason: str) -> None:
    """Write NO TRADE rows for all enabled symbols (e.g. when disconnected)."""
    for w in db.enabled_watchlist():
        cur = db.get_signal(w["symbol"])
        if cur is None or cur.get("signal") != "NO TRADE":
            db.upsert_signal(w["symbol"], strategy_engine._no_trade(
                w["symbol"], {}, reason))
