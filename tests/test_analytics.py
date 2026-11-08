"""Analytics: flow, CVD trimming, liquidations, walls, icebergs, friction."""

import pytest

from server import config
from server.analytics import (
    LiquidationBook,
    TradeTape,
    band_metrics,
    estimate_liquidation_map,
    friction_curve,
    iceberg_metrics,
    pick_targets,
    vacuum_metrics,
    wall_metrics,
    wall_pressure,
)
from server.book import OrderBook

NOW = 1_800_000_000.0
BTC = "BTCUSDT"


def _tape(symbol: str = BTC) -> TradeTape:
    return TradeTape(symbol, config.LARGE_TRADE_USD[symbol])


def _book(bids: list[list[str]], asks: list[list[str]], now: float = NOW) -> OrderBook:
    book = OrderBook(BTC, refill_window_s=3.5)
    book.apply_snapshot({"lastUpdateId": 1, "bids": bids, "asks": asks}, now)
    return book


def test_flow_splits_aggressor_sides_and_reports_delta() -> None:
    tape = _tape()
    tape.add(NOW - 10, 100.0, 2.0, is_buyer_maker=False)  # taker buy, $200
    tape.add(NOW - 5, 100.0, 1.0, is_buyer_maker=True)    # taker sell, $100
    flow = tape.flow(NOW)
    assert flow["buy_usd"] == pytest.approx(200.0)
    assert flow["sell_usd"] == pytest.approx(100.0)
    assert flow["delta_usd"] == pytest.approx(100.0)
    assert flow["ratio"] == pytest.approx(100.0 / 300.0)
    assert flow["trades"] == 2
    assert flow["cvd"][-1][1] == pytest.approx(100.0)


def test_cvd_trims_idle_buckets_before_first_trade() -> None:
    tape = _tape()
    tape.add(NOW - 30, 100.0, 2.0, is_buyer_maker=False)
    series = tape.cvd_series(NOW)
    assert series
    assert len(series) <= config.CVD_POINTS
    first_bucket = series[0][0] / 1000.0
    assert first_bucket >= NOW - (config.CVD_POINTS - 1) * config.CVD_BUCKET_S - config.CVD_BUCKET_S
    assert series[-1][1] == pytest.approx(200.0)


def test_cvd_empty_without_trades() -> None:
    assert _tape().cvd_series(NOW) == []


def test_large_trades_are_kept_on_the_tape() -> None:
    tape = _tape()
    tape.add(NOW, 100.0, 5_000.0, is_buyer_maker=False)  # $500k
    flow = tape.flow(NOW)
    assert len(flow["large"]) == 1
    assert flow["large"][0]["usd"] == pytest.approx(500_000.0)
    assert flow["large"][0]["side"] == "buy"


def test_liquidation_summary_totals_and_histogram() -> None:
    liq = LiquidationBook()
    liq.add(NOW - 60, "long", 99.0, 10.0)
    liq.add(NOW - 30, "short", 101.0, 20.0)
    liq.prune(NOW)
    summary = liq.summary(NOW, 100.0)
    assert summary["count"] == 2
    assert summary["total_long_usd"] == pytest.approx(990.0)
    assert summary["total_short_usd"] == pytest.approx(2020.0)
    assert len(summary["map"]) == config.LIQ_MAP_BINS
    assert summary["recent"][0]["side"] == "short"
    assert all(cluster["usd"] > 0 for cluster in summary["clusters"])


def test_liquidation_prune_drops_expired_events() -> None:
    liq = LiquidationBook(retention_s=60)
    liq.add(NOW - 120, "long", 100.0, 1.0)
    liq.add(NOW - 10, "long", 100.0, 1.0)
    liq.prune(NOW)
    assert liq.summary(NOW, 100.0)["count"] == 1


def test_estimated_liquidation_map_stays_bounded() -> None:
    candles = []
    for i in range(24):
        base = 100.0 + (i - 12) * 0.1
        candles.append([NOW - (24 - i) * 300, base, base + 0.2, base - 0.2, base + 0.1, 500.0])
    levels = estimate_liquidation_map(candles, 100.0)
    assert levels
    assert all(level["price"] > 0 for level in levels)
    assert all(abs(level["price"] - 100.0) / 100.0 <= config.LIQ_EST_MAX_DIST + 1e-9 for level in levels)
    assert all(level["long_usd"] >= 0 and level["short_usd"] >= 0 for level in levels)


def test_wall_metrics_finds_and_limits_walls() -> None:
    bids = [[str(100.0 - i * 0.01), "1"] for i in range(1, 40)]
    asks = [[str(100.0 + i * 0.01), "1"] for i in range(1, 40)]
    bids.append(["99.90", "25000"])  # $2.5M rest below the mid
    book = _book(bids, asks)
    tape = _tape()
    walls = wall_metrics(book, tape, BTC, NOW)
    found = [wall for wall in walls["walls"] if wall["price"] == pytest.approx(99.9)]
    assert len(found) == 1
    assert found[0]["side"] == "bid"
    assert found[0]["usd"] > config.WALL_MIN_USD[BTC]
    assert found[0]["kind"] == "resting"
    assert len([w for w in walls["walls"] if w["side"] == "bid"]) <= config.WALL_MAX_PER_SIDE


