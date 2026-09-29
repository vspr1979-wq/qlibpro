"""Background workers: collection loop, history backfill, training scheduler.

Everything runs automatically:
  - collect live chains for all enabled watchlist symbols
  - run the signal pipeline after each collection cycle
  - backfill daily history for Qlib
  - retrain daily at 16:00 IST and whenever fresh data arrives
"""
import threading
import time
from datetime import datetime, timedelta

import config
import database as db
import qlib_engine
import signal_engine
from collector import (STATE as COLLECT_STATE, collect_once,
                       history_backfill_loop, _ws_stop)
from upstox_client import UpstoxClient

_threads = []
_client = None
_last_train_marker = None
_force_train = threading.Event()


def client() -> UpstoxClient:
    global _client
    if _client is None:
        _client = UpstoxClient()
    return _client


def force_retrain():
    _force_train.set()


def _next_daily_at(hhmm: str) -> float:
    hh, mm = (int(x) for x in hhmm.split(":"))
    now = datetime.now()
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target.timestamp()


def _data_marker() -> int:
    return int(db.latest_chain_ts("*") or 0) + _row_count()


def _row_count() -> int:
    with db._lock:
        c = db._connect()
        try:
            return int(c.execute("SELECT COUNT(*) n FROM option_chain").fetchone()["n"])
        except Exception:
            return 0


def _collector_loop():
    c = client()
    while not _ws_stop.is_set():
        try:
            if db.token_valid():
                collect_once(c)
                signal_engine.run_cycle()
            else:
                signal_engine.ensure_no_trade_all(
                    "Not connected — connect Upstox in Settings.")
                COLLECT_STATE["last_error"] = "not connected"
        except Exception as e:
            db.log("error", "collector", f"cycle error: {e}")
            COLLECT_STATE["last_error"] = str(e)
        # interruptible sleep
        for _ in range(int(config.COLLECTOR_CYCLE_SECONDS * 2)):
            if _ws_stop.is_set():
                return
            time.sleep(0.5)


def _trainer_loop():
    global _last_train_marker
    due_ts = _next_daily_at(config.TRAINER_DAILY_AT)
    next_check = 0.0
    while not _ws_stop.is_set():
        time.sleep(5)
        if _ws_stop.is_set():
            return
        # manual override: always handled immediately
        if _force_train.is_set():
            _force_train.clear()
            try:
                qlib_engine.train()
                _last_train_marker = _row_count()
            except Exception as e:
                db.log("error", "trainer", f"manual train error: {e}")
            continue
        now = time.time()
        if now < next_check:
            continue
        next_check = now + config.TRAINER_INTERVAL_S
        try:
            marker = _row_count()
            grown = _last_train_marker is None or marker >= _last_train_marker * 1.15
            if now >= due_ts:
                qlib_engine.train()
                _last_train_marker = _row_count()
                due_ts = _next_daily_at(config.TRAINER_DAILY_AT)
            elif qlib_engine.STATE.get("status") in ("IDLE", "WAITING_DATA", "ERROR") \
                    and grown and marker >= config.MIN_TRAIN_ROWS:
                # first training as soon as enough data exists
                qlib_engine.train()
                _last_train_marker = _row_count()
            elif grown and marker >= config.MIN_TRAIN_ROWS * 2 and \
                    (db.model_row() or {}).get("ts", 0) < db.now_ms() - 6 * 3600 * 1000 \
                    and (db.model_row() or {}).get("status") == "PASSED":
                # continuous learning: refresh when meaningful new data exists
                qlib_engine.train()
                _last_train_marker = _row_count()
        except Exception as e:
            db.log("error", "trainer", f"trainer error: {e}")


def start_all():
    if _threads:
        return
    db.init_schema()
    qlib_engine.load_bundle()
    for fn, name in (
        (_collector_loop, "collector"),
        (_trainer_loop, "trainer"),
        (lambda: history_backfill_loop(client()), "backfill"),
    ):
        t = threading.Thread(target=fn, name=name, daemon=True)
        t.start()
        _threads.append(t)
    try:
        import ws_feed
        ws_feed.start()
    except Exception as e:
        db.log("warn", "ws", f"feed monitor not started: {e}")
    db.log("info", "app", "background workers started "
           "(collector, trainer, history backfill, ws monitor)")


def stop_all():
    _ws_stop.set()
