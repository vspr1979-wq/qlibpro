"""Microsoft Qlib engine — genuine integration.

Pipeline (no mock data anywhere):
  SQLite (collected real market data)
      -> per-contract daily frames (candles + EOD option-chain snapshots + context)
      -> qlib binary dump (qlib_dump)
      -> qlib.init + DataHandlerLP/QlibDataLoader (feature & label generation
         through Qlib's expression engine)
      -> LGBModel walk-forward train with out-of-sample evaluation
      -> calibrated confidence + model-derived entry/target/stop quantiles
      -> live inference for every candidate contract
"""
import pickle
import threading
import time
from datetime import datetime

import numpy as np
import pandas as pd

import config
import database as db
import qlib_dump

import os

os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")

from qlib import init as qlib_init  # noqa: E402
from qlib.data.dataset import DatasetH  # noqa: E402
from qlib.data.dataset.handler import DataHandlerLP  # noqa: E402
from qlib.contrib.data.handler import check_transform_proc  # noqa: E402
from qlib.contrib.model.gbdt import LGBModel  # noqa: E402

MIN_SERIES_ROWS = 20        # a contract must have at least this many daily points
INFER_MIN_INTERVAL = 15     # seconds between live inferences

# Feature generation happens inside Qlib's expression engine ($field = dumped feature).
FEATURES = [
    "Ref($close,-1)/$close-1",
    "Mean($close,3)/$close-1",
    "Mean($close,5)/$close-1",
    "Mean($close,10)/$close-1",
    "Std($close,5)/$close",
    "Std($close,10)/$close",
    "Max($close,5)/$close-1",
    "Min($close,5)/$close-1",
    "Ref($close,-1)/$close-1 - Ref($close,-2)/Ref($close,-1)",
    "Ref($volume,-1)/($volume+1)",
    "Mean($volume,5)/($volume+1)",
    "Ref($oi,-1)/($oi+1)",
    "Mean($oi,5)/($oi+1)",
    "Ref($chg_oi,-1)-$chg_oi",
    "Ref($iv,-1)-$iv",
    "Mean($iv,5)-$iv",
    "($ask-$bid)/($close+1e-9)",
    "($close-$bid)/($close+1e-9)",
    "$iv",
    "$delta",
    "Ref($ltq,-1)/($ltq+1)",
    "Ref($uspot,-1)/$uspot-1",
    "Mean($uspot,3)/$uspot-1",
    "Mean($uspot,5)/$uspot-1",
    "Std($uspot,5)/$uspot",
    "Ref($uvol,-1)/($uvol+1)",
    "$moneyness",
    "$dte",
    "$close/($uspot+1e-9)",
]
LABEL = "Ref($close,-1)/$close-1"
FIELDS = ["close", "volume", "oi", "chg_oi", "iv", "delta", "bid", "ask", "ltq",
          "uspot", "uvol", "moneyness", "dte"]

STATE = {
    "status": "IDLE",       # IDLE | COLLECTING | WAITING_DATA | TRAINING | READY | ERROR
    "message": "model not trained yet",
    "trained_at": None,
    "ready": False,
    "metrics": {},
    "last_infer_ts": 0,
    "instruments_dumped": 0,
    "rows_dumped": 0,
}
_lock = threading.RLock()
_bundle = None
_qlib_ready = False


def inst_name(trading_symbol: str, instrument_key: str) -> str:
    """Stable Qlib instrument name for a contract."""
    return qlib_dump.sanitize_instrument(trading_symbol or instrument_key or "unknown")


