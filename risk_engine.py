"""Risk / position engine — arithmetic & non-trading constraints only.

Entry/target/stop *levels* are derived from the Qlib model's out-of-sample
return quantiles (learned from data), never from fixed percentages. This
module only applies the user's configured capital / risk / lot limits and
computes position size, charges and risk/reward.
"""
import config
import database as db


def estimate_charges(buy_value: float, sell_value: float) -> float:
    c = config.CHARGES
    brokerage = 2.0 * c["brokerage_per_order"]
    stt = sell_value * c["stt_sell_pct"]
    exch = (buy_value + sell_value) * c["exchange_tx_pct"]
    sebi = (buy_value + sell_value) * c["sebi_pct"]
    stamp = buy_value * c["stamp_buy_pct"]
    gst = (brokerage + exch + sebi) * c["gst_pct"]
    return round(brokerage + stt + exch + sebi + stamp + gst, 2)


def build_plan(entry: float, bid, ask, lot_size: int, up_quantiles: dict,
               down_q10: float, s: dict) -> dict:
    """Build a full trade plan for one candidate.

    up_quantiles: {50: q, 75: q, 90: q} of OOS premium returns when the model
    predicted up; down_q10: OOS 10th-percentile return when model predicted
    down (stop basis). All learned from historical data by qlib_engine.
    """
    fails = []
    if not entry or entry <= 0:
        return {"ok": False, "fails": ["no entry price"]}
    if not lot_size or lot_size <= 0:
        return {"ok": False, "fails": ["no lot size from instruments master"]}

    t1 = entry * (1 + up_quantiles.get(50, 0))
    t2 = entry * (1 + up_quantiles.get(75, 0))
    t3 = entry * (1 + up_quantiles.get(90, 0))
    sl = entry * (1 + down_q10)

    if down_q10 >= 0 or sl <= 0:
        return {"ok": False, "fails": ["cannot derive a valid stop from model quantiles"]}
    risk_per_unit = entry - sl
    if risk_per_unit <= 0:
        return {"ok": False, "fails": ["stop not below entry"]}

    try:
        max_lots = int(float(s.get("max_lots") or 0))
        max_capital = float(s.get("max_capital") or 0)
        max_risk = float(s.get("max_risk") or 0)
        min_rr = float(s.get("min_rr") or 0)
    except (TypeError, ValueError):
        return {"ok": False, "fails": ["invalid settings"]}

    per_lot_cap = entry * lot_size
    per_lot_risk = risk_per_unit * lot_size
    by_cap = int(max_capital // per_lot_cap) if per_lot_cap > 0 else 0
    by_risk = int(max_risk // per_lot_risk) if per_lot_risk > 0 else 0
    lots = min(max_lots, by_cap, by_risk)

    if lots < 1:
        if by_cap < 1:
            fails.append("capital limit too small for 1 lot")
        if by_risk < 1:
            fails.append("risk limit too small for 1 lot")
        if max_lots < 1:
            fails.append("max lots < 1")
        if max_capital <= 0 or max_risk <= 0:
            fails.append("risk/capital limits not configured")
        return {"ok": False, "fails": fails}

    quantity = lots * lot_size
    capital = round(entry * quantity, 2)
    max_risk_used = round(risk_per_unit * quantity, 2)
    gross = round((t2 - entry) * quantity, 2)
    charges = estimate_charges(entry * quantity, t2 * quantity)
    net = round(gross - charges, 2)
    rr = round((t2 - entry) / risk_per_unit, 2)

    if rr < min_rr:
        fails.append(f"risk/reward {rr} below minimum {min_rr}")
    if net <= 0:
        fails.append("expected net profit at T2 not positive")
    if capital > max_capital + 1e-6:
        fails.append("capital exceeds maximum")

    entry_min = round(min(bid or entry, entry), 2)
    entry_max = round(max(ask or entry, entry), 2)

    return {
        "ok": not fails,
        "fails": fails,
        "entry": round(entry, 2),
        "entry_min": entry_min,
        "entry_max": entry_max,
        "t1": round(t1, 2), "t2": round(t2, 2), "t3": round(t3, 2),
        "sl": round(sl, 2),
        "lots": lots, "lot_size": lot_size, "quantity": quantity,
        "capital": capital,
        "max_risk": max_risk_used,
        "gross": gross, "charges": charges, "net": net, "rr": rr,
        "risk_per_unit": round(risk_per_unit, 4),
    }