def test_iceberg_metrics_requires_absorption_and_refills() -> None:
    book = _book([["100.00", "2"]], [["100.20", "2000"]])
    book.meta[("ask", 100.2)].refills = 2
    tape = _tape()
    tape.add(NOW - 2, 100.2, 2500, is_buyer_maker=False)  # taker buys lift the ask
    found = iceberg_metrics(book, tape, BTC, NOW)
    assert len(found) == 1
    assert found[0]["side"] == "ask"
    assert found[0]["refills"] == 2
    assert found[0]["absorbed_usd"] >= config.ICEBERG_MIN_USD[BTC]
    assert found[0]["hidden_usd"] >= 0


def test_iceberg_metrics_ignores_plain_resting_liquidity() -> None:
    book = _book([["100.00", "2"]], [["100.20", "2000"]])
    assert iceberg_metrics(book, _tape(), BTC, NOW) == []


def test_friction_curve_is_cumulative_and_asymmetric() -> None:
    asks = [[str(100.0 + i * 0.1), "10"] for i in range(1, 20)]
    bids = [[str(100.0 - i * 0.1), "1"] for i in range(1, 20)]
    curve = friction_curve(_book(bids, asks))
    assert len(curve) == 24
    assert [row["dist_pct"] for row in curve] == sorted(row["dist_pct"] for row in curve)
    ups = [row["up_usd"] for row in curve]
    downs = [row["down_usd"] for row in curve]
    assert ups == sorted(ups)
    assert downs == sorted(downs)
    assert ups[-1] > downs[-1]


def test_vacuum_score_favours_the_thin_side() -> None:
    asks = [[str(100.0 + i * 0.01), "1"] for i in range(1, 300)]
    bids = [[str(100.0 - i * 0.01), "40"] for i in range(1, 300)]
    metrics = vacuum_metrics(_book(bids, asks))
    assert metrics["down_density"] > metrics["up_density"]
    assert metrics["score"] > 0


def test_pick_targets_uses_nearest_magnet() -> None:
    asks = [[str(100.0 + i * 0.01), "1"] for i in range(1, 60)]
    bids = [[str(100.0 - i * 0.01), "1"] for i in range(1, 60)]
    asks.append(["100.50", "60000"])
    book = _book(bids, asks)
    walls = wall_metrics(book, _tape(), BTC, NOW)
    result = pick_targets("up", 100.025, walls, [], {"clusters": []})
    assert result["target"] == pytest.approx(100.5)
    assert result["invalidation"] is not None
    assert result["levels"][0]["kind"] == "wall"


def test_depth_totals_use_the_widest_band_not_the_sum_of_nested_bands() -> None:
    bids = [["99.5", "1"], ["99.0", "1"], ["98.0", "1"], ["97.5", "1"]]
    asks = [["100.5", "1"], ["101.0", "1"], ["102.0", "1"], ["102.5", "1"]]
    metrics = band_metrics(_book(bids, asks))
    assert metrics["depth_span_pct"] == pytest.approx(3.0)
    assert metrics["bid_depth_usd"] == pytest.approx(metrics["bands"][-1]["bid_usd"])
    assert metrics["ask_depth_usd"] == pytest.approx(metrics["bands"][-1]["ask_usd"])
    assert metrics["bid_depth_usd"] < sum(b["bid_usd"] for b in metrics["bands"])


def test_wall_pressure_scores_absorbed_volume_not_resting_size(monkeypatch) -> None:
    monkeypatch.setitem(config.WALL_ABSORB_FULL_USD, BTC, 10_000.0)
    walls = {
        "walls": [
            {"side": "bid", "price": 99.0, "absorbed_usd": 120_000.0, "refills": 0},
            {"side": "ask", "price": 101.0, "absorbed_usd": 30_000.0, "refills": 0},
        ]
    }
    score, bid_absorbed, ask_absorbed = wall_pressure(walls, [], 100.0, BTC)
    assert bid_absorbed > ask_absorbed > 0
    assert score == pytest.approx(0.6)

    no_absorption = {
        "walls": [
            {"side": "bid", "price": 99.0, "absorbed_usd": 0.0, "refills": 0},
            {"side": "ask", "price": 101.0, "absorbed_usd": 0.0, "refills": 0},
        ]
    }
    assert wall_pressure(no_absorption, [], 100.0, BTC)[0] == 0.0


def test_wall_pressure_skips_icebergs_already_counted_as_walls(monkeypatch) -> None:
    monkeypatch.setitem(config.WALL_ABSORB_FULL_USD, BTC, 10_000.0)
    walls = {
        "walls": [
            {"side": "bid", "price": 99.0, "absorbed_usd": 100_000.0, "refills": 0}
        ]
    }
    icebergs = [
        {"side": "bid", "price": 99.0, "absorbed_usd": 500_000.0, "refills": 3},
        {"side": "ask", "price": 101.0, "absorbed_usd": 100_000.0, "refills": 0},
    ]
    score, bid_absorbed, ask_absorbed = wall_pressure(walls, icebergs, 100.0, BTC)
    assert bid_absorbed == pytest.approx(ask_absorbed)
    assert bid_absorbed < 200_000.0  # the 500k iceberg at 99.0 was skipped
    assert score == pytest.approx(0.0)


def test_vacuum_reads_outside_the_book_signal_corridor() -> None:
    inner_bids = [[str(100.0 - i / 100), "100"] for i in range(1, 100)]
    inner_asks = [[str(100.0 + i / 100), "100"] for i in range(1, 100)]
    thin_asks = [[str(100.0 + i / 100), "1"] for i in range(151, 300)]
    thick_bids = [[str(100.0 - i / 100), "50"] for i in range(151, 300)]
    metrics = vacuum_metrics(_book(inner_bids + thick_bids, inner_asks + thin_asks))
    assert metrics["up_density"] < metrics["down_density"]
    assert metrics["score"] > 0.9

