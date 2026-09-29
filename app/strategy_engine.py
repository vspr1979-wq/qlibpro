"""Strategy engine — Normal Option Buying + Small-Premium Quick-Move.

Candidate scoring/direction comes exclusively from the Qlib model (scores and
calibrated confidence). The engine applies only the non-trading constraints
allowed by prompt1.txt: capital, maximum risk, lot size, liquidity (spread
economics via charges) and the user's configured limits. There is no
hand-written BUY/SELL scoring formula and no fixed market threshold.
"""
from collections import Counter

import database as db
import qlib_engine
import risk_engine


def _state_labels(symbol: str, rows: list, score_info: dict, plan: dict, entry: float) -> dict:
    """Descriptive, purely data-derived context for the analysis table."""
    stats = _window_stats(symbol)
    vol_now = rows.get("volume") or 0
    vol_avg = stats.get("vol_avg") or 0
    vol_ratio = round(vol_now / vol_avg, 2) if vol_avg else None
    oi_now = rows.get("oi")
    oi_prev = stats.get("oi_last_prev")
    oi_chg_display = rows.get("chg_oi")
    if oi_chg_display is None and oi_now is not None and oi_prev is not None:
        oi_chg_display = oi_now - oi_prev
    spread = rows.get("spread")
    entry = entry or rows.get("ltp") or 0
    spread_pct = round(spread / entry * 100, 2) if (spread is not None and entry) else None
    return {
        "momentum": "Up" if score_info.get("direction") == "up" else
                    ("Down" if score_info.get("direction") == "down" else "Flat"),
        "volume_state": f"{vol_ratio}x avg" if vol_ratio is not None else "—",
        "oi_state": f"{oi_chg_display:+,.0f}" if oi_chg_display is not None else "—",
        "liquidity": f"{spread_pct}% spread" if spread_pct is not None else "—",
        "activity": f"{rows.get('ltq'):,.0f}" if rows.get("ltq") is not None else "—",
    }


_stats_cache = {}


