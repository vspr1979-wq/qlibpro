"""Dump collected market data from SQLite into Microsoft Qlib's binary format.

Qlib file layout (matches qlib.data.storage.FileFeatureStorage / FileCalendarStorage /
FileInstrumentStorage used by pyqlib 0.9.x):

    <provider_uri>/calendars/day.txt              # one date per line, sorted
    <provider_uri>/instruments/all.txt             # name<TAB>start<TAB>end
    <provider_uri>/features/<instrument>/<field>.day.bin
        float32 little-endian: [start_calendar_index, value0, value1, ...]

This is a genuine Qlib data import: after dumping, qlib.init() + QlibDataLoader
+ DataHandlerLP + LGBModel operate on these files exactly like on any other
qlib dataset.
"""
from pathlib import Path
from typing import Dict, Iterable, List

import numpy as np
import pandas as pd

FLOAT = "<f4"


def sanitize_instrument(name: str) -> str:
    """Qlib instrument names become directory names — keep them filesystem-safe."""
    keep = "".join(ch if (ch.isalnum() or ch in "_-.") else "_" for ch in str(name))
    return keep.strip("_").lower() or "unknown"


def write_feature(path: Path, values: Iterable[float], start_index: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(list(values) if not isinstance(values, np.ndarray) else values,
                     dtype=np.float32)
    with path.open("wb") as fp:
        np.concatenate(([np.float32(start_index)], arr)).astype(FLOAT).tofile(fp)


def dump_dataset(
    provider_uri: Path,
    frames: Dict[str, pd.DataFrame],
    calendar: List[str],
    freq: str = "day",
) -> Path:
    """frames: instrument -> DataFrame indexed by date (YYYY-MM-DD) with float columns.

    Every frame is reindexed onto `calendar`; missing values become NaN.
    Returns the provider_uri path.
    """
    provider_uri = Path(provider_uri)
    cal_dir = provider_uri / "calendars"
    inst_dir = provider_uri / "instruments"
    feat_dir = provider_uri / "features"
    for d in (cal_dir, inst_dir, feat_dir):
        d.mkdir(parents=True, exist_ok=True)

    calendar = sorted({str(d)[:10] for d in calendar})
    cal_index = {d: i for i, d in enumerate(calendar)}
    (cal_dir / f"{freq}.txt").write_text("\n".join(calendar) + "\n", encoding="utf-8")

    # instruments/all.txt: name<TAB>start<TAB>end (standard qlib format)
    lines = []
    for name in sorted(frames.keys()):
        s = sanitize_instrument(name)
        dates = sorted(str(d)[:10] for d in frames[name].index)
        start = dates[0] if dates else calendar[0]
        end = dates[-1] if dates else calendar[-1]
        lines.append(f"{s}\t{start}\t{end}")
    (inst_dir / "all.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    for name, df in frames.items():
        inst = sanitize_instrument(name)
        df = df.copy()
        df.index = [str(d)[:10] for d in df.index]
        df = df[~df.index.duplicated(keep="last")].sort_index()
        df = df.reindex(calendar)
        for col in df.columns:
            series = pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=np.float32)
            # trim leading/trailing all-NaN to keep files small
            valid = ~np.isnan(series)
            if not valid.any():
                continue
            first = int(np.argmax(valid))
            last = int(len(valid) - 1 - np.argmax(valid[::-1]))
            start_pos = cal_index[calendar[first]]
            write_feature(feat_dir / inst / f"{col}.{freq}.bin",
                          series[first:last + 1], start_pos)
    return provider_uri
