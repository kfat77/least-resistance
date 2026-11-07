"""Microstructure analytics: depth pressure, walls, icebergs, liquidations, flow.

Everything here is pure or self-contained: the feed layer pushes updates into
:class:`TradeTape` / :class:`LiquidationBook`, and the snapshot builder reads
them.  Scores are in ``[-1, 1]``; positive always means "up is the cheaper path".
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass

from . import config
from .book import OrderBook


# ---------------------------------------------------------------------------
# trade tape
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class Trade:
    ts: float
    price: float
    qty: float
    usd: float
    side: str          # aggressor side: "buy" or "sell"


class TradeTape:
    """Rolling aggressor-flow window with per-price attribution."""

    def __init__(self, symbol: str, large_usd: float) -> None:
        self.symbol = symbol
        self.large_usd = large_usd
        self.trades: deque[Trade] = deque()
        self.by_price: dict[tuple[str, float], deque[tuple[float, float]]] = {}
        self.large: deque[Trade] = deque(maxlen=config.LARGE_TRADE_LIMIT)
        self.cvd_buckets: dict[int, float] = {}
        self._retention_s = max(config.CVD_POINTS * config.CVD_BUCKET_S, 900.0)

    def add(self, ts: float, price: float, qty: float, is_buyer_maker: bool) -> None:
        side = "sell" if is_buyer_maker else "buy"
        usd = price * qty
        trade = Trade(ts, price, qty, usd, side)
        self.trades.append(trade)
        book_side = "bid" if side == "sell" else "ask"
        key = (book_side, price)
        self.by_price.setdefault(key, deque()).append((ts, usd))
        bucket = int(ts // config.CVD_BUCKET_S) * int(config.CVD_BUCKET_S)
        self.cvd_buckets[bucket] = self.cvd_buckets.get(bucket, 0.0) + (
            usd if side == "buy" else -usd
        )
        if usd >= self.large_usd:
            self.large.append(trade)

    def prune(self, now: float) -> None:
        cutoff = now - self._retention_s
        while self.trades and self.trades[0].ts < cutoff:
            self.trades.popleft()
        empty = []
        for key, entries in self.by_price.items():
            while entries and entries[0][0] < cutoff:
                entries.popleft()
            if not entries:
                empty.append(key)
        for key in empty:
            del self.by_price[key]
        bucket_floor = int((now - config.CVD_POINTS * config.CVD_BUCKET_S - 120) // config.CVD_BUCKET_S) * int(config.CVD_BUCKET_S)
        for bucket in [b for b in self.cvd_buckets if b < bucket_floor]:
            del self.cvd_buckets[bucket]

    def traded_usd(
        self, book_side: str, price: float, now: float, window: float
    ) -> float:
        """Aggressor notional that hit a specific resting price within window."""
        entries = self.by_price.get((book_side, price))
        if not entries:
            return 0.0
        cutoff = now - window
        total = 0.0
        for ts, usd in reversed(entries):
            if ts < cutoff:
                break
            total += usd
        return total

    def flow(self, now: float, window: float = config.FLOW_WINDOW_S) -> dict:
        cutoff = now - window
        buy = sell = 0.0
        count = 0
        for trade in reversed(self.trades):
            if trade.ts < cutoff:
                break
            count += 1
            if trade.side == "buy":
                buy += trade.usd
            else:
                sell += trade.usd
        total = buy + sell
        delta = buy - sell
        return {
            "buy_usd": buy,
            "sell_usd": sell,
            "delta_usd": delta,
            "ratio": delta / total if total > 0 else 0.0,
            "trades": count,
            "window_s": int(window),
            "cvd": self.cvd_series(now),
            "large": [
                {
                    "ts": int(t.ts * 1000),
                    "side": t.side,
                    "price": t.price,
                    "qty": t.qty,
                    "usd": t.usd,
                }
                for t in reversed(self.large)
            ],
        }

    def cvd_series(self, now: float) -> list[list[float]]:
        bucket_s = int(config.CVD_BUCKET_S)
        current = int(now // bucket_s) * bucket_s
        window_start = current - (config.CVD_POINTS - 1) * bucket_s
        active = [b for b in self.cvd_buckets if window_start <= b <= current]
        if not active:
            return []
        # Trim the leading empty buckets that predate the first observed trade.
        start = max(window_start, min(active))
        points: list[list[float]] = []
        cumulative = 0.0
        bucket = start
        while bucket <= current:
            cumulative += self.cvd_buckets.get(bucket, 0.0)
            points.append([bucket * 1000, round(cumulative, 2)])
            bucket += bucket_s
        return points


# ---------------------------------------------------------------------------
# liquidations
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class LiqEvent:
    ts: float
    side: str          # "long" (forced sell) or "short" (forced buy)
    price: float
    qty: float
    usd: float


class LiquidationBook:
    """Rolling 24h forced-order tape plus aggregate views."""

    def __init__(self, retention_s: float = config.LIQ_RETENTION_S) -> None:
        self.events: deque[LiqEvent] = deque()
        self.retention_s = retention_s

    def add(self, ts: float, side: str, price: float, qty: float) -> None:
        usd = price * qty
        if usd <= 0:
            return
        self.events.append(LiqEvent(ts, side, price, qty, usd))

    def load(self, rows: list[dict]) -> None:
        for row in rows:
            try:
                self.add(float(row["ts"]), str(row["side"]), float(row["price"]), float(row["qty"]))
            except (KeyError, TypeError, ValueError):
                continue
        self.events = deque(sorted(self.events, key=lambda e: e.ts))

    def prune(self, now: float) -> None:
        cutoff = now - self.retention_s
        while self.events and self.events[0].ts < cutoff:
            self.events.popleft()

    def summary(self, now: float, mid: float) -> dict:
        long_usd = short_usd = 0.0
        for event in self.events:
            if event.side == "long":
                long_usd += event.usd
            else:
                short_usd += event.usd
        recent = [
            {
                "ts": int(e.ts * 1000),
                "side": e.side,
                "price": e.price,
                "qty": e.qty,
                "usd": e.usd,
            }
            for e in list(self.events)[-config.LIQ_RECENT_LIMIT:][::-1]
        ]
        return {
            "window_h": int(self.retention_s / 3600),
            "total_long_usd": long_usd,
            "total_short_usd": short_usd,
            "count": len(self.events),
            "recent": recent,
            "map": self._histogram(mid),
            "clusters": self._clusters(mid, long_usd, short_usd),
        }

    def _histogram(self, mid: float) -> list[dict]:
        if mid <= 0:
            return []
        span = config.LIQ_MAP_SPAN
        bins = config.LIQ_MAP_BINS
        width = mid * 2 * span / bins
        low = mid * (1 - span)
        buckets = [[0.0, 0.0] for _ in range(bins)]
        for event in self.events:
            idx = int((event.price - low) / width)
            if 0 <= idx < bins:
                buckets[idx][0 if event.side == "long" else 1] += event.usd
        return [
            {
                "price": round(low + (i + 0.5) * width, 2),
                "long_usd": round(b[0], 2),
                "short_usd": round(b[1], 2),
            }
            for i, b in enumerate(buckets)
        ]

    def _clusters(self, mid: float, long_total: float, short_total: float) -> list[dict]:
        """Largest actual liquidation price clusters within the visible window."""
        if mid <= 0:
            return []
        span = config.LIQ_MAP_SPAN
        bins = config.LIQ_MAP_BINS
        width = mid * 2 * span / bins
        low = mid * (1 - span)
        buckets: dict[tuple[int, str], float] = {}
        for event in self.events:
            idx = int((event.price - low) / width)
            if 0 <= idx < bins:
                key = (idx, event.side)
                buckets[key] = buckets.get(key, 0.0) + event.usd
        clusters = []
        for (idx, side), usd in sorted(buckets.items(), key=lambda kv: kv[1], reverse=True)[:8]:
            price = low + (idx + 0.5) * width
            clusters.append(
                {
                    "price": round(price, 2),
                    "side": side,
                    "usd": round(usd, 2),
                    "dist_pct": round((price - mid) / mid * 100, 3),
                    "estimated": False,
                }
            )
        return clusters


def estimate_liquidation_map(candles: list[list], mid: float) -> list[dict]:
    """Project forward liquidation prices from a volume-weighted entry profile.

    Each kline's typical price is treated as an entry bucket; the configured
    leverage mix projects where isolated-margin positions opened there would be
    liquidated.  The result is a relative model estimate, not exchange data.
    """
    if mid <= 0 or not candles:
        return []
    bins: dict[int, list[float]] = {}
    width = mid * config.LIQ_EST_BIN_PCT
    max_dist = config.LIQ_EST_MAX_DIST
    for candle in candles:
        try:
            high, low, close, volume = (
                float(candle[2]),
                float(candle[3]),
                float(candle[4]),
                float(candle[5]),
            )
        except (IndexError, TypeError, ValueError):
            continue
        if volume <= 0:
            continue
        entry = (high + low + close) / 3.0
        notional = entry * volume
        for leverage, weight in config.LEVERAGE_MIX:
            maintenance = config.MAINTENANCE_MARGIN
            long_liq = entry * (1.0 - 1.0 / leverage + maintenance)
            short_liq = entry * (1.0 + 1.0 / leverage - maintenance)
            for price, side_idx in ((long_liq, 0), (short_liq, 1)):
                if abs(price - mid) / mid > max_dist:
                    continue
                idx = int(round(price / width))
                slot = bins.setdefault(idx, [0.0, 0.0])
                slot[side_idx] += notional * weight
    result = []
    for idx, (long_usd, short_usd) in sorted(bins.items()):
        price = idx * width
        if abs(price - mid) / mid > max_dist:
            continue
        result.append(
            {
                "price": round(price, 2),
                "long_usd": round(long_usd, 2),
                "short_usd": round(short_usd, 2),
            }
        )
    return result


# ---------------------------------------------------------------------------
# depth views
# ---------------------------------------------------------------------------
def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    n = len(ordered)
    return ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0


def band_metrics(book: OrderBook) -> dict:
    mid = book.mid()
    if mid is None:
        return {"mid": 0.0, "bands": [], "imbalance_1pct": 0.0, "spread_bps": 0.0}
    bands = []
    for dist in config.BAND_DISTANCES:
        bid_usd = book.notional_within("bid", dist)
        ask_usd = book.notional_within("ask", dist)
        total = bid_usd + ask_usd
        bands.append(
            {
                "dist_pct": round(dist * 100, 3),
                "bid_usd": bid_usd,
                "ask_usd": ask_usd,
                "imbalance": (bid_usd - ask_usd) / total if total > 0 else 0.0,
            }
        )
    one_pct = next((b for b in bands if abs(b["dist_pct"] - 1.0) < 1e-6), bands[0])
    return {
        "mid": mid,
        "spread_bps": round(book.spread_bps(), 4),
        "bands": bands,
        "imbalance_1pct": one_pct["imbalance"],
        "bid_depth_usd": sum(b["bid_usd"] for b in bands),
        "ask_depth_usd": sum(b["ask_usd"] for b in bands),
    }


def ladder(book: OrderBook, limit: int = config.BOOK_LEVELS_SHOWN) -> dict:
    mid = book.mid() or 0.0

    def rows(side: str) -> list[dict]:
        out = []
        cumulative = 0.0
        for price, qty in book.top(side, limit):
            usd = price * qty
            cumulative += usd
            out.append(
                {
                    "price": price,
                    "qty": qty,
                    "usd": usd,
                    "cum_usd": cumulative,
                    "dist_pct": (price - mid) / mid * 100 if mid else 0.0,
                }
            )
        return out

    return {"bids": rows("bid"), "asks": rows("ask")}


def wall_metrics(
    book: OrderBook, tape: TradeTape, symbol: str, now: float
) -> dict:
    mid = book.mid()
    if mid is None:
        return {"walls": [], "tracked": [], "nearest_bid": None, "nearest_ask": None}
    low = mid * (1 - config.WALL_SCAN_RANGE)
    high = mid * (1 + config.WALL_SCAN_RANGE)
    walls: list[dict] = []
    tracked: list[dict] = []
    for side in ("bid", "ask"):
        levels = book.bids if side == "bid" else book.asks
        notionals = [price * qty for price, qty in levels.items() if low <= price <= high]
        median = _median(notionals)
        threshold = max(config.WALL_MIN_USD[symbol], median * config.WALL_MEDIAN_MULT)
        candidates = []
        for price, qty in levels.items():
            if not (low <= price <= high):
                continue
            usd = price * qty
            if usd < threshold:
                continue
            meta = book.meta.get((side, price))
            absorbed = tape.traded_usd(side, price, now, config.ICEBERG_TRADE_WINDOW_S)
            age = now - meta.first_seen if meta else 0.0
            refills = meta.refills if meta else 0
            kind = "iceberg" if (refills >= 2 or absorbed > 1.5 * usd) else "resting"
            candidates.append(
                {
                    "side": side,
                    "price": price,
                    "qty": qty,
                    "usd": usd,
                    "dist_pct": (price - mid) / mid * 100,
                    "age_s": round(age, 1),
                    "refills": refills,
                    "absorbed_usd": absorbed,
                    "kind": kind,
                }
            )
        candidates.sort(key=lambda w: abs(w["dist_pct"]))
        walls.extend(candidates[: config.WALL_MAX_PER_SIDE])
        tracked.extend(candidates)
    tracked.sort(key=lambda w: abs(w["dist_pct"]))
    walls.sort(key=lambda w: abs(w["dist_pct"]))
    nearest_bid = next((w for w in walls if w["side"] == "bid"), None)
    nearest_ask = next((w for w in walls if w["side"] == "ask"), None)
    return {
        "walls": walls,
        "tracked": tracked[:40],
        "nearest_bid": nearest_bid,
        "nearest_ask": nearest_ask,
    }


def iceberg_metrics(book: OrderBook, tape: TradeTape, symbol: str, now: float) -> list[dict]:
    mid = book.mid()
    if mid is None:
        return []
    min_usd = config.ICEBERG_MIN_USD[symbol]
    found = []
    for (side, price), meta in book.meta.items():
        if meta.qty <= 0:
            continue
        if abs(price - mid) / mid > 0.02:
            continue
        displayed_usd = price * meta.qty
        if displayed_usd < 15_000:
            continue
        age = now - meta.first_seen
        if age > config.ICEBERG_MAX_AGE_S:
            continue
        absorbed = tape.traded_usd(side, price, now, config.ICEBERG_TRADE_WINDOW_S)
        if absorbed < min_usd:
            continue
        ratio = absorbed / max(displayed_usd, 1.0)
        if meta.refills < 2 and ratio < config.ICEBERG_MIN_RATIO:
            continue
        found.append(
            {
                "side": side,
                "price": price,
                "qty": meta.qty,
                "displayed_usd": displayed_usd,
                "absorbed_usd": absorbed,
                "hidden_usd": max(absorbed - displayed_usd, 0.0),
                "refills": meta.refills,
                "age_s": round(age, 1),
                "dist_pct": (price - mid) / mid * 100,
                "ratio": round(ratio, 2),
            }
        )
    found.sort(key=lambda x: x["absorbed_usd"] * (1 + 0.2 * min(x["refills"], 6)), reverse=True)
    top = found[:6]
    for item in top:
        item["displayed_usd"] = round(item["displayed_usd"], 2)
        item["absorbed_usd"] = round(item["absorbed_usd"], 2)
        item["hidden_usd"] = round(item["hidden_usd"], 2)
    return top


def friction_curve(
    book: OrderBook,
    steps: int = 24,
    span: float = 0.03,
) -> list[dict]:
    """Cumulative notional to move price up/down by each distance bucket."""
    mid = book.mid()
    if mid is None:
        return []
    step = span / steps
    up = [0.0] * steps
    down = [0.0] * steps
    for price, qty in book.asks.items():
        idx = int((price - mid) / (mid * step))
        if 0 <= idx < steps:
            up[idx] += price * qty
    for price, qty in book.bids.items():
        idx = int((mid - price) / (mid * step))
        if 0 <= idx < steps:
            down[idx] += price * qty
    curve = []
    cum_up = cum_down = 0.0
    for i in range(steps):
        cum_up += up[i]
        cum_down += down[i]
        dist = (i + 1) * step * 100
        curve.append(
            {
                "dist_pct": round(dist, 3),
                "up_usd": cum_up,
                "down_usd": cum_down,
            }
        )
    return curve


def vacuum_metrics(book: OrderBook) -> dict:
    """Relative thinness of the 0.5%-2% corridors above vs below."""
    mid = book.mid()
    if mid is None:
        return {"up_density": 0.0, "down_density": 0.0, "score": 0.0, "gap": None}
    def density(direction: int) -> float:
        low = mid * (1 + direction * 0.005)
        high = mid * (1 + direction * 0.02)
        levels = book.asks if direction > 0 else book.bids
        total = 0.0
        for price, qty in levels.items():
            if min(low, high) <= price <= max(low, high):
                total += price * qty
        return total / 0.015
    up = density(1)
    down = density(-1)
    total = up + down
    score = (down - up) / total if total > 0 else 0.0
    return {
        "up_density": up,
        "down_density": down,
        "score": max(-1.0, min(1.0, score)),
        "gap_pct": 0.0,
    }


def wall_pressure(walls: dict, mid: float) -> tuple[float, float, float]:
    """Distance-weighted blocking strength of bid walls below vs ask walls above."""
    ask_block = bid_block = 0.0
    for wall in walls.get("walls", []):
        dist = abs(wall["dist_pct"]) / 100.0
        weight = 1.0 / (1.0 + dist * 220.0)
        strength = wall["usd"] * weight
        if wall["side"] == "ask":
            ask_block += strength
        else:
            bid_block += strength
    total = ask_block + bid_block
    score = (bid_block - ask_block) / total if total > 0 else 0.0
    return score, bid_block, ask_block


def liquidation_pressure(
    liq_summary: dict, estimated: list[dict], mid: float
) -> tuple[float, float, float]:
    """Fuel/magnet asymmetry: short liquidations above vs long liquidations below."""
    above = below = 0.0

    def weight(price: float) -> float:
        dist = abs(price - mid) / mid
        if dist > 0.03:
            return 0.0
        return 1.0 - dist / 0.03

    for level in estimated:
        if level["short_usd"] > 0 and level["price"] > mid:
            above += level["short_usd"] * weight(level["price"])
        if level["long_usd"] > 0 and level["price"] < mid:
            below += level["long_usd"] * weight(level["price"])
    for cluster in liq_summary.get("clusters", []):
        price = cluster["price"]
        if cluster["side"] == "short" and price > mid:
            above += cluster["usd"] * 0.35 * weight(price)
        elif cluster["side"] == "long" and price < mid:
            below += cluster["usd"] * 0.35 * weight(price)
    total = above + below
    score = (above - below) / total if total > 0 else 0.0
    return max(-1.0, min(1.0, score)), above, below


def pick_targets(
    direction: str,
    mid: float,
    walls: dict,
    estimated: list[dict],
    liq_summary: dict,
) -> dict:
    """Choose the nearest meaningful price magnets along the predicted path."""
    if direction == "neutral" or mid <= 0:
        return {"target": None, "invalidation": None, "levels": []}
    sign = 1 if direction == "up" else -1
    candidates: list[dict] = []
    lo = mid * (1 + sign * config.TARGET_MIN_PCT)
    hi = mid * (1 + sign * config.TARGET_MAX_PCT)
    low, high = min(lo, hi), max(lo, hi)

    for level in estimated:
        price = level["price"]
        if not (low <= price <= high):
            continue
        usd = level["short_usd"] if sign > 0 else level["long_usd"]
        if usd <= 0:
            continue
        candidates.append(
            {
                "price": price,
                "usd": usd,
                "kind": "liq",
                "label": "空头清算簇" if sign > 0 else "多头清算簇",
            }
        )
    for wall in walls.get("walls", []):
        if wall["side"] != ("ask" if sign > 0 else "bid"):
            continue
        price = wall["price"]
        if not (low <= price <= high):
            continue
        candidates.append(
            {
                "price": price,
                "usd": wall["usd"],
                "kind": "wall",
                "label": "卖墙" if sign > 0 else "买墙",
            }
        )
    for cluster in liq_summary.get("clusters", []):
        if cluster["side"] != ("short" if sign > 0 else "long"):
            continue
        price = cluster["price"]
        if not (low <= price <= high):
            continue
        candidates.append(
            {
                "price": price,
                "usd": cluster["usd"],
                "kind": "liq_past",
                "label": "已清算密集区",
            }
        )
    if not candidates:
        target = mid * (1 + sign * 0.003)
        return {
            "target": None,
            "invalidation": mid * (1 - sign * 0.0045),
            "levels": [
                {
                    "price": target,
                    "kind": "drift",
                    "label": "中性漂移目标",
                    "usd": 0.0,
                    "dist_pct": (target - mid) / mid * 100,
                }
            ],
        }
    candidates.sort(key=lambda c: (abs(c["price"] - mid), -c["usd"]))
    levels = []
    for item in candidates[:3]:
        levels.append(
            {
                "price": item["price"],
                "kind": item["kind"],
                "label": item["label"],
                "usd": round(item["usd"], 2),
                "dist_pct": round((item["price"] - mid) / mid * 100, 3),
            }
        )
    invalidation = None
    opposite = "bid" if sign > 0 else "ask"
    for wall in sorted(walls.get("walls", []), key=lambda w: abs(w["dist_pct"])):
        if wall["side"] == opposite and abs(wall["dist_pct"]) >= 0.05:
            invalidation = wall["price"]
            break
    if invalidation is None:
        invalidation = mid * (1 - sign * 0.0045)
    return {"target": levels[0]["price"], "invalidation": invalidation, "levels": levels}


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))