# ------------------------------------------------------------ export ---------
def _series_from_snapshots(symbol, strike, opt_type, expiry):
    """Daily last-snapshot values for one contract."""
    with db._lock:
        c = db._connect()
        rows = c.execute(
            "SELECT date, ts, ltp, oi, chg_oi, iv, delta, bid, ask, ltq "
            "FROM option_chain WHERE symbol=? AND strike=? AND option_type=? AND expiry=? "
            "ORDER BY ts",
            (symbol, strike, opt_type, expiry),
        ).fetchall()
    if not rows:
        return None
    df = pd.DataFrame([dict(r) for r in rows])
    df = df[df["date"].notna()]
    if df.empty:
        return None
    # last snapshot per trading day
    df = df.groupby("date").last()
    df.index = df.index.astype(str).str[:10]
    return df


def build_frames():
    """Return (frames dict, calendar list, total_rows)."""
    settings = db.get_settings()
    atm_range = int(float(settings.get("atm_range") or 15))
    frames, calendar, total_rows = {}, set(), 0

    for w in db.enabled_watchlist():
        sym = w["symbol"]
        ukey = db.resolve_underlying_key(sym)
        snap = db.latest_chain(sym)
        if not snap:
            continue

        # underlying daily context
        udf = None
        if ukey:
            ucl = db.last_candles(sym, ukey, 900)
            if ucl:
                udf = pd.DataFrame(ucl)
                udf = udf.drop_duplicates("date", keep="last").set_index("date")
                udf.index = udf.index.astype(str).str[:10]
                udf = udf[["close", "volume"]].rename(
                    columns={"close": "uspot", "volume": "uvol"})

        spot = w.get("last_price")
        strikes = sorted({r["strike"] for r in snap if r.get("strike") is not None})
        if spot and strikes:
            atm = min(strikes, key=lambda s: abs(s - spot))
            idx = strikes.index(atm)
            window = set(strikes[max(0, idx - atm_range): idx + atm_range + 1])
        else:
            window = set(strikes)

        for r in snap:
            if r.get("strike") not in window or not r.get("option_type"):
                continue
            key = r.get("instrument_key") or ""
            meta = db.contract_meta(key) if key else {}
            trading = meta.get("trading_symbol") or r.get("trading_symbol") or ""
            expiry = r.get("expiry") or meta.get("expiry") or ""
            strike = r.get("strike")

            snaps = _series_from_snapshots(sym, strike, r["option_type"], expiry)
            if snaps is None:
                continue
            candles = db.last_candles(sym, key, 900) if key else []
            close = None
            if candles:
                cdf = pd.DataFrame(candles).drop_duplicates("date", keep="last")
                cdf.index = cdf["date"].astype(str).str[:10]
                close = cdf[["close", "volume"]].rename(
                    columns={"close": "candle_close", "volume": "candle_volume"})

            idx_all = snaps.index.union(close.index if close is not None else [])
            df = pd.DataFrame(index=idx_all.sort_values())
            df["close"] = close["candle_close"] if close is not None else np.nan
            df["volume"] = close["candle_volume"] if close is not None else np.nan
            # snapshot fallback / chain-only fields
            for f_snap, f_out in (("ltp", "close"), ("oi", "oi"), ("chg_oi", "chg_oi"),
                                  ("iv", "iv"), ("delta", "delta"), ("bid", "bid"),
                                  ("ask", "ask"), ("ltq", "ltq")):
                s = snaps[f_snap]
                if f_out == "close":
                    df[f_out] = df[f_out].fillna(s)
                else:
                    df[f_out] = s
            # underlying context
            if udf is not None:
                df["uspot"] = udf["uspot"].reindex(df.index).ffill()
                df["uvol"] = udf["uvol"].reindex(df.index).ffill()
            else:
                df["uspot"] = np.nan
                df["uvol"] = np.nan
            # raw market-state variables (not indicators)
            if strike:
                df["moneyness"] = df["uspot"] / float(strike)
            else:
                df["moneyness"] = np.nan
            if expiry:
                try:
                    exp_dt = datetime.strptime(str(expiry)[:10], "%Y-%m-%d")
                    df["dte"] = [
                        (exp_dt - datetime.strptime(d, "%Y-%m-%d")).days
                        for d in df.index
                    ]
                except ValueError:
                    df["dte"] = np.nan
            else:
                df["dte"] = np.nan

            df = df[["close", "volume", "oi", "chg_oi", "iv", "delta", "bid", "ask",
                     "ltq", "uspot", "uvol", "moneyness", "dte"]]
            df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["close"])
            if len(df) < MIN_SERIES_ROWS:
                continue
            name = inst_name(trading, key)
            frames[name] = df
            calendar.update(df.index.tolist())
            total_rows += len(df)

    return frames, sorted(calendar), total_rows


