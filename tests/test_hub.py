"""Hub snapshot contract: inbound plumbing and JSON-serializable payload."""

import json
import time

from server import config
from server.hub import MarketHub


def _hub(tmp_path, monkeypatch, mode: str = "live") -> MarketHub:
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    hub = MarketHub(mode)
    hub.set_mode(mode)
    return hub


def _fill_book(hub: MarketHub, symbol: str) -> None:
    now = time.time()
    hub.states[symbol].book.apply_snapshot(
        {
            "lastUpdateId": 10,
            "bids": [["100.00", "12"], ["99.00", "30"]],
            "asks": [["100.50", "9"], ["101.00", "20"]],
        },
        now,
    )
    hub.set_book_ready(symbol, True)


def test_snapshot_has_both_symbols_and_serializes(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    for symbol in config.SYMBOLS:
        hub.on_ticker(symbol, {"c": "100", "h": "110", "l": "90", "P": "1.5", "q": "12345"})
        hub.on_mark_price(symbol, {"p": "100.1", "i": "100.2", "r": "0.0001", "T": "1800000000000"})
        hub.set_open_interest(symbol, 1234.0)
        hub.set_candles(symbol, "1m", [[1800000000000, 100, 101, 99, 100.5, 12]])
        _fill_book(hub, symbol)
    snapshot = hub.snapshot()
    json.dumps(snapshot, ensure_ascii=False)
    assert snapshot["mode"] == "live"
    assert snapshot["symbol_order"] == list(config.SYMBOLS)
    assert snapshot["model"]["horizon_min"] == config.PREDICTION_HORIZON_MIN
    assert snapshot["model"]["wall_mode"] == config.WALL_MODE
    assert snapshot["model"]["wall_mode_alt"] != config.WALL_MODE
    for symbol in config.SYMBOLS:
        data = snapshot["symbols"][symbol]
        assert data["ready"] is True
        assert data["price"] > 0
        assert len(data["orderbook"]["ladder"]["bids"]) <= config.BOOK_LEVELS_SHOWN
        assert data["orderbook"]["profile"]
        assert set(data["flow"]) >= {"buy_usd", "sell_usd", "delta_usd", "cvd"}
        assert data["prediction"]["direction"] in {"up", "down", "neutral"}
        assert data["accuracy"]["horizon_min"] == config.PREDICTION_HORIZON_MIN
        assert data["accuracy"]["wall_mode"] == config.WALL_MODE
        assert data["accuracy_alt"]["wall_mode"] != config.WALL_MODE
        assert data["accuracy_alt"]["logged"] >= 1
        assert data["chart"]["candles_1m"]


def test_trades_feed_flow_and_whale_events(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _fill_book(hub, "BTCUSDT")
    now = time.time()
    hub.on_trade(
        "BTCUSDT",
        {"p": "100", "q": "5000", "T": str(int(now * 1000)), "m": False},
    )
    data = hub.snapshot()["symbols"]["BTCUSDT"]
    assert data["flow"]["trades"] == 1
    assert data["flow"]["buy_usd"] == 500_000
    assert any(event["kind"] == "whale" for event in hub.events)


def test_force_order_updates_liquidation_book(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _fill_book(hub, "ETHUSDT")
    now = time.time()
    hub.on_force_order(
        {
            "o": {
                "s": "ETHUSDT",
                "S": "SELL",
                "p": "2000",
                "q": "100",
                "T": int(now * 1000),
            }
        }
    )
    data = hub.snapshot()["symbols"]["ETHUSDT"]["liquidations"]
    assert data["count"] == 1
    assert data["total_long_usd"] == 200_000
    assert any(event["kind"] == "liquidation" for event in hub.events)


def test_health_fields_come_from_ticker(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    hub.on_ticker("BTCUSDT", {"c": "123.5", "h": "1", "l": "1", "P": "0", "q": "1"})
    assert hub.states["BTCUSDT"].ticker["last"] == 123.5


def test_wall_mode_switch_sets_active_and_shadow(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "WALL_MODE", "magnet")
    hub = _hub(tmp_path, monkeypatch)
    _fill_book(hub, "BTCUSDT")
    snapshot = hub.snapshot()
    assert snapshot["model"]["wall_mode"] == "magnet"
    assert snapshot["model"]["wall_mode_alt"] == "barrier"
    data = snapshot["symbols"]["BTCUSDT"]
    assert data["accuracy"]["wall_mode"] == "magnet"
    assert data["accuracy_alt"]["wall_mode"] == "barrier"
