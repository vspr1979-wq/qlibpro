"""OptionSignal — Flask application.

4 pages only (Dashboard / Watchlist & Option Chain / QLib Analysis / Settings),
signals only (never places orders), real Upstox data + Microsoft Qlib.

Run:  python app.py      (http://127.0.0.1:5000)
"""
from datetime import datetime

from flask import (Flask, jsonify, redirect, render_template, request, url_for)

import config
import database as db
import qlib_engine
import scheduler
import signal_engine
from collector import STATE as COLLECT_STATE

app = Flask(__name__)
db.init_schema()


# ------------------------------------------------------------------ pages ---
@app.route("/")
def page_dashboard():
    return render_template("dashboard.html", page="dashboard")


@app.route("/watchlist")
def page_watchlist():
    return render_template("watchlist.html", page="watchlist")


@app.route("/qlib-analysis")
def page_qlib():
    return render_template("qlib.html", page="qlib")


@app.route("/settings")
def page_settings():
    return render_template("settings.html", page="settings")


# --------------------------------------------------------------- OAuth -----
@app.route("/upstox/callback")
def upstox_callback():
    error = request.args.get("error")
    desc = request.args.get("error_description") or ""
    code = request.args.get("code")
    state = request.args.get("state")
    if error:
        db.log("error", "oauth", f"callback error: {error} {desc}")
        return redirect(url_for("page_settings", auth="error",
                                msg=f"{error}: {desc}"))
    if not code:
        db.log("error", "oauth", "callback missing authorization code")
        return redirect(url_for("page_settings", auth="error", msg="missing code"))
    expected = db.get_settings().get("oauth_state") or ""
    if expected and state != expected:
        db.log("error", "oauth", "callback state mismatch")
        return redirect(url_for("page_settings", auth="error", msg="state mismatch"))
    try:
        scheduler.client().exchange_token(code, state or "")
    except Exception as e:
        return redirect(url_for("page_settings", auth="error", msg=str(e)))
    # automatic instruments download after successful auth
    def _dl():
        try:
            n = scheduler.client().download_instruments()
            COLLECT_STATE["last_instruments"] = db.iso()
            db.log("info", "oauth", f"auto instruments download complete: {n}")
        except Exception as e:
            db.log("error", "instr", f"auto instruments download failed: {e}")
    from threading import Thread
    Thread(target=_dl, daemon=True).start()
    return redirect(url_for("page_settings", auth="ok"))


# ------------------------------------------------------------------ APIs ----
@app.route("/api/status")
def api_status():
    b = db.get_broker()
    connected = db.token_valid(b)
    wl = db.enabled_watchlist()
    data = []
    for w in wl:
        ts = w.get("last_ts") or 0
        chain_ts = db.latest_chain_ts(w["symbol"])
        newest = max(ts, chain_ts)
        age = (db.now_ms() - newest) / 1000 if newest else None
        data.append({
            "symbol": w["symbol"],
            "spot": w.get("last_price"),
            "age_s": round(age, 1) if age is not None else None,
            "fresh": bool(newest and age is not None and age <= config.QUOTE_STALE_AFTER_S),
        })
    model = db.model_row()
    metrics = model.get("metrics_parsed") if model else {}
    qlib_state = dict(qlib_engine.STATE)
    qlib_state.pop("_last_infer", None)
    return jsonify({
        "connected": connected,
        "market": COLLECT_STATE.get("market", "UNKNOWN"),
        "qlib": {
            "status": qlib_state.get("status", "IDLE"),
            "message": qlib_state.get("message", ""),
            "ready": qlib_engine.STATE.get("ready", False),
            "model_status": (model or {}).get("status"),
            "trained_at": (model or {}).get("updated_at") or
                          (db.iso(model["ts"]) if model and model.get("ts") else None),
            "oos_ic": metrics.get("oos_ic"),
            "oos_dir_acc": metrics.get("oos_dir_acc"),
        },
        "feed": COLLECT_STATE.get("feed", "REST live feed"),
        "last_error": COLLECT_STATE.get("last_error", ""),
        "instruments": db.instruments_count(),
        "symbols": len(wl),
        "data": data,
        "last_cycle": db.iso(COLLECT_STATE["last_cycle_ts"])
        if COLLECT_STATE.get("last_cycle_ts") else None,
        "signal_state": signal_engine.STATE.get("last_summary", {}),
        "version": config.VERSION,
    })