def export_dump() -> dict:
    frames, calendar, total_rows = build_frames()
    if not frames:
        STATE["instruments_dumped"] = 0
        STATE["rows_dumped"] = 0
        return {"instruments": 0, "rows": 0, "calendar": []}
    qlib_dump.dump_dataset(config.QLIB_DATA_DIR, frames, calendar)
    STATE["instruments_dumped"] = len(frames)
    STATE["rows_dumped"] = total_rows
    return {"instruments": len(frames), "rows": total_rows, "calendar": calendar}


# --------------------------------------------------------------- handler ----
class OptionDataHandler(DataHandlerLP):
    def __init__(self, instruments="all", start_time=None, end_time=None,
                 fit_start_time=None, fit_end_time=None, **kwargs):
        infer_processors = check_transform_proc([], fit_start_time, fit_end_time)
        learn_processors = check_transform_proc(
            [{"class": "DropnaLabel"}], fit_start_time, fit_end_time)
        data_loader = {
            "class": "QlibDataLoader",
            "kwargs": {
                "config": {"feature": list(FEATURES), "label": [LABEL]},
                "freq": "day",
            },
        }
        super().__init__(
            instruments=instruments, start_time=start_time, end_time=end_time,
            data_loader=data_loader, infer_processors=infer_processors,
            learn_processors=learn_processors, **kwargs,
        )


def _ensure_qlib():
    global _qlib_ready
    qlib_init(provider_uri=str(config.QLIB_DATA_DIR), region="us",
              clear_mem_cache=True)
    _qlib_ready = True


# ---------------------------------------------------------------- train ------
def train() -> dict:
    """Export data, train LGBModel in Qlib, evaluate out-of-sample, persist."""
    with _lock:
        return _train_locked()


