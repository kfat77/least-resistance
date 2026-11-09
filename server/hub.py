"""Market hub: state, analytics composition, prediction and snapshot assembly.

The hub is data-source agnostic.  The live Binance feed and the deterministic
simulator both drive it through the ``on_*`` methods; the web layer only calls
:meth:`MarketHub.snapshot`.
"""

from __future__ import annotations

import json
import math
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from . import analytics, config
from .book import OrderBook
from .predictor import PredictionLedger


def _usd(value: float) -> str:
    sign = "-" if value < 0 else ""
    value = abs(value)
    if value >= 1e9:
        return f"{sign}${value / 1e9:.2f}B"
    if value >= 1e6:
        return f"{sign}${value / 1e6:.2f}M"
    if value >= 1e3:
        return f"{sign}${value / 1e3:.0f}K"
    return f"{sign}${value:.0f}"


def _price(value: float) -> str:
    return f"{value:,.2f}"


@dataclass
class SymbolState:
    symbol: str
    display: str
    book: OrderBook
    tape: analytics.TradeTape
    liq: analytics.LiquidationBook
    ledger: PredictionLedger
    shadow_ledger: PredictionLedger
    ticker: dict = field(default_factory=dict)
    mark_price: float = 0.0
    index_price: float = 0.0
    funding_rate: float = 0.0
    next_funding_ts: int = 0
    open_interest: float = 0.0
    klines: dict[str, list] = field(default_factory=dict)
    candles_ts: float = 0.0
    wall_registry: dict[tuple[str, float], dict] = field(default_factory=dict)
    seen_icebergs: dict[tuple[str, float], float] = field(default_factory=dict)
    recent_spoofs: deque = field(default_factory=deque)
    book_resyncs: int = 0
    sim: bool = False