@app.route("/api/dashboard")
def api_dashboard():
    wl = db.watchlist()
    sigs = {s["symbol"]: s for s in db.all_signals()}
    board = []
    for w in wl:
        if not w.get("enabled"):
            continue
        s = sigs.get(w["symbol"]) or {}
        strike = s.get("strike")
        opt = f"{int(strike)} {s.get('option_type')}" if strike and s.get("option_type") \
            else "—"
        signal = s.get("signal") or "NO TRADE"
        board.append({
            "symbol": w["symbol"],
            "spot": w.get("last_price"),
            "change_pct": w.get("last_change_pct"),
            "qlib_view": s.get("qlib_direction") or "—",
            "confidence": s.get("confidence"),
            "signal": signal,
            "strategy": s.get("strategy") or "—",
            "option": opt if signal != "NO TRADE" else "—",
            "status": "ACTIVE" if signal != "NO TRADE" else "WAIT",
            "time": db.iso(s["ts"])[11:19] if s.get("ts") else "—",
            "reason": s.get("reason") or "",
        })
    history = db.signal_history(8)
    return jsonify({"board": board, "signals": sigs, "history": history,
                    "updated": db.iso()})


@app.route("/api/chain")
def api_chain():
    symbol = (request.args.get("symbol") or "").upper()
    wl = {w["symbol"]: w for w in db.enabled_watchlist()}
    if symbol not in wl:
        return jsonify({"error": "symbol not in enabled watchlist"}), 400
    s = db.get_settings()
    try:
        atm_range = int(float(s.get("atm_range") or 15))
    except ValueError:
        atm_range = 15
    rows = db.latest_chain(symbol)
    if not rows:
        return jsonify({"symbol": symbol, "rows": [], "ts": None,
                        "message": "no chain data yet — connect Upstox and wait for collection"})
    spot = wl[symbol].get("last_price")
    expiry = rows[0].get("expiry")
    strikes = sorted({r["strike"] for r in rows if r.get("strike") is not None})
    atm = min(strikes, key=lambda x: abs(x - (spot or x))) if strikes else None
    i = strikes.index(atm) if atm in strikes else 0
    window = set(strikes[max(0, i - atm_range): i + atm_range + 1])
    by_strike = {}
    lot = 0
    for r in rows:
        if r.get("strike") not in window:
            continue
        st = by_strike.setdefault(r["strike"], {"strike": r["strike"]})
        side = "ce" if r["option_type"] == "CE" else "pe"
        st[side] = {
            "premium": r.get("ltp"), "bid": r.get("bid"), "ask": r.get("ask"),
            "spread": r.get("spread"), "oi": r.get("oi"), "chg_oi": r.get("chg_oi"),
            "volume": r.get("volume"), "iv": r.get("iv"), "delta": r.get("delta"),
            "gamma": r.get("gamma"), "theta": r.get("theta"), "vega": r.get("vega"),
            "ltq": r.get("ltq"), "key": r.get("instrument_key"),
        }
        lot = max(lot, r.get("lot_size") or 0)
    ts = max((r.get("ts") or 0) for r in rows)
    return jsonify({
        "symbol": symbol, "spot": spot, "atm": atm, "expiry": expiry,
        "lot_size": lot, "range": atm_range, "ts": db.iso(ts),
        "fresh": (db.now_ms() - ts) <= config.QUOTE_STALE_AFTER_S * 1000,
        "rows": [by_strike[k] for k in sorted(by_strike)],
    })


# --------------------------------------------------------------- watchlist --
@app.route("/api/watchlist", methods=["GET", "POST"])
def api_watchlist():
    if request.method == "GET":
        q = (request.args.get("q") or "").upper()
        results = []
        if q:
            results = db.search_underlyings(q)
        lots = []
        for w in db.watchlist():
            lot, step = db.lot_and_step(w["symbol"])
            lots.append({"symbol": w["symbol"], "lot": lot, "step": step,
                         "enabled": bool(w.get("enabled"))})
        return jsonify({"items": db.watchlist(), "results": results, "lots": lots})
    body = request.get_json(force=True, silent=True) or {}
    action = body.get("action")
    symbol = (body.get("symbol") or "").strip().upper()
    if action == "add":
        if not symbol:
            return jsonify({"error": "symbol required"}), 400
        key = db.resolve_underlying_key(symbol)
        db.watchlist_add(symbol, key)
        if not key:
            db.log("warn", "watchlist",
                   f"{symbol}: no instrument found — download instruments in Settings")
        db.log("info", "watchlist", f"{symbol} added (enabled)")
    elif action == "remove":
        db.watchlist_remove(symbol)
        db.log("info", "watchlist", f"{symbol} removed")
    elif action == "toggle":
        db.watchlist_toggle(symbol, bool(body.get("enabled")))
        db.log("info", "watchlist", f"{symbol} {'enabled' if body.get('enabled') else 'disabled'}")
    else:
        return jsonify({"error": "unknown action"}), 400
    return jsonify({"items": db.watchlist()})