def _window_stats(symbol: str):
    """Per-symbol rolling context from stored history (data only)."""
    key = (symbol, db.now_ms() // 60_000)
    if key in _stats_cache:
        return _stats_cache[key]
    with db._lock:
        c = db._connect()
        rows = c.execute(
            "SELECT volume, oi FROM option_chain WHERE symbol=? ORDER BY ts DESC LIMIT 3000",
            (symbol,),
        ).fetchall()
    vols = [r["volume"] for r in rows if r["volume"] is not None]
    ois = [r["oi"] for r in rows if r["oi"] is not None]
    out = {
        "vol_avg": (sum(vols) / len(vols)) if vols else None,
        "oi_last_prev": ois[1] if len(ois) > 1 else None,
    }
    _stats_cache.clear()
    _stats_cache[key] = out
    return out


def evaluate_symbol(symbol: str, rows: list, spot, scores: dict,
                    model_meta: dict) -> dict:
    """Evaluate all ATM±range candidates for one symbol.

    Returns the full signal dict (signal_engine persists it).
    """
    s = db.get_settings()

    def f(key, d):
        try:
            return float(s.get(key, d))
        except (TypeError, ValueError):
            return d

    atm_range = int(f("atm_range", 15))
    band_min = f("small_premium_min", 10)
    band_max = f("small_premium_max", 50)
    min_rr = f("min_rr", 2.0)

    metrics = model_meta.get("metrics") or {}
    # validated out-of-sample baseline is the model's own confidence gate
    conf_gate = float(metrics.get("oos_dir_acc") or 0.5)
    up_q = {int(k): v for k, v in (metrics.get("up_quantiles") or {}).items()} or None
    down_q10 = metrics.get("down_q10")

    base = {
        "strategy": "", "expiry": "", "strike": None, "option_type": "",
        "instrument_key": "", "trading_symbol": "", "premium": None,
        "entry_min": None, "entry_max": None, "t1": None, "t2": None,
        "t3": None, "sl": None, "lots": None, "lot_size": None,
        "quantity": None, "capital": None, "max_risk": None, "gross": None,
        "charges": None, "net": None, "rr": None, "qlib_direction": "",
        "confidence": None, "premium_note": "",
    }

    if up_q is None or down_q10 is None:
        return _no_trade(symbol, base,
                         "Qlib model not validated yet — training/evaluation runs "
                         "automatically after enough live data is collected. Wait for a stronger setup.")

    # ---- window: ATM ± range ------------------------------------------------
    strikes = sorted({r["strike"] for r in rows if r.get("strike") is not None})
    if not strikes:
        return _no_trade(symbol, base, "No strikes in option chain")
    if spot:
        atm = min(strikes, key=lambda x: abs(x - spot))
        i = strikes.index(atm)
        window = set(strikes[max(0, i - atm_range): i + atm_range + 1])
    else:
        window = set(strikes)

    reject_reasons = Counter()
    evaluated = []

    for r in rows:
        if r.get("strike") not in window or r.get("option_type") not in ("CE", "PE"):
            continue
        key = r.get("instrument_key") or ""
        meta = db.contract_meta(key) if key else {}
        name = qlib_engine.inst_name(meta.get("trading_symbol") or r.get("trading_symbol"),
                                     key)
        info = (scores or {}).get(name) or (scores or {}).get(key)

        def reject(reason):
            reject_reasons[reason] += 1
            evaluated.append({
                "row": r, "meta": meta, "info": info, "plan": None,
                "status": "REJECTED", "reason": reason,
            })

        if info is None:
            reject("no Qlib score for contract")
            continue
        if info.get("direction") != "up":
            reject("model does not expect premium to rise")
            continue
        if info.get("confidence", 0) < conf_gate:
            reject(f"confidence {info.get('confidence', 0):.2f} below validated "
                   f"baseline {conf_gate:.2f}")
            continue

        entry = r.get("ask") or r.get("ltp")
        bid = r.get("bid")
        ask = r.get("ask")
        if not entry:
            reject("missing premium/bid-ask")
            continue
        lot = r.get("lot_size") or meta.get("lot_size") or 0
        plan = risk_engine.build_plan(entry, bid, ask, int(lot or 0),
                                      up_q, down_q10, s)
        if not plan.get("ok"):
            for fr in plan.get("fails") or ["risk check failed"]:
                reject_reasons[fr] += 1
            evaluated.append({
                "row": r, "meta": meta, "info": info, "plan": plan,
                "status": "REJECTED",
                "reason": "; ".join(plan.get("fails") or ["risk check failed"]),
            })
            continue

        evaluated.append({
            "row": r, "meta": meta, "info": info, "plan": plan,
            "status": "CANDIDATE", "reason": "",
        })

    # ---- strategy A: normal (premium outside the small band) ----------------
    def rank_key(e):
        p = e["plan"]
        return p["net"] / max(p["max_risk"], 0.01)

    normal_pool = [e for e in evaluated
                   if e["status"] == "CANDIDATE"
                   and not (band_min <= e["plan"]["entry"] <= band_max)]
    small_pool = [e for e in evaluated
                  if e["status"] == "CANDIDATE"
                  and band_min <= e["plan"]["entry"] <= band_max]

    best_normal = max(normal_pool, key=rank_key) if normal_pool else None
    best_small = max(small_pool, key=rank_key) if small_pool else None

    winner = None
    if best_normal and best_small:
        winner = best_normal if rank_key(best_normal) >= rank_key(best_small) else best_small
    else:
        winner = best_normal or best_small

    # ---- persist analysis rows ---------------------------------------------
    ts = db.now_ms()
    for e in evaluated:
        r, plan, info = e["row"], e["plan"], e["info"] or {}
        entry = (plan or {}).get("entry") or r.get("ask") or r.get("ltp")
        labels = _state_labels(symbol, r, info, plan or {}, entry)
        if e is winner:
            status = "SELECTED"
        elif e["status"] == "CANDIDATE":
            status = "CANDIDATE"
        else:
            status = f"REJECTED: {e['reason']}"
        db.upsert_candidate(
            symbol, r.get("strike"), r.get("option_type"),
            {
                "premium": entry,
                "qlib_score": info.get("score"),
                "confidence": info.get("confidence"),
                "direction": info.get("direction"),
                "momentum": labels["momentum"],
                "volume_state": labels["volume_state"],
                "oi_state": labels["oi_state"],
                "iv": r.get("iv"),
                "delta": r.get("delta"),
                "liquidity": labels["liquidity"],
                "activity": labels["activity"],
                "expected_move": round((plan or {}).get("t2", 0) - entry, 2)
                if plan and entry else None,
                "risk_reward": (plan or {}).get("rr"),
                "strategy_type": ("SMALL-PREMIUM QUICK-MOVE" if e is best_small
                                  else "NORMAL OPTION BUY") if plan else None,
                "status": status,
                "reason": e["reason"],
                "ts": ts,
            },
        )

    if winner is None:
        if not evaluated:
            reason = ("No analysable contracts in window (missing prices/greeks) — "
                      "wait for a stronger setup.")
        elif reject_reasons:
            top = ", ".join(f"{k} ({v})" for k, v in reject_reasons.most_common(3))
            reason = (f"Qlib direction/liquidity/risk evidence insufficient: {top}. "
                      "## Wait for a stronger setup.")
        else:
            reason = "Risk/reward below configured threshold. ## Wait for a stronger setup."
        out = dict(base)
        out.update(signal="NO TRADE", reason=reason, ts=ts)
        return out

    r = winner["row"]
    plan = winner["plan"]
    meta = winner["meta"]
    info = winner["info"]
    strat = ("SMALL-PREMIUM QUICK-MOVE" if winner is best_small
             else "NORMAL OPTION BUY")
    opt_type = r["option_type"]
    direction = "Bullish" if opt_type == "CE" else "Bearish"
    reason = (
        f"{'Bullish' if opt_type == 'CE' else 'Bearish'} underlying momentum and Qlib "
        f"confirmation (confidence {info.get('confidence', 0):.2f} ≥ validated baseline "
        f"{conf_gate:.2f}) + option activity/liquidity within limits; "
        f"risk/reward {plan['rr']} ≥ {min_rr} after capital & risk checks."
    )
    out = dict(base)
    out.update(
        signal=f"BUY {opt_type}",
        strategy=strat,
        expiry=r.get("expiry") or meta.get("expiry") or "",
        strike=r.get("strike"),
        option_type=opt_type,
        instrument_key=r.get("instrument_key") or "",
        trading_symbol=meta.get("trading_symbol") or r.get("trading_symbol") or "",
        premium=plan["entry"],
        entry_min=plan["entry_min"], entry_max=plan["entry_max"],
        t1=plan["t1"], t2=plan["t2"], t3=plan["t3"], sl=plan["sl"],
        lots=plan["lots"], lot_size=plan["lot_size"], quantity=plan["quantity"],
        capital=plan["capital"], max_risk=plan["max_risk"],
        gross=plan["gross"], charges=plan["charges"], net=plan["net"],
        rr=plan["rr"],
        qlib_direction=direction,
        confidence=info.get("confidence"),
        reason=reason,
        ts=ts,
    )
    return out


def _no_trade(symbol: str, base: dict, reason: str) -> dict:
    out = dict(base)
    out.update(signal="NO TRADE", reason=reason, ts=db.now_ms())
    return out