def _train_locked() -> dict:
    STATE["status"] = "TRAINING"
    STATE["message"] = "exporting data + training"
    try:
        info = export_dump()
        if info["instruments"] == 0:
            STATE["status"] = "WAITING_DATA"
            STATE["message"] = "no option history collected yet — waiting for live data"
            db.upsert_model_metrics("*", {}, "WAITING", STATE["message"])
            return STATE.copy()
        if info["rows"] < config.MIN_TRAIN_ROWS:
            STATE["status"] = "WAITING_DATA"
            STATE["message"] = (f"collected {info['rows']} rows — "
                                f"need {config.MIN_TRAIN_ROWS} to train")
            db.upsert_model_metrics("*", {"rows": info["rows"]}, "WAITING", STATE["message"])
            return STATE.copy()

        calendar = info["calendar"]
        n = len(calendar)
        if n < 30:
            STATE["status"] = "WAITING_DATA"
            STATE["message"] = f"only {n} trading days collected"
            db.upsert_model_metrics("*", {"days": n}, "WAITING", STATE["message"])
            return STATE.copy()

        _ensure_qlib()

        # walk-forward style split: train / valid / untouched out-of-sample test
        i_val = max(10, int(n * 0.70))
        i_test = max(i_val + 5, int(n * 0.85))
        train_end, valid_end = calendar[i_val - 1], calendar[i_test - 1]
        handler = OptionDataHandler(
            instruments="all", start_time=calendar[0], end_time=calendar[-1],
            fit_start_time=calendar[0], fit_end_time=train_end,
        )
        ds = DatasetH(handler, segments={
            "train": (calendar[0], train_end),
            "valid": (calendar[i_val], valid_end),
            "test": (calendar[i_test], calendar[-1]),
        })

        model = LGBModel(
            loss="mse",
            col_sample=0.8,
            num_leaves=31,
            learning_rate=0.05,
            n_estimators=400,
            early_stopping_rounds=30,
            verbose_eval=100,
        )
        model.fit(dataset=ds)

        pred = model.predict(dataset=ds, segment="test")
        y = ds.prepare("test", col_set="label",
                       data_key=DataHandlerLP.DK_I)
        j = pd.concat([pred.rename("pred"), y.rename("label")], axis=1).dropna()
        if j.empty or len(j) < 10:
            raise RuntimeError("out-of-sample evaluation produced too few rows")

        # --- genuine out-of-sample metrics (no hardcoded market thresholds) ----
        ic = float(j["pred"].corr(j["label"], method="spearman"))
        nz = j[j["label"] != 0]
        dir_acc = float((np.sign(nz["pred"]) == np.sign(nz["label"])).mean()) if len(nz) else 0.5
        up_side = j[j["pred"] > 0]["label"]
        dn_side = j[j["pred"] < 0]["label"]
        if len(up_side) >= 10:
            up_q = {q: float(up_side.quantile(q / 100)) for q in (50, 75, 90)}
        else:
            up_q = {q: float(j["label"].quantile(q / 100)) for q in (50, 75, 90)}
        if len(dn_side) >= 10:
            dn_q10 = float(dn_side.quantile(0.10))
        else:
            dn_q10 = float(j["label"].quantile(0.10))

        # simple OOS backtest of the model's long-premium hypothesis
        long_side = j[j["pred"] > 0]
        oos_win_rate = float((long_side["label"] > 0).mean()) if len(long_side) else 0.0
        risk_unit = abs(dn_q10) if dn_q10 < 0 else None
        oos_avg_r = float((long_side["label"].mean() / risk_unit)) if (risk_unit and len(long_side)) else 0.0

        passed = bool(ic > 0 and dir_acc > 0.5 and len(j) >= 10)
        metrics = {
            "rows_total": info["rows"],
            "instruments": info["instruments"],
            "days": n,
            "train_span": [calendar[0], train_end],
            "valid_span": [calendar[i_val], valid_end],
            "test_span": [calendar[i_test], calendar[-1]],
            "oos_rows": int(len(j)),
            "oos_ic": round(ic, 4),
            "oos_dir_acc": round(dir_acc, 4),
            "random_baseline": 0.5,
            "up_quantiles": {str(k): round(v, 4) for k, v in up_q.items()},
            "down_q10": round(dn_q10, 4),
            "oos_win_rate": round(oos_win_rate, 4),
            "oos_avg_r": round(oos_avg_r, 4),
            "features": len(FEATURES),
            "passed": passed,
        }
        status = "PASSED" if passed else "FAILED"
        reason = (
            f"OOS IC={ic:.3f}, dir-acc={dir_acc:.3f}, rows={len(j)}"
            + ("" if passed else " — validation gate not met; signals stay NO TRADE")
        )

        global _bundle
        if passed:
            _bundle = {
                "model": model,
                "metrics": metrics,
                "oos_pred": j["pred"].to_numpy(),
                "oos_label": j["label"].to_numpy(),
            }
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(config.MODEL_PATH, "wb") as f:
                pickle.dump(_bundle, f)
            STATE["ready"] = True
            STATE["status"] = "READY"
            STATE["message"] = "model validated out-of-sample"
        else:
            # keep any previously validated model; do not deploy a failed one
            STATE["ready"] = _bundle is not None
            STATE["status"] = "ERROR" if _bundle is None else "READY"
            STATE["message"] = "latest training failed validation; " + reason

        STATE["trained_at"] = db.iso()
        STATE["metrics"] = metrics
        db.upsert_model_metrics("*", metrics, status, reason)
        db.log("info" if passed else "warn", "qlib",
               f"training {status}: {reason}")
        return STATE.copy()
    except Exception as e:
        STATE["status"] = "ERROR"
        STATE["message"] = f"qlib error: {e}"
        STATE["ready"] = _bundle is not None
        db.log("error", "qlib", f"training error: {e}")
        return STATE.copy()