# ------------------------------------------------------------ qlib page -----
@app.route("/api/qlib/model")
def api_qlib_model():
    model = db.model_row()
    metrics = model.get("metrics_parsed") if model else {}
    st = dict(qlib_engine.STATE)
    st.pop("_last_infer", None)
    return jsonify({"state": st, "row": model or {}, "metrics": metrics})


@app.route("/api/qlib/rows")
def api_qlib_rows():
    symbol = (request.args.get("symbol") or "ALL").upper()
    if symbol == "ALL":
        rows = []
        for w in db.enabled_watchlist():
            rows.extend(db.candidates_for(w["symbol"]))
    else:
        rows = db.candidates_for(symbol)
    return jsonify({"rows": rows, "updated": db.iso()})


@app.route("/api/qlib/run", methods=["POST"])
def api_qlib_run():
    """Manual, optional training/analysis run (auto pipeline is independent)."""
    scheduler.force_retrain()
    db.log("info", "qlib", "manual Run Analysis requested from UI")
    return jsonify({"ok": True, "message": "manual analysis queued — runs shortly"})


# -------------------------------------------------------------- settings ----
@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        b = db.get_broker()
        return jsonify({
            "settings": db.get_settings(),
            "broker": {
                "api_key": b.get("api_key") or "",
                "api_secret": b.get("api_secret") or "",
                "redirect_url": b.get("redirect_url") or config.DEFAULT_SETTINGS["redirect_url"],
                "connected": bool(db.token_valid(b)),
                "token_expiry": db.iso(b["token_expiry"]) if b.get("token_expiry") else None,
            },
        })
    body = request.get_json(force=True, silent=True) or {}
    if "settings" in body:
        db.save_settings(body["settings"])
        db.log("info", "settings", "strategy settings saved")
    if any(k in body for k in ("api_key", "api_secret", "redirect_url")):
        db.save_broker(
            api_key=body.get("api_key"),
            api_secret=body.get("api_secret"),
            redirect_url=body.get("redirect_url"),
        )
        db.log("info", "settings", "broker credentials saved")
    return jsonify({"ok": True})


@app.route("/api/connect", methods=["POST"])
def api_connect():
    body = request.get_json(force=True, silent=True) or {}
    if any(k in body for k in ("api_key", "api_secret", "redirect_url")):
        db.save_broker(
            api_key=body.get("api_key"),
            api_secret=body.get("api_secret"),
            redirect_url=body.get("redirect_url"),
        )
    b = db.get_broker()
    if not b.get("api_key"):
        return jsonify({"error": "API Key required before CONNECT"}), 400
    import secrets
    state = secrets.token_urlsafe(16)
    db.save_settings({"oauth_state": state})
    try:
        url = scheduler.client().auth_url(state)
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    db.log("info", "oauth", "CONNECT pressed — opening Upstox authorization")
    return jsonify({"auth_url": url})


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    scheduler.client().disconnect()
    signal_engine.ensure_no_trade_all("Disconnected by user from Settings.")
    return jsonify({"ok": True})


@app.route("/api/instruments/refresh", methods=["POST"])
def api_instruments():
    from threading import Thread

    def _dl():
        try:
            scheduler.client().download_instruments()
            COLLECT_STATE["last_instruments"] = db.iso()
        except Exception:
            pass

    if db.token_valid() or config.INSTRUMENTS_CACHE.exists():
        Thread(target=_dl, daemon=True).start()
        return jsonify({"ok": True, "message": "instruments download started"})
    return jsonify({"error": "connect first (or provide cache)"}), 400


@app.route("/api/logs")
def api_logs():
    try:
        limit = min(200, int(request.args.get("limit") or 50))
    except ValueError:
        limit = 50
    return jsonify({"logs": db.tail_logs(limit)})


# ----------------------------------------------------------------- start ----
scheduler.start_all()

if __name__ == "__main__":
    print(f"OptionSignal v{config.VERSION} → http://{config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True,
            use_reloader=False)
