"""Dev-only smoke test: verifies the Qlib dump format + QlibDataLoader +
DataHandlerLP + LGBModel pipeline works in this environment.

Uses synthetic numbers purely as an engineering fixture — the application
itself never uses mock data.
"""
import shutil
import sys
from pathlib import Path

import os

os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qlib_dump  # noqa: E402

TMP = Path("/tmp/qlib_smoke")


def build_fixture():
    rng = np.random.default_rng(7)
    dates = pd.bdate_range("2025-01-01", periods=160).strftime("%Y-%m-%d").tolist()
    frames = {}
    for name in ["nifty24800ce", "nifty24800pe", "banknifty56400ce"]:
        close = 100 + np.cumsum(rng.normal(0, 1.2, len(dates)))
        frames[name] = pd.DataFrame(
            {
                "close": close,
                "volume": rng.integers(1_000, 90_000, len(dates)).astype(float),
                "oi": rng.integers(50_000, 500_000, len(dates)).astype(float),
                "chg_oi": rng.normal(0, 5000, len(dates)),
                "iv": 14 + rng.normal(0, 1, len(dates)),
                "bid": close - 0.2,
                "ask": close + 0.2,
                "uspot": 24000 + np.cumsum(rng.normal(0, 40, len(dates))),
                "moneyness": 0.99 + rng.normal(0, 0.002, len(dates)),
                "dte": np.clip(30 - np.arange(len(dates)) % 7, 1, 30).astype(float),
            },
            index=dates,
        )
    return dates, frames


def main():
    shutil.rmtree(TMP, ignore_errors=True)
    dates, frames = build_fixture()
    uri = qlib_dump.dump_dataset(TMP, frames, dates)
    print("dumped ->", uri)

    from qlib import init as qlib_init
    from qlib.data import D
    from qlib.data.dataset.handler import DataHandlerLP
    from qlib.data.dataset import DatasetH
    from qlib.contrib.model.gbdt import LGBModel

    qlib_init(provider_uri=str(uri), region="us")

    # 1) raw expression engine reads our dumped feature files
    df = D.features(["nifty24800ce"], ["$close", "Ref($close,-1)/$close-1",
                                       "Mean($close,5)/$close", "$oi", "$uspot"],
                    start_time="2025-02-01", end_time="2025-06-01")
    print("D.features ok, shape:", df.shape)
    assert df.shape[0] > 0 and not df.iloc[:, 0].isna().all(), "features empty"

    # 2) DataHandlerLP with custom feature/label config (Alpha-style)
    from qlib.contrib.data.handler import check_transform_proc

    class SmokeHandler(DataHandlerLP):
        def __init__(self, instruments, start_time, end_time,
                     fit_start_time=None, fit_end_time=None,
                     infer_processors=[], learn_processors=None, **kwargs):
            if learn_processors is None:
                learn_processors = [{"class": "DropnaLabel"}]
            infer_processors = check_transform_proc(
                infer_processors, fit_start_time, fit_end_time)
            learn_processors = check_transform_proc(
                learn_processors, fit_start_time, fit_end_time)
            data_loader = {
                "class": "QlibDataLoader",
                "kwargs": {
                    "config": {
                        "feature": [
                            "Ref($close,-1)/$close-1",
                            "Mean($close,5)/$close-1",
                            "Mean($close,10)/$close-1",
                            "Std($close,5)/$close",
                            "Ref($volume,-1)/($volume+1)",
                            "Ref($oi,-1)/($oi+1)",
                            "Ref($iv,-1)-$iv",
                            "($ask-$bid)/$close",
                            "Ref($uspot,-1)/$uspot-1",
                            "Mean($uspot,5)/$uspot-1",
                            "$moneyness",
                            "$dte",
                        ],
                        "label": ["Ref($close,-1)/$close-1"],
                    },
                    "freq": "day",
                },
            }
            super().__init__(instruments=instruments, start_time=start_time,
                             end_time=end_time, data_loader=data_loader,
                             infer_processors=infer_processors,
                             learn_processors=learn_processors, **kwargs)

    handler = SmokeHandler(
        instruments="all",
        start_time="2025-01-01",
        end_time="2025-06-30",
        fit_start_time="2025-01-01",
        fit_end_time="2025-05-15",
        infer_processors=[],
        learn_processors=[{"class": "DropnaLabel"}],
    )
    ds = DatasetH(
        handler,
        segments={
            "train": ("2025-01-01", "2025-05-15"),
            "valid": ("2025-05-16", "2025-05-31"),
            "test": ("2025-06-01", "2025-06-30"),
        },
    )
    print("DatasetH segments prepared")

    # 3) train + predict with real qlib LightGBM model
    model = LGBModel(
        loss="mse",
        col_sample=0.8,
        num_leaves=31,
        n_estimators=60,
        early_stopping_rounds=10,
        verbose_eval=20,
    )
    model.fit(dataset=ds)
    pred = model.predict(dataset=ds, segment="test")
    print("predictions:", len(pred))
    assert len(pred) > 0, "no predictions"

    # 4) metric: direction accuracy vs label on test rows
    y = ds.prepare("test", col_set="label", data_key="infer")
    joined = pd.concat([pred, y], axis=1).dropna()
    if joined.shape[1] >= 2:
        acc = (np.sign(joined.iloc[:, 0]) == np.sign(joined.iloc[:, 1])).mean()
        ic = joined.iloc[:, 0].corr(joined.iloc[:, 1], method="spearman")
        print(f"OOS dir-acc={acc:.3f} spearman-IC={ic:.3f}")
    print("SMOKE OK")


if __name__ == "__main__":
    main()
