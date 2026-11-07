"""Incremental order-book maintenance for Binance USD-M futures.

The book keeps every resting level from a 1000-level REST snapshot and applies
the ``@depth@100ms`` diff stream.  Sequence gaps raise :class:`ResyncRequired`
instead of silently corrupting prices; the feed layer re-snapshots on that.

Per-level statistics live beside the quantities so hidden-liquidity detection
can see how often a level refilled after being eaten.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


class ResyncRequired(Exception):
    """A diff stream update no longer chains onto the local book."""


@dataclass
class LevelMeta:
    """Lifetime statistics for one price level on one side of the book."""

    first_seen: float
    last_seen: float
    max_qty: float
    qty: float
    refills: int = 0
    last_drop_qty: float = 0.0
    last_drop_ts: float = 0.0
    drop_total_qty: float = 0.0


@dataclass
class OrderBook:
    """Local replica of one symbol's futures order book."""

    symbol: str
    bids: dict[float, float] = field(default_factory=dict)
    asks: dict[float, float] = field(default_factory=dict)
    last_update_id: int = 0
    ready: bool = False
    last_event_ts: float = 0.0
    snapshot_ts: float = 0.0
    meta: dict[tuple[str, float], LevelMeta] = field(default_factory=dict)
    refill_window_s: float = 3.5

    # -- lifecycle ---------------------------------------------------------
    def apply_snapshot(self, payload: dict, now: float | None = None) -> None:
        """Replace the book with a REST snapshot payload."""
        now = time.time() if now is None else now
        bids = {float(p): float(q) for p, q in payload.get("bids", []) if float(q) > 0}
        asks = {float(p): float(q) for p, q in payload.get("asks", []) if float(q) > 0}
        self.bids, self.asks = bids, asks
        self.meta.clear()
        for side, levels in (("bid", bids), ("ask", asks)):
            for price, qty in levels.items():
                self.meta[(side, price)] = LevelMeta(
                    first_seen=now, last_seen=now, max_qty=qty, qty=qty
                )
        self.last_update_id = int(payload.get("lastUpdateId", 0))
        self.snapshot_ts = now
        self.ready = True

    def apply_diff(self, payload: dict, now: float | None = None) -> None:
        """Apply one diff event; raises :class:`ResyncRequired` on a gap."""
        now = time.time() if now is None else now
        u = int(payload["u"])
        pu = int(payload.get("pu", 0))
        if u <= self.last_update_id:
            return
        if not self.ready:
            raise ResyncRequired("diff before snapshot")
        if pu > self.last_update_id:
            raise ResyncRequired(f"sequence gap: pu={pu} local={self.last_update_id}")
        for side, key in (("bid", "b"), ("ask", "a")):
            for price_s, qty_s in payload.get(key, []):
                self._set_level(side, float(price_s), float(qty_s), now)
        self.last_update_id = u
        self.last_event_ts = now

    def _set_level(self, side: str, price: float, qty: float, now: float) -> None:
        levels = self.bids if side == "bid" else self.asks
        prev = levels.get(price, 0.0)
        key = (side, price)
        if qty <= 0:
            levels.pop(price, None)
            meta = self.meta.get(key)
            if meta is not None:
                meta.last_seen = now
                meta.drop_total_qty += prev
                meta.last_drop_qty = prev
                meta.last_drop_ts = now
                meta.qty = 0.0
            return
        levels[price] = qty
        meta = self.meta.get(key)
        if meta is None:
            self.meta[key] = LevelMeta(
                first_seen=now, last_seen=now, max_qty=qty, qty=qty
            )
            return
        if qty > prev:
            increased = qty - prev
            if (
                prev > 0
                and meta.last_drop_ts > 0
                and now - meta.last_drop_ts <= self.refill_window_s
                and increased >= 0.25 * meta.last_drop_qty
            ):
                meta.refills += 1
                meta.last_drop_ts = 0.0
            meta.max_qty = max(meta.max_qty, qty)
        elif qty < prev:
            meta.last_drop_qty = prev - qty
            meta.last_drop_ts = now
            meta.drop_total_qty += prev - qty
        meta.qty = qty
        meta.last_seen = now

    # -- reads -------------------------------------------------------------
    def best_bid(self) -> tuple[float, float] | None:
        if not self.bids:
            return None
        price = max(self.bids)
        return price, self.bids[price]

    def best_ask(self) -> tuple[float, float] | None:
        if not self.asks:
            return None
        price = min(self.asks)
        return price, self.asks[price]

    def mid(self) -> float | None:
        bid, ask = self.best_bid(), self.best_ask()
        if bid is None or ask is None:
            return None
        return (bid[0] + ask[0]) / 2.0

    def spread_bps(self) -> float:
        bid, ask = self.best_bid(), self.best_ask()
        if bid is None or ask is None:
            return 0.0
        mid = (bid[0] + ask[0]) / 2.0
        return (ask[0] - bid[0]) / mid * 10_000.0 if mid else 0.0

    def top(self, side: str, limit: int) -> list[tuple[float, float]]:
        levels = self.bids if side == "bid" else self.asks
        ordered = sorted(levels.items(), reverse=(side == "bid"))
        return ordered[:limit]

    def notional_within(self, side: str, distance: float) -> float:
        """Resting notional on one side within ``distance`` of the mid."""
        mid = self.mid()
        if mid is None:
            return 0.0
        levels = self.bids if side == "bid" else self.asks
        low = mid * (1.0 - distance)
        high = mid * (1.0 + distance)
        total = 0.0
        for price, qty in levels.items():
            if low <= price <= high:
                total += price * qty
        return total

    def profile(self, bins: int = 96, span: float = 0.03) -> list[tuple[float, float, float]]:
        """Aggregate resting notional into price buckets.

        Returns ``[(price_low, bid_usd, ask_usd), ...]`` ordered from the lowest
        price to the highest, each bucket ``span / bins`` wide.
        """
        mid = self.mid()
        if mid is None:
            return []
        low = mid * (1.0 - span)
        step = mid * 2.0 * span / bins
        bucket = [[0.0, 0.0] for _ in range(bins)]
        for side_idx, levels in enumerate((self.bids, self.asks)):
            for price, qty in levels.items():
                idx = int((price - low) / step)
                if 0 <= idx < bins:
                    bucket[idx][side_idx] += price * qty
        return [(low + i * step, b, a) for i, (b, a) in enumerate(bucket)]

    # -- housekeeping ------------------------------------------------------
    def cleanup_meta(self, now: float, mid: float | None) -> None:
        """Drop statistics for levels that have been absent for a while."""
        stale = []
        for key, meta in self.meta.items():
            _side, price = key
            if meta.qty == 0 and now - meta.last_seen > 900.0:
                stale.append(key)
            elif mid is not None and abs(price - mid) / mid > 0.08:
                stale.append(key)
            elif now - meta.last_seen > 3600.0:
                stale.append(key)
        for key in stale:
            self.meta.pop(key, None)
