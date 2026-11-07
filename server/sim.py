"""Deterministic offline market simulator.

Drives :class:`server.hub.MarketHub` through the same inbound callbacks as the
live Binance feed, so the dashboard, analytics and tests can run without any
network access. Prices follow a mean-reverting random walk, liquidity is
synthesized around the mid, and icebergs, spoofed walls and liquidation prints
are injected on purpose so every panel has something to show.
"""

from __future__ import annotations

import asyncio
import math
import random
import time

from . import config
from .book import OrderBook

TICK_S = 0.35
LEVELS_WINDOW = 90
BOOK_HALF_SPAN = 170

# label, seconds, candles kept
CANDLE_SPECS = (("1m", 60, 180), ("5m", 300, 288), ("15m", 900, 96))

SIM_PARAMS: dict[str, dict] = {
    "BTCUSDT": {
        "start": 76_080.0,
        "spacing": 1.0,
        "half_spread": 0.1,
        "depth_levels": 2_600,
        "median_qty": 1.1,
        "wall_qty": (30.0, 45.0),
        "iceberg_display": 0.6,
        "iceberg_absorb": 1.7,
        "trade_median": 0.045,
        "large_qty": (6.0, 13.0),
        "quote_volume": 9.1e9,
        "open_interest": 95_600.0,
        "liq_qty": 1.1,
        "candle_volume": 62.0,
        "vol_per_tick": 4.0e-5,
    },
    "ETHUSDT": {
        "start": 2_245.0,
        "spacing": 0.05,
        "half_spread": 0.01,
        "depth_levels": 1_500,
        "median_qty": 40.0,
        "wall_qty": (1_000.0, 1_500.0),
        "iceberg_display": 20.0,
        "iceberg_absorb": 42.0,
        "trade_median": 0.9,
        "large_qty": (150.0, 350.0),
        "quote_volume": 4.1e9,
        "open_interest": 2_380_000.0,
        "liq_qty": 28.0,
        "candle_volume": 780.0,
        "vol_per_tick": 5.0e-5,
    },
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


class SimBook:
    """Synthetic limit order book with walls and one replenishing iceberg."""

    def __init__(
        self,
        symbol: str,
        price: float,
        params: dict,
        rng: random.Random,
        book: OrderBook,
    ) -> None:
        self.symbol = symbol
        self.rng = rng
        self.spacing = float(params["spacing"])
        self.half_spread = float(params["half_spread"])
        self.median_qty = float(params["median_qty"])
        self.wall_qty_range = params["wall_qty"]
        self.iceberg_display = float(params["iceberg_display"])
        self.iceberg_absorb = float(params["iceberg_absorb"])
        self.book = book
        self.walls: dict[tuple[str, float], float] = {}
        self.wall_expiry: dict[tuple[str, float], float] = {}
        self.iceberg: dict | None = None
        self.depth_levels = int(params["depth_levels"])
        self.max_span = self.depth_levels * self.spacing * 1.12
        self._seed(price)
        self._place_initial_walls(price, time.time())

    # -- pricing helpers ---------------------------------------------------
    def _quantize(self, price: float) -> float:
        return round(round(price / self.spacing) * self.spacing, 6)

    def _sample_qty(self, distance_levels: int = 1) -> float:
        qty = self.median_qty * math.exp(self.rng.gauss(0.0, 0.85))
        qty *= 1.0 + min(distance_levels, 120) / 160.0
        return round(_clamp(qty, 0.15 * self.median_qty, 5.0 * self.median_qty), 6)

    def _seed(self, price: float) -> None:
        mid = self._quantize(price)
        bids: list[list[str]] = []
        asks: list[list[str]] = []
        for i in range(1, self.depth_levels + 1):
            bid_price = round(mid - i * self.spacing, 6)
            ask_price = round(mid + i * self.spacing, 6)
            bids.append([f"{bid_price:.6f}", f"{self._sample_qty(i):.6f}"])
            asks.append([f"{ask_price:.6f}", f"{self._sample_qty(i):.6f}"])
            if i <= 30:
                # Fractional offsets keep the top of book dense and organic.
                for frac in (0.35, 0.7):
                    extra_bid = round(bid_price - frac * self.spacing, 6)
                    extra_ask = round(ask_price + frac * self.spacing, 6)
                    bids.append([f"{extra_bid:.6f}", f"{self._sample_qty(i):.6f}"])
                    asks.append([f"{extra_ask:.6f}", f"{self._sample_qty(i):.6f}"])
        now = time.time()
        self.book.apply_snapshot({"lastUpdateId": 1, "bids": bids, "asks": asks}, now)

    # -- book maintenance --------------------------------------------------
    def best_prices(self) -> tuple[float, float]:
        bid = self.book.best_bid()
        ask = self.book.best_ask()
        return (bid[0] if bid else 0.0), (ask[0] if ask else 0.0)

    def recenter(self, price: float, now: float, tick: int) -> None:
        bb = self._quantize(price - self.half_spread)
        ba = self._quantize(price + self.half_spread)
        if ba <= bb:
            ba = round(bb + self.spacing, 6)
        # Nothing may rest inside or across the spread after a price move.
        for level_price in [p for p in self.book.bids if p > bb]:
            self.book._set_level("bid", level_price, 0.0, now)
        for level_price in [p for p in self.book.asks if p < ba]:
            self.book._set_level("ask", level_price, 0.0, now)

        # A jump can sweep a tracked wall or the iceberg into the spread; move
        # the anchor instead of letting stale state re-add a crossed level.
        for key in list(self.walls):
            side, wall_price = key
            levels = self.book.bids if side == "bid" else self.book.asks
            if levels.get(wall_price, 0.0) > 0:
                continue
            self.walls.pop(key, None)
            self.wall_expiry.pop(key, None)
            self._place_wall(price, now, side)
        if self.iceberg is not None:
            ice = self.iceberg
            levels = self.book.bids if ice["side"] == "bid" else self.book.asks
            if levels.get(ice["price"], 0.0) <= 0:
                sign = 1.0 if ice["side"] == "ask" else -1.0
                new_price = self._quantize(
                    price * (1.0 + sign * self.rng.uniform(0.0002, 0.0016))
                )
                for key in self.walls:
                    if key[1] == new_price:
                        new_price = self._quantize(new_price + sign * self.spacing)
                qty = max(ice["qty"], 0.4 * ice["displayed"])
                self.book._set_level(ice["side"], new_price, qty, now)
                ice["price"] = new_price

        protected = set(self.walls) | (
            {(self.iceberg["side"], self.iceberg["price"])} if self.iceberg else set()
        )
        for side, base in (("bid", bb), ("ask", ba)):
            levels = self.book.bids if side == "bid" else self.book.asks
            sign = -1.0 if side == "bid" else 1.0
            for i in range(0, LEVELS_WINDOW + 1):
                level_price = self._quantize(base + sign * i * self.spacing)
                if level_price in levels:
                    continue
                if i <= 30:
                    for frac in (0.35, 0.7):
                        extra = self._quantize(level_price + sign * frac * self.spacing)
                        if extra in levels or (side, extra) in protected:
                            continue
                        self.book._set_level(side, extra, self._sample_qty(i), now)
                if (side, level_price) in protected:
                    continue
                self.book._set_level(side, level_price, self._sample_qty(i), now)

        if tick % 45 == 0:
            self._ensure_span(bb, ba, now, protected)
        if tick % 15 == 0:
            low = bb - self.max_span
            high = ba + self.max_span
            for side, levels in (("bid", self.book.bids), ("ask", self.book.asks)):
                for level_price in [p for p in levels if p < low or p > high]:
                    self.book._set_level(side, level_price, 0.0, now)

    def _ensure_span(self, bb: float, ba: float, now: float, protected: set) -> None:
        """Re-fill the deep book after price drift emptied one flank."""
        for side, base, sign in (("bid", bb, -1.0), ("ask", ba, 1.0)):
            levels = self.book.bids if side == "bid" else self.book.asks
            for i in range(1, self.depth_levels + 1):
                level_price = self._quantize(base + sign * i * self.spacing)
                if level_price in levels or (side, level_price) in protected:
                    continue
                self.book._set_level(side, level_price, self._sample_qty(i), now)

    def jitter(self, now: float) -> None:
        """Refresh a handful of visible levels so depth breathes."""
        for side in ("bid", "ask"):
            levels = self.book.bids if side == "bid" else self.book.asks
            prices = [p for p in levels if (side, p) not in self.walls]
            if self.iceberg and self.iceberg["side"] == side:
                prices = [p for p in prices if p != self.iceberg["price"]]
            prices = [p for p in prices if abs(p - (self.book.mid() or p)) <= 60 * self.spacing]
            if not prices:
                continue
            for level_price in self.rng.sample(prices, min(5, len(prices))):
                self.book._set_level(side, level_price, self._sample_qty(), now)

    # -- walls -------------------------------------------------------------
    def _place_initial_walls(self, price: float, now: float) -> None:
        for side in ("bid", "ask"):
            for _ in range(2):
                self._place_wall(price, now, side)

    def _place_wall(self, price: float, now: float, side: str) -> None:
        sign = -1.0 if side == "bid" else 1.0
        for _ in range(8):
            offset = self.rng.uniform(0.003, 0.013)
            level_price = self._quantize(price * (1.0 + sign * offset))
            key = (side, level_price)
            if key in self.walls:
                continue
            if self.iceberg and self.iceberg["price"] == level_price:
                continue
            qty = self.rng.uniform(*self.wall_qty_range)
            self.book._set_level(side, level_price, qty, now)
            self.walls[key] = qty
            self.wall_expiry[key] = now + self.rng.uniform(28.0, 115.0)
            return

    def manage_walls(self, price: float, now: float) -> None:
        for key, expiry in list(self.wall_expiry.items()):
            if now < expiry:
                continue
            side, level_price = key
            self.book._set_level(side, level_price, 0.0, now)
            self.walls.pop(key, None)
            self.wall_expiry.pop(key, None)
            self._place_wall(price, now, side)

    # -- iceberg -----------------------------------------------------------
    def manage_iceberg(self, price: float, now: float, uptrend: bool) -> None:
        ice = self.iceberg
        if ice is not None and now - ice["born"] > 300.0:
            self.book._set_level(ice["side"], ice["price"], 0.0, now)
            self.iceberg = None
            ice = None
        if ice is None:
            side = "ask" if uptrend else "bid"
            sign = 1.0 if side == "ask" else -1.0
            level_price = self._quantize(price * (1.0 + sign * self.rng.uniform(0.0002, 0.0016)))
            for key in self.walls:
                if key[1] == level_price:
                    level_price = self._quantize(level_price + sign * self.spacing)
            self.book._set_level(side, level_price, self.iceberg_display, now)
            self.iceberg = {
                "side": side,
                "price": level_price,
                "qty": self.iceberg_display,
                "displayed": self.iceberg_display,
                "born": now,
                "refill_at": 0.0,
            }
            return
        if ice["refill_at"] and now >= ice["refill_at"]:
            added = ice["displayed"] * self.rng.uniform(1.6, 3.2)
            new_qty = min(ice["displayed"], ice["qty"] + added)
            if new_qty > ice["qty"]:
                self.book._set_level(ice["side"], ice["price"], new_qty, now)
                ice["qty"] = new_qty
            if new_qty >= ice["displayed"] * 0.98:
                ice["refill_at"] = 0.0

    def absorb(self, now: float) -> dict | None:
        """One hidden-liquidity print at the iceberg price, if present."""
        ice = self.iceberg
        if ice is None or ice["qty"] <= 0.0:
            return None
        if self.rng.random() > 0.30:
            return None
        qty = self.iceberg_absorb * self.rng.uniform(0.7, 1.6)
        remaining = max(0.40 * ice["displayed"], ice["qty"] - qty)
        self.book._set_level(ice["side"], ice["price"], remaining, now)
        ice["qty"] = remaining
        if not ice["refill_at"]:
            ice["refill_at"] = now + self.rng.uniform(0.5, 1.8)
        return {
            "price": ice["price"],
            "qty": qty,
            "is_buyer_maker": ice["side"] == "bid",
        }


class SimSymbol:
    def __init__(self, symbol: str, params: dict, rng: random.Random, hub) -> None:
        self.symbol = symbol
        self.hub = hub
        self.rng = rng
        self.params = params
        self.price = float(params["start"])
        self.base_price = self.price
        self.prev_price = self.price
        self.book_sim = SimBook(
            symbol, self.price, params, rng, hub.states[symbol].book
        )
        self.high = self.price * 1.008
        self.low = self.price * 0.987
        self.quote_volume = float(params["quote_volume"])
        self.traded_quote = 0.0
        self.open_interest = float(params["open_interest"])
        self.funding = 0.000013
        self.candles = {label: [] for label, _, _ in CANDLE_SPECS}
        self._tick = 0
        self._last_candle_push = 0.0
        self._last_oi_push = 0.0
        self._vol = float(params["vol_per_tick"])
        self._seed_candles()

    # -- candles -----------------------------------------------------------
    def _seed_candles(self) -> None:
        now = time.time()
        for label, seconds, count in CANDLE_SPECS:
            rets = [self.rng.gauss(0.0, 0.0012) for _ in range(count)]
            mean = sum(rets) / count
            walk = [0.0]
            for ret in rets:
                walk.append(walk[-1] + (ret - mean))
            end = int(now // seconds) * seconds
            rows = []
            for i in range(count):
                close = self.price * math.exp(walk[i + 1])
                open_ = self.price * math.exp(walk[i])
                high = max(open_, close) * (1.0 + abs(self.rng.gauss(0.0, 0.0009)))
                low = min(open_, close) * (1.0 - abs(self.rng.gauss(0.0, 0.0009)))
                volume = self.params["candle_volume"] * (seconds / 60.0) * math.exp(
                    self.rng.gauss(0.0, 0.55)
                )
                start = end - (count - i) * seconds
                rows.append([start * 1000, open_, high, low, close, volume])
            self.candles[label] = rows
        self._last_candle_push = 0.0

    def _update_candles(self, ts: float, price: float, qty: float) -> None:
        for label, seconds, count in CANDLE_SPECS:
            rows = self.candles[label]
            if not rows:
                continue
            bucket = int(ts // seconds) * seconds
            row = rows[-1]
            if int(row[0] // 1000) == bucket:
                row[2] = max(row[2], price)
                row[3] = min(row[3], price)
                row[4] = price
                row[5] += qty
            else:
                rows.append([bucket * 1000, row[4], price, price, price, qty])
                if len(rows) > count:
                    del rows[: len(rows) - count]

    # -- warm start --------------------------------------------------------
    def warm_start(self, now: float) -> None:
        """Backfill tape / CVD / liquidations so the UI is populated at load."""
        start = now - 240.0
        ts = start
        price = self.price
        injected = 0
        while ts < now - 1.0 and injected < 420:
            ts += self.rng.uniform(0.2, 1.0)
            price *= math.exp(self.rng.gauss(0.0, 0.00035))
            price = _clamp(price, self.price * 0.996, self.price * 1.004)
            is_buyer_maker = self.rng.random() < 0.5
            qty = self.params["trade_median"] * math.exp(self.rng.gauss(0.0, 1.1))
            qty = _clamp(qty, self.params["trade_median"] * 0.1, self.params["trade_median"] * 7.0)
            self.hub.on_trade(
                self.symbol,
                {"p": f"{price:.6f}", "q": f"{qty:.6f}", "T": int(ts * 1000), "m": is_buyer_maker},
            )
            self.traded_quote += price * qty
            self._update_candles(ts, price, qty)
            injected += 1
        self.price = price
        self.prev_price = price

        for _ in range(18):
            if self.hub.states[self.symbol].liq.events:
                # Liquidations persist across restarts; do not duplicate them.
                break
            ts = now - self.rng.uniform(240.0, 3.0 * 3600.0)
            up = self.rng.random() < 0.5
            distance = self.rng.uniform(0.003, 0.018)
            price = self.price * (1.0 + (distance if up else -distance))
            qty = self.params["liq_qty"] * self.rng.uniform(1.4, 5.0)
            order_side = "BUY" if up else "SELL"
            self.hub.on_force_order(
                {
                    "o": {
                        "s": self.symbol,
                        "S": order_side,
                        "p": f"{price:.2f}",
                        "q": f"{qty:.4f}",
                        "T": int(ts * 1000),
                    }
                }
            )

    # -- one tick ----------------------------------------------------------
    def tick(self, now: float) -> None:
        self._tick += 1
        self.prev_price = self.price
        ret = self.rng.gauss(0.0, self._vol)
        ret += 0.000006 * math.sin(now / 210.0)
        ret -= 0.000035 * (self.price / self.base_price - 1.0)
        jump = 0.0
        if self.rng.random() < 0.0025:
            jump = self.rng.gauss(0.0, 0.0010)
        ret += jump
        self.price *= math.exp(ret)
        self.price = _clamp(self.price, self.base_price * 0.94, self.base_price * 1.06)

        self.book_sim.recenter(self.price, now, self._tick)
        self.book_sim.jitter(now)
        self.book_sim.manage_walls(self.price, now)
        self.book_sim.manage_iceberg(self.price, now, uptrend=ret > 0)

        best_bid, best_ask = self.book_sim.best_prices()
        mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else self.price
        momentum = (self.price / self.prev_price - 1.0) if self.prev_price else 0.0
        p_buy = 0.5 + _clamp(momentum * 2500.0, -0.18, 0.18)

        trades = max(0, int(self.rng.gauss(1.8, 1.1)))
        for _ in range(trades):
            buy = self.rng.random() < p_buy
            qty = self.params["trade_median"] * math.exp(self.rng.gauss(0.0, 1.15))
            qty = _clamp(qty, self.params["trade_median"] * 0.08, self.params["trade_median"] * 7.0)
            price = best_ask if buy else best_bid
            self._print(now, price, qty, is_buyer_maker=not buy)
        if self.rng.random() < 0.006:
            low, high = self.params["large_qty"]
            qty = self.rng.uniform(low, high)
            buy = self.rng.random() < p_buy
            self._print(now, best_ask if buy else best_bid, qty, is_buyer_maker=not buy)

        absorbed = self.book_sim.absorb(now)
        if absorbed is not None:
            self._print(
                now,
                absorbed["price"],
                absorbed["qty"],
                is_buyer_maker=absorbed["is_buyer_maker"],
            )

        liquidation_chance = 0.006 + (0.35 if abs(jump) > 0.0006 else 0.0)
        if self.rng.random() < liquidation_chance:
            down = ret < 0 or jump < 0
            side = "SELL" if down else "BUY"
            qty = self.params["liq_qty"] * self.rng.uniform(1.6, 4.2)
            price = mid * (0.9995 if down else 1.0005)
            self.hub.on_force_order(
                {
                    "o": {
                        "s": self.symbol,
                        "S": side,
                        "p": f"{price:.2f}",
                        "q": f"{qty:.4f}",
                        "T": int(now * 1000),
                    }
                }
            )

        self.high = max(self.high, self.price)
        self.low = min(self.low, self.price)
        self.open_interest = self.params["open_interest"] * (
            1.0 + 0.008 * math.sin(now / 260.0) + self.rng.gauss(0.0, 0.0008)
        )
        self.funding = _clamp(self.funding + self.rng.gauss(0.0, 1.5e-6), -8e-4, 8e-4)
        next_funding = (int(now) // 28_800 + 1) * 28_800

        self.hub.note_message(self.symbol)
        self.hub.set_book_ready(self.symbol, True)
        self.hub.on_ticker(
            self.symbol,
            {
                "c": f"{self.price:.2f}",
                "h": f"{self.high:.2f}",
                "l": f"{self.low:.2f}",
                "P": f"{(self.price / self.base_price - 1.0) * 100:.3f}",
                "q": f"{self.quote_volume + self.traded_quote:.2f}",
            },
        )
        self.hub.on_mark_price(
            self.symbol,
            {
                "p": f"{self.price * (1.0 + 1e-5):.2f}",
                "i": f"{self.price * (1.0 - 1e-5):.2f}",
                "r": f"{self.funding:.8f}",
                "T": next_funding * 1000,
            },
        )
        if now - self._last_oi_push > 5.0:
            self.hub.set_open_interest(self.symbol, round(self.open_interest, 2))
            self._last_oi_push = now
        if now - self._last_candle_push > 2.0:
            for label, _, _ in CANDLE_SPECS:
                self.hub.set_candles(self.symbol, label, [list(row) for row in self.candles[label]])
            self._last_candle_push = now

    def _print(self, now: float, price: float, qty: float, is_buyer_maker: bool) -> None:
        if price <= 0 or qty <= 0:
            return
        self.hub.on_trade(
            self.symbol,
            {
                "p": f"{price:.6f}",
                "q": f"{qty:.6f}",
                "T": int(now * 1000),
                "m": is_buyer_maker,
            },
        )
        self.traded_quote += price * qty
        self._update_candles(now, price, qty)


class SimFeed:
    """Offline feed: advances every symbol once per tick."""

    def __init__(self, hub) -> None:
        self.hub = hub
        self.rng = random.Random(2026_1107)
        self.symbols = {
            symbol: SimSymbol(symbol, params, self.rng, hub)
            for symbol, params in SIM_PARAMS.items()
            if symbol in config.SYMBOLS
        }
        self._running = False

    async def run(self) -> None:
        self.hub.set_mode("sim", "simulator")
        now = time.time()
        for symbol in self.symbols.values():
            symbol.warm_start(now)
        for symbol in self.symbols.values():
            self.hub.set_book_ready(symbol.symbol, True)
        self._running = True
        try:
            while self._running:
                now = time.time()
                for symbol in self.symbols.values():
                    symbol.tick(now)
                await asyncio.sleep(TICK_S)
        finally:
            self._running = False

    def stop(self) -> None:
        self._running = False