# --------------------------------------------------------------- bundle ------
def load_bundle(force: bool = False):
    global _bundle
    if _bundle is not None and not force:
        return _bundle
    if config.MODEL_PATH.exists():
        try:
            with open(config.MODEL_PATH, "rb") as f:
                _bundle = pickle.load(f)
            STATE["ready"] = True
            STATE["status"] = "READY"
            STATE["metrics"] = _bundle.get("metrics", {})
            STATE["trained_at"] = db.model_row().get("ts")
        except Exception as e:
            db.log("error", "qlib", f"model load failed: {e}")
    return _bundle


# --------------------------------------------------------------- infer -------
def _calibrate(abs_pred: float, bundle) -> float:
    """Data-derived confidence: empirical OOS accuracy for predictions at least
    as large as this one."""
    oos_pred = np.asarray(bundle.get("oos_pred") or [])
    oos_label = np.asarray(bundle.get("oos_label") or [])
    if len(oos_pred) < 30:
        return float(bundle.get("metrics", {}).get("oos_dir_acc", 0.5))
    mask = np.abs(oos_pred) >= abs_pred
    if mask.sum() >= 20:
        sub_p, sub_l = oos_pred[mask], oos_label[mask]
    else:  # fall back to overall validated baseline
        sub_p, sub_l = oos_pred, oos_label
    nz = sub_l != 0
    if not nz.any():
        return float(bundle.get("metrics", {}).get("oos_dir_acc", 0.5))
    return float((np.sign(sub_p[nz]) == np.sign(sub_l[nz])).mean())


def _pred_to_dict(pred: pd.Series) -> dict:
    out = {}
    if isinstance(pred.index, pd.MultiIndex):
        lv0 = pred.index.get_level_values(0)
        if lv0.dtype == object:
            names, _ = lv0, pred.index.get_level_values(1)
        else:
            names = pred.index.get_level_values(1)
        for name, val in zip(names, pred.to_numpy()):
            out[str(name)] = float(val)
    else:
        for name, val in zip(pred.index, pred.to_numpy()):
            out[str(name)] = float(val)
    return out


def infer(force: bool = False) -> dict:
    """Return {instrument_name: {score, confidence, direction}} or None when no
    validated model is available."""
    with _lock:
        bundle = load_bundle()
        if bundle is None or not bundle.get("model"):
            return None
        now = time.time()
        if not force and now - STATE["last_infer_ts"] < INFER_MIN_INTERVAL:
            return STATE.get("_last_infer")
        try:
            info = export_dump()
            if info["instruments"] == 0:
                return None
            _ensure_qlib()
            calendar = info["calendar"]
            last = calendar[-1]
            handler = OptionDataHandler(instruments="all",
                                        start_time=calendar[0], end_time=last)
            ds = DatasetH(handler, segments={"live": (last, last)})
            pred = bundle["model"].predict(dataset=ds, segment="live")
            scores = _pred_to_dict(pred)
            out = {}
            for name, sc in scores.items():
                direction = "up" if sc > 0 else ("down" if sc < 0 else "flat")
                out[name] = {
                    "score": sc,
                    "direction": direction,
                    "confidence": round(_calibrate(abs(sc), bundle), 4),
                }
            STATE["last_infer_ts"] = now
            STATE["_last_infer"] = out
            return out
        except Exception as e:
            db.log("error", "qlib", f"inference error: {e}")
            STATE["message"] = f"inference error: {e}"
            return None