class MarketHub:
    def __init__(self, resolved_mode: str = "live") -> None:
        self.started = time.time()
        self.ab_started = self.started
        self.base_mode = resolved_mode
        self.mode = "connecting"
        self.data_dir = config.DATA_DIR / ("sim" if resolved_mode == "sim" else "live")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.wall_mode = self._initial_wall_mode()
        self.wall_mode_alt = next(m for m in config.WALL_MODES if m != self.wall_mode)
        self.states: dict[str, SymbolState] = {}
        for symbol in config.SYMBOLS:
            state = SymbolState(
                symbol=symbol,
                display=config.DISPLAY[symbol],
                book=OrderBook(symbol, refill_window_s=config.ICEBERG_REFILL_WINDOW_S),
                tape=analytics.TradeTape(symbol, config.LARGE_TRADE_USD[symbol]),
                liq=analytics.LiquidationBook(),
                ledger=PredictionLedger(
                    symbol,
                    self._ledger_path(symbol, self.wall_mode),
                ),
                shadow_ledger=PredictionLedger(
                    symbol,
                    self._ledger_path(symbol, self.wall_mode_alt),
                ),
            )
            state.liq.load(self._load_liquidation_rows(symbol))
            state.liq.prune(time.time())
            self.states[symbol] = state
        self.events: deque[dict] = deque(maxlen=80)
        self.feed: dict = {
            "state": "connecting",
            "source": "binance-usdm",
            "last_msg_ts": 0.0,
            "symbols": {
                symbol: {
                    "symbol": symbol,
                    "connected": False,
                    "book_ready": False,
                    "last_msg_ts": 0.0,
                    "reconnects": 0,
                    "resyncs": 0,
                    "messages": 0,
                }
                for symbol in config.SYMBOLS
            },
        }
        self._liq_files = {
            symbol: self.data_dir / f"liquidations_{symbol}.jsonl" for symbol in config.SYMBOLS
        }
        self._iceberg_cooldown_s = 600.0

    def _ledger_path(self, symbol: str, mode: str) -> Path:
        """Keep the legacy barrier ledger and give the A/B shadow its own file."""
        if mode == "barrier":
            legacy = self.data_dir / f"predictions_{symbol}.json"
            if legacy.exists():
                return legacy
        return self.data_dir / f"predictions_{symbol}_{mode}.json"

    def _initial_wall_mode(self) -> str:
        """Prefer an explicit WALL_MODE env var, then the last mode chosen in the UI."""
        if not config.WALL_MODE_FROM_ENV:
            path = self.data_dir / "wall_mode.txt"
            if path.exists():
                try:
                    saved = path.read_text(encoding="utf-8").strip().lower()
                except OSError:
                    saved = ""
                if saved in config.WALL_MODES:
                    return saved
        return config.WALL_MODE

    def set_wall_mode(self, mode: str) -> None:
        """Swap the displayed wall interpretation at runtime; both ledgers keep accumulating."""
        mode = str(mode).strip().lower()
        if mode not in config.WALL_MODES:
            raise ValueError(f"wall mode must be one of {config.WALL_MODES}, got {mode!r}")
        if mode == self.wall_mode:
            return
        previous = self.wall_mode
        self.wall_mode, self.wall_mode_alt = mode, previous
        for state in self.states.values():
            state.ledger, state.shadow_ledger = state.shadow_ledger, state.ledger
        try:
            (self.data_dir / "wall_mode.txt").write_text(
                f"{mode}\n", encoding="utf-8"
            )
        except OSError:
            pass  # persistence is best-effort; the process still switches

    # ------------------------------------------------------------------
    # feed plumbing
    # ------------------------------------------------------------------
    def set_mode(self, mode: str, source: str = "binance-usdm") -> None:
        self.mode = mode
        self.feed["state"] = mode
        self.feed["source"] = source

    def note_message(self, symbol: str) -> None:
        now = time.time()
        rec = self.feed["symbols"].get(symbol)
        if rec is not None:
            rec["last_msg_ts"] = now
            rec["messages"] += 1
            rec["connected"] = True
        self.feed["last_msg_ts"] = now

    def note_resync(self, symbol: str) -> None:
        rec = self.feed["symbols"].get(symbol)
        if rec is not None:
            rec["resyncs"] += 1
        self.states[symbol].book_resyncs += 1

    def note_reconnect(self, symbol: str | None = None) -> None:
        if symbol is None:
            for rec in self.feed["symbols"].values():
                rec["reconnects"] += 1
        else:
            self.feed["symbols"][symbol]["reconnects"] += 1

    # ------------------------------------------------------------------
    # inbound market data
    # ------------------------------------------------------------------
    def on_ticker(self, symbol: str, payload: dict) -> None:
        state = self.states.get(symbol)
        if state is None:
            return
        try:
            state.ticker = {
                "last": float(payload["c"]),
                "high": float(payload["h"]),
                "low": float(payload["l"]),
                "change_pct": float(payload["P"]),
                "quote_volume": float(payload["q"]),
            }
        except (KeyError, TypeError, ValueError):
            return

    def on_mark_price(self, symbol: str, payload: dict) -> None:
        state = self.states.get(symbol)
        if state is None:
            return
        try:
            state.mark_price = float(payload.get("p", 0.0))
            state.index_price = float(payload.get("i", 0.0))
            state.funding_rate = float(payload.get("r", 0.0))
            state.next_funding_ts = int(payload.get("T", 0))
        except (TypeError, ValueError):
            pass

    def on_trade(self, symbol: str, payload: dict) -> None:
        state = self.states.get(symbol)
        if state is None:
            return
        try:
            price = float(payload["p"])
            qty = float(payload["q"])
            ts = float(payload.get("T", payload.get("E", time.time() * 1000))) / 1000.0
        except (KeyError, TypeError, ValueError):
            return
        is_buyer_maker = bool(payload.get("m", False))
        before = len(state.tape.large)
        state.tape.add(ts, price, qty, is_buyer_maker)
        if len(state.tape.large) != before:
            trade = state.tape.large[-1]
            self._add_event(
                "whale",
                symbol,
                side=trade.side,
                price=trade.price,
                usd=trade.usd,
                note="大额主动成交",
            )

    def on_force_order(self, payload: dict) -> None:
        order = payload.get("o", payload)
        symbol = order.get("s")
        state = self.states.get(symbol)
        if state is None:
            return
        try:
            price = float(order["p"])
            qty = float(order["q"])
            ts = float(order.get("T", payload.get("E", time.time() * 1000))) / 1000.0
        except (KeyError, TypeError, ValueError):
            return
        side = "long" if order.get("S") == "SELL" else "short"
        state.liq.add(ts, side, price, qty)
        state.liq.prune(time.time())
        self._persist_liquidation(state, ts, side, price, qty)
        usd = price * qty
        if usd >= config.LIQ_EVENT_FEED_MIN_USD[symbol]:
            self._add_event(
                "liquidation",
                symbol,
                side=side,
                price=price,
                usd=usd,
                note="多头爆仓" if side == "long" else "空头爆仓",
            )

    def set_candles(self, symbol: str, interval: str, rows: list) -> None:
        state = self.states.get(symbol)
        if state is None:
            return
        state.klines[interval] = rows
        state.candles_ts = time.time()

    def set_open_interest(self, symbol: str, value: float) -> None:
        state = self.states.get(symbol)
        if state is not None:
            state.open_interest = float(value)

    def set_book_ready(self, symbol: str, ready: bool) -> None:
        rec = self.feed["symbols"].get(symbol)
        if rec is not None:
            rec["book_ready"] = ready

    def mark_offline(self, reason: str = "") -> None:
        self.feed["state"] = "offline"
        self.feed["error"] = reason
        for rec in self.feed["symbols"].values():
            rec["connected"] = False
        self.mode = "sim" if self.base_mode == "sim" else "offline"

    # ------------------------------------------------------------------
    # snapshot
    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        now = time.time()
        for state in self.states.values():
            state.tape.prune(now)
            state.liq.prune(now)
            state.book.cleanup_meta(now, state.book.mid())
        symbols = {symbol: self._symbol_snapshot(state, now) for symbol, state in self.states.items()}
        feed = json.loads(json.dumps(self.feed))
        for symbol, rec in feed["symbols"].items():
            last = rec.get("last_msg_ts", 0.0)
            rec["last_msg_age_s"] = round(now - last, 1) if last else None
            rec["stale"] = bool(last and now - last > 10.0)
            rec["display"] = config.DISPLAY[symbol]
        last_global = feed.get("last_msg_ts", 0.0)
        feed["last_msg_age_s"] = round(now - last_global, 1) if last_global else None
        return {
            "ts": int(now * 1000),
            "mode": self.mode,
            "base_mode": self.base_mode,
            "version": "1.0.0",
            "uptime_s": round(now - self.started, 1),
            "feed": feed,
            "symbol_order": list(config.SYMBOLS),
            "symbols": symbols,
            "events": list(self.events)[-30:][::-1],
            "model": {
                "name": "least-resistance",
                "horizon_min": config.PREDICTION_HORIZON_MIN,
                "weights": config.SIGNAL_WEIGHTS,
                "wall_mode": self.wall_mode,
                "wall_mode_alt": self.wall_mode_alt,
                "wall_modes": list(config.WALL_MODES),
                "ab_started": int(self.ab_started * 1000),
                "disclaimer": "仅供研究，不构成投资建议",
            },
        }

    # -- per-symbol assembly -------------------------------------------
    def _symbol_snapshot(self, state: SymbolState, now: float) -> dict:
        book = state.book
        ticker = state.ticker
        mid = book.mid() or ticker.get("last", 0.0)
        price = ticker.get("last") or mid
        ready = bool(book.ready and mid > 0)
        base = {
            "symbol": state.symbol,
            "display": state.display,
            "ready": ready,
            "price": price,
            "mid": mid,
            "change_24h_pct": ticker.get("change_pct"),
            "high_24h": ticker.get("high"),
            "low_24h": ticker.get("low"),
            "quote_volume_24h": ticker.get("quote_volume"),
            "mark_price": state.mark_price or mid,
            "index_price": state.index_price,
            "funding_rate": state.funding_rate,
            "next_funding_ts": state.next_funding_ts,
            "open_interest": state.open_interest,
            "book_resyncs": state.book_resyncs,
            "updated_ts": int(now * 1000),
        }
        if not ready:
            base.update(
                {
                    "orderbook": {
                        "mid": mid,
                        "spread_bps": 0.0,
                        "bands": [],
                        "imbalance_1pct": 0.0,
                        "bid_depth_usd": 0.0,
                        "ask_depth_usd": 0.0,
                        "ladder": {"bids": [], "asks": []},
                        "profile": [],
                        "walls": [],
                        "icebergs": [],
                    },
                    "liquidations": self._empty_liquidations(),
                    "flow": self._empty_flow(),
                    "friction": [],
                    "signals": [],
                    "prediction": None,
                    "accuracy": {**state.ledger.stats(), "wall_mode": self.wall_mode},
                    "accuracy_alt": {
                        **state.shadow_ledger.stats(),
                        "wall_mode": self.wall_mode_alt,
                    },
                    "accuracy_ab": {
                        **state.ledger.stats(self.ab_started),
                        "wall_mode": self.wall_mode,
                    },
                    "accuracy_alt_ab": {
                        **state.shadow_ledger.stats(self.ab_started),
                        "wall_mode": self.wall_mode_alt,
                    },
                    "chart": {"candles_1m": [], "candles_15m": [], "estimated_liq": []},
                }
            )
            return base

        bands = analytics.band_metrics(book)
        ladder_data = analytics.ladder(book)
        walls = analytics.wall_metrics(book, state.tape, state.symbol, now)
        icebergs = analytics.iceberg_metrics(book, state.tape, state.symbol, now)
        liq_summary = state.liq.summary(now, mid)
        estimated = analytics.estimate_liquidation_map(state.klines.get("5m", []), mid)
        flow = state.tape.flow(now)
        friction = analytics.friction_curve(book)
        vacuum = analytics.vacuum_metrics(book)

        self._detect_spoofs(state, walls, now)
        self._detect_iceberg_events(state, icebergs, now)

        components = self._components(
            bands, walls, icebergs, liq_summary, estimated, flow, vacuum, mid, state.symbol,
            self.wall_mode,
        )
        shadow_components = self._components(
            bands, walls, icebergs, liq_summary, estimated, flow, vacuum, mid, state.symbol,
            self.wall_mode_alt,
        )
        prediction = self._prediction(state, components, walls, liq_summary, estimated, mid, now)
        shadow_prediction = self._shadow_prediction(shadow_components)
        state.ledger.resolve_due(now, price or mid)
        state.shadow_ledger.resolve_due(now, price or mid)
        if prediction is not None:
            state.ledger.maybe_log(now, price or mid, prediction)
            state.shadow_ledger.maybe_log(now, price or mid, shadow_prediction)

        base.update(
            {
                "orderbook": {
                    "mid": mid,
                    "spread_bps": bands["spread_bps"],
                    "imbalance_1pct": bands["imbalance_1pct"],
                    "bid_depth_usd": bands["bid_depth_usd"],
                    "ask_depth_usd": bands["ask_depth_usd"],
                    "bands": bands["bands"],
                    "ladder": ladder_data,
                    "profile": [
                        {"price": round(p, 2), "bid_usd": round(b, 2), "ask_usd": round(a, 2)}
                        for p, b, a in book.profile(config.PROFILE_BINS, config.PROFILE_RANGE)
                    ],
                    "walls": walls["walls"],
                    "nearest_bid": walls["nearest_bid"],
                    "nearest_ask": walls["nearest_ask"],
                    "icebergs": icebergs,
                },
                "liquidations": {
                    **liq_summary,
                    "estimated": estimated,
                    "estimated_note": "由 24h 成交量分布 × 杠杆结构反推的估算值，非交易所持仓数据",
                },
                "flow": flow,
                "friction": friction,
                "signals": self._signals(components),
                "prediction": prediction,
                "accuracy": {**state.ledger.stats(), "wall_mode": self.wall_mode},
                "accuracy_alt": {
                    **state.shadow_ledger.stats(),
                    "wall_mode": self.wall_mode_alt,
                },
                "accuracy_ab": {
                    **state.ledger.stats(self.ab_started),
                    "wall_mode": self.wall_mode,
                },
                "accuracy_alt_ab": {
                    **state.shadow_ledger.stats(self.ab_started),
                    "wall_mode": self.wall_mode_alt,
                },
                "chart": {
                    "candles_1m": state.klines.get("1m", [])[-config.CANDLE_1M_LIMIT :],
                    "candles_15m": state.klines.get("15m", [])[-config.CANDLE_15M_LIMIT :],
                    "estimated_liq": estimated,
                },
            }
        )
        return base

    # -- analytics composition -----------------------------------------
    def _components(
        self,
        bands: dict,
        walls: dict,
        icebergs: list[dict],
        liq_summary: dict,
        estimated: list[dict],
        flow: dict,
        vacuum: dict,
        mid: float,
        symbol: str,
        wall_mode: str,
    ) -> list[dict]:
        def band_imb(dist: float) -> float:
            for band in bands.get("bands", []):
                if abs(band["dist_pct"] - dist) < 1e-6:
                    return band["imbalance"]
            return 0.0

        book_score = analytics.clamp(0.45 * band_imb(0.5) + 0.55 * band_imb(1.0))
        wall_score, bid_absorbed, ask_absorbed = analytics.wall_pressure(
            walls, icebergs, mid, symbol, wall_mode
        )
        liq_score, above, below = analytics.liquidation_pressure(liq_summary, estimated, mid)
        flow_score = analytics.clamp(flow.get("ratio", 0.0))
        vacuum_score = analytics.clamp(vacuum.get("score", 0.0))

        band_one = next((b for b in bands.get("bands", []) if abs(b["dist_pct"] - 1.0) < 1e-6), None)
        bid_1 = band_one["bid_usd"] if band_one else 0.0
        ask_1 = band_one["ask_usd"] if band_one else 0.0
        imb_1 = band_one["imbalance"] if band_one else 0.0
        liq_above = sum(
            level["short_usd"] for level in estimated if level["price"] > mid
        ) + sum(
            c["usd"] for c in liq_summary.get("clusters", []) if c["side"] == "short"
        )
        liq_below = sum(
            level["long_usd"] for level in estimated if level["price"] < mid
        ) + sum(
            c["usd"] for c in liq_summary.get("clusters", []) if c["side"] == "long"
        )

        def absorption_text() -> str:
            if bid_absorbed <= 0 and ask_absorbed <= 0:
                return "近 2 分钟墙/冰山无显著吸收，等待成交验证"
            return (
                f"近 2 分钟买侧吸收 {_usd(bid_absorbed)}"
                f" / 卖侧吸收 {_usd(ask_absorbed)}（墙与冰山，含回补加成）"
            )

        return [
            {
                "key": "book",
                "label": "挂单失衡",
                "score": book_score,
                "weight": config.SIGNAL_WEIGHTS["book"],
                "detail": f"±1% 挂单 买 {_usd(bid_1)} / 卖 {_usd(ask_1)}，失衡 {imb_1 * 100:+.1f}%",
            },
            {
                "key": "walls",
                "label": "墙/冰山吸收",
                "score": wall_score,
                "weight": config.SIGNAL_WEIGHTS["walls"],
                "detail": absorption_text(),
                "meta": {"bid_absorbed": bid_absorbed, "ask_absorbed": ask_absorbed},
            },
            {
                "key": "liquidations",
                "label": "清算燃料",
                "score": liq_score,
                "weight": config.SIGNAL_WEIGHTS["liquidations"],
                "detail": f"上方空头清算 {_usd(liq_above)} / 下方多头清算 {_usd(liq_below)}",
                "meta": {"above": above, "below": below},
            },
            {
                "key": "flow",
                "label": "主动成交流",
                "score": flow_score,
                "weight": config.SIGNAL_WEIGHTS["flow"],
                "detail": (
                    f"5 分钟主动买 {_usd(flow.get('buy_usd', 0))} / 卖 {_usd(flow.get('sell_usd', 0))}"
                    f"，净额 {flow.get('ratio', 0) * 100:+.1f}%"
                ),
            },
            {
                "key": "vacuum",
                "label": "流动性真空",
                "score": vacuum_score,
                "weight": config.SIGNAL_WEIGHTS["vacuum"],
                "detail": (
                    f"1.5–3% 档挂单密度 上方 {_usd(vacuum.get('up_density', 0))}/1%"
                    f" / 下方 {_usd(vacuum.get('down_density', 0))}/1%"
                ),
            },
        ]

    def _signals(self, components: list[dict]) -> list[dict]:
        signals = []
        for component in components:
            contribution = component["score"] * component["weight"]
            signals.append(
                {
                    "key": component["key"],
                    "label": component["label"],
                    "score": round(component["score"], 4),
                    "weight": component["weight"],
                    "contribution": round(contribution, 4),
                    "detail": component["detail"],
                }
            )
        return signals

    def _composite(self, components: list[dict]) -> tuple[float, float, str, float]:
        score = sum(c["score"] * c["weight"] for c in components)
        p_up = analytics.sigmoid(score * config.PREDICTION_CONFIDENCE_GAIN)
        threshold = config.PREDICTION_DIRECTION_THRESHOLD
        if score > threshold:
            direction = "up"
        elif score < -threshold:
            direction = "down"
        else:
            direction = "neutral"
        confidence = max(p_up, 1.0 - p_up)
        return score, p_up, direction, confidence

    def _shadow_prediction(self, components: list[dict]) -> dict:
        """Only the fields the A/B ledger scores; targets/narrative stay active-mode."""
        score, p_up, direction, confidence = self._composite(components)
        return {
            "direction": direction,
            "p_up": round(p_up, 4),
            "score": round(score, 4),
            "confidence": round(confidence, 4),
        }

    def _prediction(
        self,
        state: SymbolState,
        components: list[dict],
        walls: dict,
        liq_summary: dict,
        estimated: list[dict],
        mid: float,
        now: float,
    ) -> dict:
        score, p_up, direction, confidence = self._composite(components)
        targets = analytics.pick_targets(direction, mid, walls, estimated, liq_summary)
        levels = targets["levels"]
        narrative = self._narrative(
            state, direction, score, p_up, components, walls, targets, mid
        )
        return {
            "direction": direction,
            "p_up": round(p_up, 4),
            "score": round(score, 4),
            "confidence": round(confidence, 4),
            "horizon_min": config.PREDICTION_HORIZON_MIN,
            "target_price": targets["target"],
            "invalidation_price": targets["invalidation"],
            "levels": levels,
            "narrative": narrative,
            "updated_ts": int(now * 1000),
        }

    def _narrative(
        self,
        state: SymbolState,
        direction: str,
        score: float,
        p_up: float,
        components: list[dict],
        walls: dict,
        targets: dict,
        mid: float,
    ) -> str:
        horizon = config.PREDICTION_HORIZON_MIN
        bid_wall = walls.get("nearest_bid")
        ask_wall = walls.get("nearest_ask")
        levels = targets["levels"]
        if direction == "neutral":
            low = mid * 0.997
            high = mid * 1.003
            return (
                f"多空阻力接近平衡（得分 {score:+.2f}）："
                f"买墙 {_usd(bid_wall['usd']) if bid_wall else '$0'} 对卖墙 "
                f"{_usd(ask_wall['usd']) if ask_wall else '$0'}，"
                f"5 分钟主动成交净额 {next((c['score'] for c in components if c['key'] == 'flow'), 0.0) * 100:+.1f}%。"
                f"价格倾向在 {_price(low)} – {_price(high)} 区间被来回吸附，"
                f"等待一侧挂单被吃穿后再确认方向。"
            )
        if direction == "up":
            lead = "最小阻力向上"
            if levels:
                first = levels[0]
                lead += f"：{_price(first['price'])} 的{first['label']}（{_usd(first['usd'])}）是第一磁吸位"
            else:
                lead += "：上方 0.5–2% 挂单稀薄，倾向缓步上探"
            support = ""
            if bid_wall:
                support = (
                    f"下方 {_price(bid_wall['price'])} 买墙（{_usd(bid_wall['usd'])}）构成回踩支撑"
                )
            invalid = targets["invalidation"]
            tail = f"{support}，跌破 {_price(invalid)} 则上行结构失效。" if support else f"跌破 {_price(invalid)} 则上行结构失效。"
        else:
            lead = "最小阻力向下"
            if levels:
                first = levels[0]
                lead += f"：{_price(first['price'])} 的{first['label']}（{_usd(first['usd'])}）是第一磁吸位"
            else:
                lead += "：下方 0.5–2% 挂单稀薄，倾向缓步下探"
            resistance = ""
            if ask_wall:
                resistance = (
                    f"上方 {_price(ask_wall['price'])} 卖墙（{_usd(ask_wall['usd'])}）构成反弹压制"
                )
            invalid = targets["invalidation"]
            tail = f"{resistance}，站回 {_price(invalid)} 则下行结构失效。" if resistance else f"站回 {_price(invalid)} 则下行结构失效。"
        return f"{lead}；{tail} 综合得分 {score:+.2f}，{horizon} 分钟上行概率 {p_up:.0%}。"

    # -- alerts ---------------------------------------------------------
    def _add_event(self, kind: str, symbol: str, **fields) -> None:
        event = {
            "ts": int(time.time() * 1000),
            "kind": kind,
            "symbol": symbol,
            "display": config.DISPLAY[symbol],
        }
        event.update(fields)
        self.events.append(event)

    def _detect_spoofs(self, state: SymbolState, walls: dict, now: float) -> None:
        current = {(w["side"], w["price"]): w for w in walls.get("tracked", [])}
        mid = state.book.mid()
        for key in list(state.wall_registry):
            if key in current:
                continue
            record = state.wall_registry.pop(key)
            side, price = key
            if mid is not None and abs(price - mid) / mid > config.WALL_SCAN_RANGE * 1.05:
                continue
            remaining = (
                state.book.asks.get(price, 0.0)
                if side == "ask"
                else state.book.bids.get(price, 0.0)
            )
            # A spoof means the level is gone, not merely thinner: a partially
            # filled wall is absorption, and it is still resting.
            if remaining > 0:
                continue
            age = now - record["first_seen"]
            if age < config.SPOOF_MIN_AGE_S:
                continue
            if record["usd"] < config.SPOOF_MIN_USD[state.symbol]:
                continue
            if record.get("absorbed_usd", 0.0) > 0.12 * record["usd"]:
                continue
            side = "卖墙" if key[0] == "ask" else "买墙"
            self._add_event(
                "spoof",
                state.symbol,
                side=key[0],
                price=key[1],
                usd=record["usd"],
                note=f"{side}快速撤单",
            )
        for key, wall in current.items():
            prev = state.wall_registry.get(key)
            if prev is None:
                state.wall_registry[key] = {
                    "first_seen": now - wall.get("age_s", 0.0),
                    "usd": wall["usd"],
                    "absorbed_usd": wall.get("absorbed_usd", 0.0),
                }
            else:
                prev["usd"] = wall["usd"]
                prev["absorbed_usd"] = wall.get("absorbed_usd", 0.0)
        cutoff = now - 900.0
        for key in [k for k, v in state.wall_registry.items() if v["first_seen"] < cutoff]:
            state.wall_registry.pop(key, None)

    def _detect_iceberg_events(self, state: SymbolState, icebergs: list[dict], now: float) -> None:
        for ice in icebergs:
            key = (ice["side"], ice["price"])
            if now - state.seen_icebergs.get(key, 0.0) < self._iceberg_cooldown_s:
                continue
            state.seen_icebergs[key] = now
            label = "买侧冰山" if ice["side"] == "bid" else "卖侧冰山"
            self._add_event(
                "iceberg",
                state.symbol,
                side=ice["side"],
                price=ice["price"],
                usd=ice["absorbed_usd"],
                note=f"{label}：已吸收 {_usd(ice['absorbed_usd'])}，回补 {ice['refills']} 次",
            )
        cutoff = now - self._iceberg_cooldown_s * 2
        for key in [k for k, ts in state.seen_icebergs.items() if ts < cutoff]:
            state.seen_icebergs.pop(key, None)

    # -- persistence ----------------------------------------------------
    def _load_liquidation_rows(self, symbol: str) -> list[dict]:
        path = self.data_dir / f"liquidations_{symbol}.jsonl"
        if not path.exists():
            return []
        cutoff = time.time() - config.LIQ_RETENTION_S
        rows = []
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if float(row.get("ts", 0)) >= cutoff:
                        rows.append(row)
        except OSError:
            return []
        return rows

    def _persist_liquidation(
        self, state: SymbolState, ts: float, side: str, price: float, qty: float
    ) -> None:
        path = self._liq_files[state.symbol]
        try:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps({"ts": ts, "side": side, "price": price, "qty": qty}) + "\n"
                )
        except OSError:
            pass

    # -- empty shapes ---------------------------------------------------
    def _empty_liquidations(self) -> dict:
        return {
            "window_h": int(config.LIQ_RETENTION_S / 3600),
            "total_long_usd": 0.0,
            "total_short_usd": 0.0,
            "count": 0,
            "recent": [],
            "map": [],
            "clusters": [],
            "estimated": [],
            "estimated_note": "",
        }

    def _empty_flow(self) -> dict:
        return {
            "buy_usd": 0.0,
            "sell_usd": 0.0,
            "delta_usd": 0.0,
            "ratio": 0.0,
            "trades": 0,
            "window_s": int(config.FLOW_WINDOW_S),
            "cvd": [],
            "large": [],
        }
