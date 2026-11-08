"""Deployment tunables for the least-resistance terminal.

Every threshold that could plausibly vary by venue or risk appetite lives here
rather than inside the analytics modules.  Distances are fractions of the mid
price, notional values are USD.
"""

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
SIGNAL_WEIGHTS = {
    "book": 0.30,       # resting liquidity asymmetry inside +/-1%
    "walls": 0.24,      # absorbed volume at walls / icebergs (not resting size)
    "liquidations": 0.22,  # liquidation magnets / fuel above vs below
    "flow": 0.14,       # taker aggression (5m)
    "vacuum": 0.10,     # thin-liquidity corridors in the 1.5-3% band
}
# The three book-derived signals deliberately read different price corridors so
# they do not all count the same resting depth: book inside +/-1%, wall/iceberg
# absorption at the levels themselves, vacuum outside the wall scan range.
VACUUM_LOW = 0.015
VACUUM_HIGH = 0.03
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
PUSH_INTERVAL_MS = 900
CANDLE_REFRESH_S = 25.0
CANDLE_1M_LIMIT = 180
CANDLE_15M_LIMIT = 96
