"""Spot trade mirror: aggressor flow is rescaled to the futures mid."""

import json
import time

from server import config
from server.feed import LiveFeed
from server.hub import MarketHub


def _hub(tmp_path, monkeypatch) -> MarketHub:
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    hub = MarketHub("live")
    hub.set_mode("live")
    return hub


def _book(hub: MarketHub) -> None:
    hub.states["BTCUSDT"].book.apply_snapshot(
        {
            "lastUpdateId": 1,
            "bids": [["100.00", "5"], ["99.90", "5"]],
            "asks": [["100.10", "5"], ["100.20", "5"]],
        },
        time.time(),
    )
    hub.set_book_ready("BTCUSDT", True)


def _agg_trade(price: str, maker: bool) -> bytes:
    return json.dumps(
        {
            "stream": "btcusdt@aggTrade",
            "data": {
                "s": "BTCUSDT",
                "p": price,
                "q": "2",
                "T": str(int(time.time() * 1000)),
                "m": maker,
            },
        }
    ).encode()


def test_spot_trade_is_rescaled_to_futures_mid(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _book(hub)
    feed = LiveFeed(hub)
    feed.spot_mid["BTCUSDT"] = 50.0

    feed._dispatch_spot(_agg_trade("50.0", maker=False))

    trade = hub.states["BTCUSDT"].tape.trades[-1]
    assert abs(trade.price - 100.05) < 1e-9
    assert trade.side == "buy"
    assert feed.ws_trade_ts["BTCUSDT"] > 0


def test_spot_trade_without_basis_is_skipped(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _book(hub)
    feed = LiveFeed(hub)

    feed._dispatch_spot(_agg_trade("100.05", maker=True))

    assert not hub.states["BTCUSDT"].tape.trades
    assert feed.ws_trade_ts["BTCUSDT"] == 0.0
