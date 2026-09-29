"""Engineering unit tests (development only — not part of the app runtime).

Run:  python tests/test_units.py
"""
import math
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config

TMP = Path(tempfile.mkdtemp(prefix="osig_test_"))
config.DATA_DIR = TMP
config.DB_PATH = TMP / "test.db"
config.QLIB_DATA_DIR = TMP / "qlib_data"
config.MODEL_PATH = TMP / "model.pkl"

import database as db  # noqa: E402
import qlib_dump  # noqa: E402
import risk_engine  # noqa: E402
from upstox_client import derive_underlying, norm_expiry, parse_instruments  # noqa: E402


def test_expiry_formats():
    assert norm_expiry("2026-10-30") == "2026-10-30"
    assert norm_expiry("30 Oct 26") == "2026-10-30"
    assert norm_expiry("30 Oct 2026") == "2026-10-30"
    assert norm_expiry("") == ""
    print("ok: expiry formats")


def test_parse_instruments():
    payload = [
        {"instrument_key": "NSE_FO|111", "trading_symbol": "NIFTY 24800 CE 30 OCT 26",
         "instrument_type": "CE", "strike_price": 24800, "expiry": "2026-10-30",
         "lot_size": 65, "segment": "NSE_FO", "exchange": "NSE", "name": "NIFTY",
         "underlying_symbol": "NIFTY"},
        {"instrument_key": "NSE_INDEX|NIFTY", "trading_symbol": "NIFTY 50",
         "instrument_type": "INDEX", "segment": "NSE_IDX", "exchange": "NSE"},
        {"instrument_key": "NSE_EQ|INE002A01018", "trading_symbol": "RELIANCE",
         "instrument_type": "EQ", "segment": "NSE_EQ", "lot_size": 1},
        {"trading_symbol": "missing key"},  # ignored
    ]
    rows = parse_instruments(payload)
    assert len(rows) == 3
    ce = rows[0]
    assert ce["option_type"] == "CE" and ce["strike"] == 24800
    assert ce["expiry"] == "2026-10-30" and ce["lot_size"] == 65
    assert ce["underlying"] == "NIFTY" and ce["short_name"] == "NIFTY"
    assert rows[1]["option_type"] == "" and rows[1]["underlying"] == "NIFTY"
    assert rows[2]["underlying"] == "RELIANCE"
    assert derive_underlying("BANKNIFTY 56400 CE 25 SEP 25") == "BANKNIFTY"
    print("ok: instruments parsing")


def test_charges_and_plan():
    s = dict(config.DEFAULT_SETTINGS)
    ch = risk_engine.estimate_charges(10000, 12000)
    assert ch > 0
    plan = risk_engine.build_plan(
        entry=100.0, bid=99.6, ask=100.4, lot_size=65,
        up_quantiles={50: 0.05, 75: 0.12, 90: 0.25}, down_q10=-0.06, s=s)
    assert plan["ok"], plan
    assert plan["sl"] < 100 < plan["t1"] < plan["t2"] < plan["t3"]
    assert plan["quantity"] == plan["lots"] * 65
    assert plan["rr"] >= 2.0
    assert plan["max_risk"] <= float(s["max_risk"])
    assert plan["capital"] <= float(s["max_capital"])
    # tiny premium vs tight risk limit -> cannot size 1 lot
    s2 = dict(s); s2["max_risk"] = "5"
    bad = risk_engine.build_plan(100.0, 99.6, 100.4, 65,
                                  {50: .05, 75: .12, 90: .25}, -0.06, s2)
    assert not bad["ok"] and bad["fails"]
    print("ok: risk plan math")


def test_qlib_dump_roundtrip():
    import numpy as np
    import pandas as pd
    dates = [f"2026-01-{d:02d}" for d in range(1, 21)]
    df = pd.DataFrame({"close": np.arange(20, dtype=float),
                       "oi": np.full(20, np.nan)}, index=dates)
    uri = TMP / "dump"
    qlib_dump.dump_dataset(uri, {"NIFTY 24800 CE": df}, dates)
    f = uri / "features" / "nifty_24800_ce" / "close.day.bin"
    assert f.exists()
    arr = np.fromfile(f, dtype="<f4")
    assert arr[0] == 0.0            # start calendar index
    np.testing.assert_allclose(arr[1:], np.arange(20, dtype=np.float32))
    assert (uri / "calendars" / "day.txt").read_text().strip().splitlines()[0] == "2026-01-01"
    inst = (uri / "instruments" / "all.txt").read_text()
    assert "nifty_24800_ce" in inst
    # all-NaN column is skipped entirely
    assert not (uri / "features" / "nifty_24800_ce" / "oi.day.bin").exists()
    print("ok: qlib dump roundtrip")


