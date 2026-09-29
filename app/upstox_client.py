"""Upstox API client — OAuth, market data, instruments download.

All data used by the application comes from the real Upstox API. There is no
mock/fallback data path anywhere in this module.
"""
import gzip
import json
import re
import threading
import time
from datetime import date, datetime, timedelta

import requests

import config
import database as db


class UpstoxError(Exception):
    pass


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def norm_expiry(v) -> str:
    """Normalize Upstox expiry values ('2026-10-30', '30 Oct 26', '30 Oct 2026') -> ISO."""
    if not v:
        return ""
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d %b %y", "%d %b %Y", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    m = re.search(r"(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else s


def derive_underlying(trading_symbol: str, name: str = "") -> str:
    if name:
        return name.strip().upper()
    t = (trading_symbol or "").strip().upper()
    if not t:
        return ""
    m = re.match(r"^([A-Z0-9&]+?)(?:\s+\d[\d.]*\s+(?:CE|PE))", t)  # "NIFTY 24800 CE 30 OCT 26"
    if m:
        return m.group(1)
    m = re.match(r"^([A-Z0-9&]+?)\s", t)
    return (m.group(1) if m else t)


def parse_instruments(payload) -> list:
    """Parse complete.json.gz payload into rows for the instruments table."""
    if isinstance(payload, dict):
        payload = payload.get("data") or payload.get("instruments") or []
    rows = []
    for it in payload or []:
        if not isinstance(it, dict):
            continue
        key = it.get("instrument_key")
        if not key:
            continue
        trading = str(it.get("trading_symbol") or "").strip()
        typ = str(it.get("instrument_type") or it.get("instrumentType") or "").upper()
        opt_type = typ if typ in ("CE", "PE") else ""
        name = str(it.get("name") or it.get("short_name") or "").strip()
        underlying = str(
            it.get("underlying_symbol")
            or it.get("underlying")
            or derive_underlying(trading, name)
        ).strip().upper()
        lot = _num(it.get("lot_size") or it.get("minimum_lot"), 0) or 0
        rows.append(
            {
                "instrument_key": key,
                "trading_symbol": trading,
                "short_name": name or derive_underlying(trading),
                "underlying": underlying,
                "underlying_key": str(it.get("underlying_key") or "").strip(),
                "expiry": norm_expiry(it.get("expiry") or it.get("expiry_date")),
                "strike": _num(it.get("strike_price") or it.get("strike")),
                "option_type": opt_type,
                "lot_size": int(lot),
                "exchange": it.get("exchange") or "",
                "segment": it.get("segment") or "",
            }
        )
    return rows


def _ts_for_date(d: str) -> int:
    """Candle dates are daily bars — anchor them at 15:30 IST of that day."""
    try:
        dt = datetime.strptime(str(d)[:10], "%Y-%m-%d")
        from datetime import timezone, timedelta
        ist = timezone(timedelta(hours=5, minutes=30))
        return int(dt.replace(hour=15, minute=30, tzinfo=ist).timestamp() * 1000)
    except ValueError:
        return db.now_ms()


class UpstoxClient:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(
            {"Accept": "application/json", "Content-Type": "application/json"}
        )
        self._lock = threading.Lock()

    # ------------------------------------------------------------- auth ----
    def auth_url(self, state: str) -> str:
        b = db.get_broker()
        if not b.get("api_key"):
            raise UpstoxError("API Key not configured — save credentials in Settings first")
        from urllib.parse import quote
        return (
            f"{config.UPSTOX_AUTH_URL}"
            f"?api_key={quote(b['api_key'])}"
            f"&redirect_uri={quote(b.get('redirect_url') or config.DEFAULT_SETTINGS['redirect_url'])}"
            f"&state={quote(state)}"
            f"&scope={quote(config.OAUTH_SCOPES)}"
        )

    def exchange_token(self, code: str, state: str) -> dict:
        b = db.get_broker()
        payload = {
            "api_key": b["api_key"],
            "client_secret": b.get("api_secret") or "",
            "code": code,
            "redirect_uri": b.get("redirect_url") or config.DEFAULT_SETTINGS["redirect_url"],
            "state": state,
        }
        r = self._session.post(config.UPSTOX_TOKEN_URL, json=payload, timeout=20)
        if r.status_code != 200:
            db.log("error", "oauth", f"token exchange failed: HTTP {r.status_code} {r.text[:300]}")
            raise UpstoxError(f"Token exchange failed (HTTP {r.status_code})")
        data = r.json().get("data") or r.json()
        token = data.get("access_token")
        if not token:
            db.log("error", "oauth", f"no access token in response: {str(r.text)[:300]}")
            raise UpstoxError("No access token in response")
        expires_in = int(_num(data.get("expires_in"), 3600) or 3600)
        db.save_broker(
            access_token=token,
            token_expiry=db.now_ms() + max(60, expires_in - 60) * 1000,
            connected=1,
        )
        db.log("info", "oauth", "access token saved; connected")
        return data

    def disconnect(self) -> None:
        db.save_broker(access_token="", token_expiry=0, connected=0)
        db.log("info", "oauth", "disconnected by user")

    # ------------------------------------------------------------ http -----
    def _headers(self):
        b = db.get_broker()
        return {"Authorization": f"Bearer {b.get('access_token') or ''}"}

    def _request(self, method, url, params=None, json_body=None, retries=2):
        if not db.token_valid():
            raise UpstoxError("Not connected (missing/expired token)")
        last_err = None
        for attempt in range(retries + 1):
            try:
                with self._lock:
                    r = self._session.request(
                        method, url, params=params, json=json_body,
                        headers=self._headers(), timeout=20,
                    )
            except requests.RequestException as e:
                last_err = f"network error: {e}"
                time.sleep(0.8 * (attempt + 1))
                continue
            if r.status_code == 401:
                db.save_broker(connected=0)
                db.log("error", "api", "401 unauthorized — token expired, reconnect from Settings")
                raise UpstoxError("Unauthorized (token expired)")
            if r.status_code == 429:
                wait = 2.0 * (attempt + 1)
                db.log("warn", "api", f"429 rate-limited — backing off {wait}s")
                time.sleep(wait)
                last_err = "429 rate limited"
                continue
            if r.status_code >= 500:
                last_err = f"HTTP {r.status_code}"
                time.sleep(0.8)
                continue
            if r.status_code != 200:
                raise UpstoxError(f"HTTP {r.status_code}: {r.text[:300]}")
            try:
                body = r.json()
            except ValueError:
                raise UpstoxError("invalid JSON from Upstox")
            if str(body.get("status", "success")).lower() not in ("success", "ok", ""):
                raise UpstoxError(f"API error: {str(body)[:300]}")
            return body
        raise UpstoxError(last_err or "request failed")

    # ----------------------------------------------------- market status ----
    def market_status(self) -> dict:
        for url in (f"{config.UPSTOX_API}/market/status",
                    f"{config.UPSTOX_API}/market-status"):
            try:
                body = self._request("GET", url)
                return body.get("data") or body
            except UpstoxError:
                continue
        return {}

    # ---------------------------------------------------------- quotes ------
    def quotes(self, keys: list) -> dict:
        if not keys:
            return {}
        body = self._request(
            "GET", config.UPSTOX_QUOTES_URL,
            params={"instrument_key": ",".join(keys)},
        )
        out = {}
        for k, v in (body.get("data") or {}).items():
            ltp = _num(v.get("last_price"))
            net = _num(v.get("net_change"))
            cp = _num(v.get("cp")) or (
                (ltp - net) if (ltp is not None and net is not None) else None
            )
            pct = None
            if ltp is not None and cp:
                pct = (net / cp * 100.0) if net is not None else ((ltp - cp) / cp * 100.0)
            out[k] = {
                "ltp": ltp, "net_change": net, "pct": pct,
                "ltq": _num(v.get("ltq")), "volume": _num(v.get("volume")),
                "oi": _num(v.get("oi")), "cp": cp,
            }
        return out

    # ----------------------------------------------------- option chain -----
    def option_chain(self, symbol: str, key: str, expiry_iso: str):
        """Return (spot, pcr, rows[]) for one expiry via /v2/option/chain."""
        params = {"instrument_key": key}
        if expiry_iso:
            params["expiry_date"] = expiry_iso
        body = self._request("GET", f"{config.UPSTOX_API}/option/chain", params=params)
        data = body.get("data") or []
        spot = pcr = None
        rows = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            spot = spot if spot is not None else _num(entry.get("underlying_spot_price"))
            pcr = pcr if pcr is not None else _num(entry.get("pcr"))
            strike = _num(entry.get("strike_price"))
            exp = norm_expiry(entry.get("expiry"))
            for side, typ in (("call_options", "CE"), ("put_options", "PE")):
                o = entry.get(side) or {}
                md = o.get("market_data") or {}
                g = o.get("option_greeks") or {}
                ltp = _num(md.get("ltp"))
                bid = _num(md.get("bid_price"))
                ask = _num(md.get("ask_price"))
                oi = _num(md.get("oi"))
                prev_oi = _num(md.get("prev_oi"))
                spread = None
                if bid is not None and ask is not None:
                    spread = round(ask - bid, 4)
                rows.append(
                    {
                        "strike": strike,
                        "option_type": typ,
                        "expiry": exp or expiry_iso,
                        "instrument_key": o.get("instrument_key") or "",
                        "trading_symbol": "",
                        "ltp": ltp, "bid": bid, "ask": ask, "spread": spread,
                        "volume": _num(md.get("volume")),
                        "oi": oi,
                        "chg_oi": (oi - prev_oi) if (oi is not None and prev_oi is not None) else None,
                        "iv": _num(g.get("iv")),
                        "delta": _num(g.get("delta")),
                        "gamma": _num(g.get("gamma")),
                        "theta": _num(g.get("theta")),
                        "vega": _num(g.get("vega")),
                        "ltq": None,
                        "lot_size": 0,
                    }
                )
        return spot, pcr, rows

    def option_greeks(self, keys: list) -> dict:
        """Batch greeks/ltq via v3 endpoint (chunked)."""
        out = {}
        for i in range(0, len(keys), 50):
            chunk = keys[i:i + 50]
            try:
                body = self._request(
                    "GET", f"{config.UPSTOX_API}/market-quote/option-greek",
                    params={"instrument_key": ",".join(chunk)},
                )
            except UpstoxError:
                continue
            for k, v in (body.get("data") or {}).items():
                ik = v.get("instrument_token") or v.get("instrument_key") or k
                out[ik] = {
                    "ltq": _num(v.get("ltq")),
                    "iv": _num(v.get("iv")),
                    "delta": _num(v.get("delta")),
                    "gamma": _num(v.get("gamma")),
                    "theta": _num(v.get("theta")),
                    "vega": _num(v.get("vega")),
                    "oi": _num(v.get("oi")),
                    "volume": _num(v.get("volume")),
                    "ltp": _num(v.get("last_price")),
                }
            time.sleep(config.API_DELAY_SECONDS)
        return out

    # -------------------------------------------------- historical candles ---
    def historical_candles(self, key: str, days: int = config.HISTORY_BACKFILL_DAYS):
        frm = (date.today() - timedelta(days=days)).isoformat()
        to = date.today().isoformat()
        body = self._request(
            "GET",
            f"{config.UPSTOX_CANDLES_URL}/{key}/day/{to}/{frm}",
        )
        candles = ((body.get("data") or {}).get("candles")) or []
        out = []
        for c in candles:
            if not c or len(c) < 6:
                continue
            d = str(c[0])[:10]
            out.append({
                "date": d,
                "ts": _ts_for_date(d),
                "open": _num(c[1]), "high": _num(c[2]), "low": _num(c[3]),
                "close": _num(c[4]), "volume": _num(c[5]),
            })
        return out

    # ----------------------------------------------------- instruments ------
    def download_instruments(self) -> int:
        db.log("info", "instr", "downloading instruments file from Upstox …")
        try:
            with self._session.get(config.INSTRUMENTS_URL, stream=True, timeout=120) as r:
                if r.status_code != 200:
                    raise UpstoxError(f"instruments HTTP {r.status_code}")
                raw = b"".join(r.iter_content(1 << 16))
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            with open(config.INSTRUMENTS_CACHE, "wb") as f:
                f.write(raw)
        except requests.RequestException as e:
            db.log("error", "instr", f"instrument download failed: {e}")
            raise UpstoxError(f"instrument download failed: {e}")
        return self.load_instruments_from_cache()

    def load_instruments_from_cache(self) -> int:
        try:
            with gzip.open(config.INSTRUMENTS_CACHE, "rb") as f:
                payload = json.loads(f.read().decode("utf-8", errors="replace"))
        except FileNotFoundError:
            raise UpstoxError("instruments cache not found — download first")
        except (OSError, ValueError) as e:
            db.log("error", "instr", f"instruments parse failed: {e}")
            raise UpstoxError(f"instruments parse failed: {e}")
        rows = parse_instruments(payload)
        if not rows:
            raise UpstoxError("instruments file parsed to 0 rows")
        n = db.replace_instruments(rows)
        db.log("info", "instr", f"instruments stored in SQLite: {n} rows")
        return n
