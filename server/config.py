"""Deployment tunables for the least-resistance terminal.

Every threshold that could plausibly vary by venue or risk appetite lives here
rather than inside the analytics modules.  Distances are fractions of the mid
price, notional values are USD.
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"

SYMBOLS = ("BTCUSDT", "ETHUSDT")
DISPLAY = {"BTCUSDT": "BTC", "ETHUSDT": "ETH"}
FAPI_REST = "https://fapi.binance.com"
FSTREAM_WS = "wss://fstream.binance.com/stream?streams="
# Spot aggTrades are mirrored into the tape when the futures trade streams are
# unavailable; spot bookTicker supplies the basis used to rescale their prices.
SPOT_STREAM_WS = "wss://stream.binance.com:9443/stream?streams="

# ---------------------------------------------------------------------------
# market data
# ---------------------------------------------------------------------------
DEPTH_SNAPSHOT_LIMIT = 1000
DEPTH_STREAM_SPEED = "100ms"          # @depth@100ms diff stream
FUTURES_STREAMS = (
    "@depth@{speed}",
    "@aggTrade",
    "@markPrice@1s",
)
RESYNC_BACKOFF_S = 1.5
WS_IDLE_TIMEOUT_S = 20.0
REST_TIMEOUT_S = 8.0
TRADE_POLL_S = 6.0
REST_REFRESH_S = 45.0

# ---------------------------------------------------------------------------
# order book analytics
# ---------------------------------------------------------------------------
BAND_DISTANCES = (0.0025, 0.005, 0.01, 0.02, 0.03)
PROFILE_RANGE = 0.03                   # +/- 3% liquidity heatmap window
PROFILE_BINS = 96
BOOK_LEVELS_SHOWN = 28

# A price level is a wall when its resting notional clears both an absolute
# floor and a multiple of the median level inside +/-1.5%.  The median test keeps
# the definition self-calibrating across symbols and volatility regimes.
WALL_MIN_USD = {"BTCUSDT": 1_200_000.0, "ETHUSDT": 450_000.0}
WALL_MEDIAN_MULT = 9.0
WALL_SCAN_RANGE = 0.015
WALL_MAX_PER_SIDE = 5

# Absorbed volume that counts as full conviction for the wall/iceberg signal.
# Without this cap a single small absorption would saturate the component at +/-1.
WALL_ABSORB_FULL_USD = {"BTCUSDT": 2_000_000.0, "ETHUSDT": 600_000.0}

# Iceberg / hidden liquidity: an aggressed level that keeps refilling and whose
# traded notional over the window dwarfs the displayed size.
ICEBERG_TRADE_WINDOW_S = 120.0
ICEBERG_REFILL_WINDOW_S = 3.5
ICEBERG_MIN_RATIO = 1.6
ICEBERG_MIN_USD = {"BTCUSDT": 250_000.0, "ETHUSDT": 90_000.0}
ICEBERG_MAX_AGE_S = 900.0
SPOOF_MIN_USD = {"BTCUSDT": 1_500_000.0, "ETHUSDT": 600_000.0}
SPOOF_MIN_AGE_S = 4.0
SPOOF_RECENT_S = 300.0

# ---------------------------------------------------------------------------
# liquidations
# ---------------------------------------------------------------------------
LIQ_RETENTION_S = 24 * 3600.0
LIQ_MAP_BINS = 64
LIQ_MAP_SPAN = 0.04                     # actual liquidation histogram window
LIQ_RECENT_LIMIT = 18
LIQ_EVENT_FEED_MIN_USD = {"BTCUSDT": 120_000.0, "ETHUSDT": 50_000.0}
LIQ_EST_BIN_PCT = 0.001
LIQ_EST_MAX_DIST = 0.06
# Estimated forward liquidation map: for every volume-weighted price bucket in
# the used kline window, assume entries at each leverage band and project the
# isolated-margin liquidation price.  Weights approximate the leverage mix of
# retail perp positioning; maintenance margin is folded into the formula.
LEVERAGE_MIX = ((5, 0.10), (10, 0.20), (20, 0.22), (25, 0.18), (50, 0.20), (100, 0.10))
MAINTENANCE_MARGIN = 0.005
LIQ_MAP_KLINES = 288                   # 5m candles = 24h of entry distribution
LIQ_MAP_BIN_PCT = 0.001

# ---------------------------------------------------------------------------
# taker flow
# ---------------------------------------------------------------------------
FLOW_WINDOW_S = 300.0
CVD_BUCKET_S = 10.0
CVD_POINTS = 90                        # 15 minutes
LARGE_TRADE_USD = {"BTCUSDT": 400_000.0, "ETHUSDT": 150_000.0}
LARGE_TRADE_LIMIT = 24

# ---------------------------------------------------------------------------
# least-resistance model
# ---------------------------------------------------------------------------
# Each component returns a score in [-1, 1]; positive means up is cheaper.
#
# The primary thesis is a liquidity sweep: price is drawn toward the side with
# more executable liquidity because that is where stops, resting size and
# liquidation pools can absorb / trigger flow.  "sweep" weights resting depth,
# hidden iceberg size, the forward liquidation map and realized liquidation
# clusters above vs below mid.  The remaining components describe the path and
# the trigger, not the destination.
SIGNAL_WEIGHTS = {
    "sweep": 0.68,          # weighted liquidity pools above vs below (thesis)
    "flow": 0.14,           # taker aggression (5m)
    "absorption": 0.08,     # absorbed volume at walls / icebergs (trigger)
    "liquidations": 0.05,   # realized forced-order flow (trigger)
    "vacuum": 0.05,         # thin-liquidity corridors in the 1.5-3% band (path)
}
# Liquidity-sweep aggregation.  Every pool is decayed by distance so a wall 3%
# away cannot outweigh the depth that price can actually reach in one horizon.
# Each source is normalized by its own above/below total before mixing, so the
# forward liquidation map (a model with a much larger unit scale) cannot drown
# real book depth; these weights express trust, not dollar size.
SWEEP_DECAY_PCT = 0.012
SWEEP_GAIN = 2.5            # emphasises moderate pool asymmetry without clipping
SWEEP_SOURCE_WEIGHTS = {
    "book": 0.45,
    "iceberg": 0.15,
    "liq_model": 0.25,
    "liq_actual": 0.15,
}
SWEEP_FULL_USD = {"BTCUSDT": 8_000_000.0, "ETHUSDT": 3_000_000.0}
SWEEP_POOL_LIMIT = 12
# Realized forced-order flow over this window.  Short liquidations are forced
# buys (push up), long liquidations are forced sells (push down).
LIQ_FLOW_WINDOW_S = 300.0
VACUUM_LOW = 0.015
VACUUM_HIGH = 0.03

# A/B switch for the wall interpretation.  "barrier" treats a defended wall as
# a hurdle (bid wall supports, ask wall caps); "magnet" treats it as a target
# that pulls price toward it (bid wall pulls down, ask wall pulls up).  Both
# modes are logged in parallel; decide the default from Brier/hit-rate evidence.
WALL_MODES = ("barrier", "magnet")
WALL_MODE_FROM_ENV = "WALL_MODE" in os.environ
WALL_MODE = os.environ.get("WALL_MODE", "barrier").strip().lower()
if WALL_MODE not in WALL_MODES:
    raise ValueError(f"WALL_MODE must be one of {WALL_MODES}, got {WALL_MODE!r}")
PREDICTION_HORIZON_MIN = 15
PREDICTION_INTERVAL_S = 60.0
PREDICTION_DIRECTION_THRESHOLD = 0.07
PREDICTION_CONFIDENCE_GAIN = 2.4       # logistic steepness on the composite score
PREDICTION_LEDGER_LIMIT = 300
TARGET_MIN_PCT = 0.0008                # never advertise a target closer than this
TARGET_MAX_PCT = 0.012

# ---------------------------------------------------------------------------
# server
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 8765
# Snapshot generation also advances the prediction ledger. A slow background
# tick keeps that ledger moving when nobody has a page open, so accuracy and
# the wall-mode A/B do not depend on viewer traffic.
LEDGER_TICK_S = 2.0
PUSH_INTERVAL_MS = 900
CANDLE_REFRESH_S = 25.0
CANDLE_1M_LIMIT = 180
CANDLE_15M_LIMIT = 96
