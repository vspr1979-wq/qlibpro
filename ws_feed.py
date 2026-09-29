"""Best-effort WebSocket live-feed monitor with automatic reconnection.

Upstox has discontinued its market-data WebSocket feed (official docs), so the
authoritative live path is REST option-chain/quote polling in collector.py.
This worker still attempts the documented feed endpoint, handles disconnects
with backoff/reconnection, reports feed status in the UI, and — if the endpoint
ever serves JSON frames — folds incoming ticks into SQLite. No mock data.
"""
import json
import threading
import time

import config
import database as db
from collector import STATE

try:
    from websocket import WebSocketApp
    _HAVE_WS = True
except ImportError:  # pragma: no cover
    _HAVE_WS = False

_thread = None
_backoff = 10


def _feed_url() -> str:
    b = db.get_broker()
    return (f"wss://api.upstox.com/v2/feed/market-data-feed"
            f"?api_key={b.get('api_key') or ''}"
            f"&access_token={b.get('access_token') or ''}")


def _apply_tick(key: str, payload: dict, ts: int):
    meta = db.contract_meta(key)
    symbol = meta.get("underlying")
    if not symbol:
        return
    ltp = (payload.get("ltpc") or {}).get("ltp")
    ltq = (payload.get("ltpc") or {}).get("ltq")
    g = payload.get("optionGreeks") or {}
    ba = payload.get("bidAskQuote") or {}
    ef = payload.get("eFeedDetails") or {}
    oi = ef.get("oi")
    if ltp is None and oi is None:
        return
    db.upsert_chain_rows(
        symbol, meta.get("expiry") or "", ts, db.iso(ts)[:10],
        [{
            "strike": meta.get("strike"), "option_type": meta.get("option_type"),
            "instrument_key": key, "trading_symbol": meta.get("trading_symbol"),
            "ltp": ltp, "bid": ba.get("bp"), "ask": ba.get("ap"),
            "spread": (ba.get("ap") - ba.get("bp"))
            if (ba.get("ap") is not None and ba.get("bp") is not None) else None,
            "oi": oi, "chg_oi": None,
            "volume": ef.get("vtt"), "iv": g.get("iv"), "delta": g.get("delta"),
            "gamma": g.get("gamma"), "theta": g.get("theta"), "vega": g.get("vega"),
            "ltq": ltq, "lot_size": meta.get("lot_size") or 0,
        }],
    )


def _on_open(ws):
    STATE["ws_status"] = "connected"
    db.log("info", "ws", "market-data feed websocket connected")


def _on_message(ws, message):
    try:
        data = json.loads(message)
    except ValueError:
        return
    ts = int(data.get("currentTs") or db.now_ms())
    feeds = data.get("feeds") or {}
    for key, payload in feeds.items():
        if not isinstance(payload, dict):
            continue
        oc = payload.get("oc") or payload
        try:
            _apply_tick(key, oc, ts)
        except Exception as e:
            db.log("warn", "ws", f"tick apply failed: {e}")


def _on_error(ws, error):
    STATE["ws_status"] = f"error: {error}"
    db.log("warn", "ws", f"feed error: {error} — falling back to REST live polling")


def _on_close(ws, code, msg):
    STATE["ws_status"] = "disconnected"
    db.log("warn", "ws", f"feed disconnected (code {code}) — reconnection scheduled")


def _ws_loop():
    global _backoff
    while True:
        time.sleep(5)
        if not db.token_valid():
            time.sleep(10)
            continue
        if not _HAVE_WS:
            STATE["ws_status"] = "websocket-client not installed (REST active)"
            return
        url = _feed_url()
        STATE["ws_status"] = "connecting"
        ws = WebSocketApp(url, on_open=_on_open, on_message=_on_message,
                          on_error=_on_error, on_close=_on_close)
        try:
            ws.run_forever(ping_interval=20, ping_timeout=10)
        except Exception as e:
            db.log("warn", "ws", f"feed run error: {e}")
        # disconnected (feed discontinued or network issue) -> retry with backoff
        STATE["ws_status"] = "unavailable — REST live feed active"
        time.sleep(_backoff)
        _backoff = min(_backoff * 2, 600)


def start():
    global _thread
    if _thread is not None:
        return
    _thread = threading.Thread(target=_ws_loop, name="ws-feed", daemon=True)
    _thread.start()