def test_strategy_engine_end_to_end():
    import database as _db
    _db.init_schema()
    _db.watchlist_add("NIFTY", "NSE_INDEX|NIFTY")
    _db.replace_instruments([
        {"instrument_key": "NSE_INDEX|NIFTY", "trading_symbol": "NIFTY",
         "short_name": "NIFTY", "underlying": "NIFTY", "expiry": "",
         "strike": None, "option_type": "", "lot_size": 0,
         "exchange": "NSE", "segment": "NSE_INDEX"},
        {"instrument_key": "NSE_FO|1", "trading_symbol": "NIFTY 24700 CE",
         "short_name": "NIFTY", "underlying": "NIFTY", "expiry": "2026-10-30",
         "strike": 24700, "option_type": "CE", "lot_size": 65,
         "exchange": "NSE", "segment": "NSE_FO"},
        {"instrument_key": "NSE_FO|2", "trading_symbol": "NIFTY 24700 PE",
         "short_name": "NIFTY", "underlying": "NIFTY", "expiry": "2026-10-30",
         "strike": 24700, "option_type": "PE", "lot_size": 65,
         "exchange": "NSE", "segment": "NSE_FO"},
        {"instrument_key": "NSE_FO|3", "trading_symbol": "NIFTY 25000 CE",
         "short_name": "NIFTY", "underlying": "NIFTY", "expiry": "2026-10-30",
         "strike": 25000, "option_type": "CE", "lot_size": 65,
         "exchange": "NSE", "segment": "NSE_FO"},
    ])
    ts = _db.now_ms()
    _db.watchlist_update_quote("NIFTY", 24685.0, 0.4, ts)
    _db.upsert_chain_rows("NIFTY", "2026-10-30", ts, "2026-09-29", [
        {"strike": 24700, "option_type": "CE", "instrument_key": "NSE_FO|1",
         "trading_symbol": "NIFTY 24700 CE", "ltp": 130, "bid": 129.6, "ask": 130.4,
         "spread": 0.8, "oi": 100000, "chg_oi": 5000, "volume": 50000, "iv": 14,
         "delta": 0.5, "gamma": 0, "theta": 0, "vega": 0, "ltq": 75, "lot_size": 65},
        {"strike": 24700, "option_type": "PE", "instrument_key": "NSE_FO|2",
         "trading_symbol": "NIFTY 24700 PE", "ltp": 90, "bid": 89.6, "ask": 90.4,
         "spread": 0.8, "oi": 90000, "chg_oi": -2000, "volume": 30000, "iv": 15,
         "delta": -0.45, "gamma": 0, "theta": 0, "vega": 0, "ltq": 60, "lot_size": 65},
        {"strike": 25000, "option_type": "CE", "instrument_key": "NSE_FO|3",
         "trading_symbol": "NIFTY 25000 CE", "ltp": 35, "bid": 34.7, "ask": 35.3,
         "spread": 0.6, "oi": 400000, "chg_oi": 20000, "volume": 200000, "iv": 13,
         "delta": 0.25, "gamma": 0, "theta": 0, "vega": 0, "ltq": 500, "lot_size": 65},
    ])

    import qlib_engine
    import strategy_engine
    model_meta = {"metrics": {
        "oos_dir_acc": 0.55,
        "up_quantiles": {"50": 0.05, "75": 0.12, "90": 0.25},
        "down_q10": -0.06,
        "passed": True,
    }}
    n1 = qlib_engine.inst_name("NIFTY 24700 CE", "NSE_FO|1")
    n2 = qlib_engine.inst_name("NIFTY 24700 PE", "NSE_FO|2")
    n3 = qlib_engine.inst_name("NIFTY 25000 CE", "NSE_FO|3")

    # confident model -> one of the candidates must be selected
    scores = {n1: {"score": 0.02, "direction": "up", "confidence": 0.70},
              n2: {"score": -0.01, "direction": "down", "confidence": 0.65},
              n3: {"score": 0.05, "direction": "up", "confidence": 0.72}}
    rows = _db.latest_chain("NIFTY")
    sig = strategy_engine.evaluate_symbol("NIFTY", rows, 24685.0, scores, model_meta)
    assert sig["signal"] in ("BUY CE", "BUY PE"), sig
    assert sig["quantity"] % sig["lot_size"] == 0
    assert sig["t1"] > sig["entry_max"] >= sig["entry_min"] > sig["sl"]
    assert sig["rr"] >= 2.0 and sig["net"] > 0
    assert "Qlib" in sig["reason"] or "qlib" in sig["reason"]

    # candidates persisted for the UI table (checked before later cycles overwrite)
    cands = _db.candidates_for("NIFTY")
    assert len(cands) == 3
    assert any(c["status"] == "SELECTED" for c in cands)
    assert any("REJECTED" in c["status"] for c in cands)

    # confidence below validated baseline -> NO TRADE
    weak = {k: dict(v, confidence=0.40) for k, v in scores.items()}
    sig2 = strategy_engine.evaluate_symbol("NIFTY", rows, 24685.0, weak, model_meta)
    assert sig2["signal"] == "NO TRADE"
    assert "confidence" in sig2["reason"]

    # no model yet -> NO TRADE
    sig3 = strategy_engine.evaluate_symbol("NIFTY", rows, 24685.0, scores,
                                            {"metrics": {}})
    assert sig3["signal"] == "NO TRADE"

    # a later all-rejected cycle must overwrite statuses (fresh evaluation)
    cands2 = _db.candidates_for("NIFTY")
    assert cands2 and all("REJECTED" in c["status"] for c in cands2)
    print("ok: strategy engine end-to-end (signal + NO TRADE paths)")


def main():
    test_expiry_formats()
    test_parse_instruments()
    test_charges_and_plan()
    test_qlib_dump_roundtrip()
    test_strategy_engine_end_to_end()
    print("ALL UNIT TESTS PASSED")
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
