"""Application configuration — operational constants only.

No trading rules, thresholds or scoring formulas live here. Trading decisions
come from Qlib model output; this file only holds paths, endpoints, timing and
non-trading constraints that are not user-configurable (fee estimates).
"""
import os
from pathlib import Path

# pyqlib records experiments through MLflow; allow its default file store.
os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "optionsignal.db"
QLIB_DATA_DIR = DATA_DIR / "qlib_data"
MODEL_PATH = DATA_DIR / "qlib_model.pkl"
INSTRUMENTS_CACHE = DATA_DIR / "instruments_complete.json.gz"

APP_NAME = "OptionSignal"
VERSION = "1.0.0"
HOST = os.environ.get("OSIG_HOST", "127.0.0.1")  # set OSIG_HOST=0.0.0.0 to expose on LAN/preview
PORT = int(os.environ.get("OSIG_PORT", "5000"))

# ---------------------------------------------------------------- Upstox ----
UPSTOX_API = "https://api.upstox.com/v2"
UPSTOX_AUTH_URL = f"{UPSTOX_API}/login/auth/authorize"
UPSTOX_TOKEN_URL = f"{UPSTOX_API}/login/auth/token"
UPSTOX_MARKET_STATUS_URL = f"{UPSTOX_API}/market/status"
UPSTOX_QUOTES_URL = f"{UPSTOX_API}/market-quote/quotes"
UPSTOX_OPTION_CHAIN_URL = f"{UPSTOX_API}/market-quote/option-chain"
UPSTOX_CANDLES_URL = f"{UPSTOX_API}/historical-candle"
INSTRUMENTS_URL = (
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz"
)
OAUTH_SCOPES = "order trade"

# --------------------------------------------------------- timing (ops) -----
# Background collection cadence — operational, not a trading parameter.
COLLECTOR_CYCLE_SECONDS = 3.0
API_DELAY_SECONDS = 0.35          # polite delay between Upstox calls
QUOTE_STALE_AFTER_S = 60          # suppress signals when ticks are older
TRAINER_INTERVAL_S = 300          # how often trainer checks whether work is due
TRAINER_DAILY_AT = "16:00"        # scheduled retrain time (IST)
MIN_TRAIN_ROWS = 300              # minimum option-day rows before first training
HISTORY_BACKFILL_DAYS = 730       # daily candles to request per instrument

# ------------------------------------------------------- charge estimates ----
# Estimated round-trip charges for an option BUY then exit SELL.
# These are fee estimates (not trading rules) — adjust per current Upstox rates.
CHARGES = {
    "brokerage_per_order": 20.0,   # ₹ per executed order (each leg)
    "stt_sell_pct": 0.0010,        # STT on sell-side premium (options)
    "exchange_tx_pct": 0.00035,    # exchange transaction charge
    "sebi_pct": 0.000001,          # SEBI turnover fee
    "stamp_buy_pct": 0.00003,      # stamp duty on buy
    "gst_pct": 0.18,               # GST on (brokerage + exch + sebi)
}

# ------------------------------------------------------------ defaults -------
DEFAULT_SETTINGS = {
    "atm_range": "15",
    "small_premium_min": "10",
    "small_premium_max": "50",
    "max_risk": "5000",
    "max_capital": "100000",
    "min_rr": "2.0",
    "max_lots": "5",
    "redirect_url": f"http://127.0.0.1:{PORT}/upstox/callback",
}
