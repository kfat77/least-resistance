"""Spoof detection: a vanished wall is a pull, a thinner wall is absorption."""

import time

from server import config
from server.hub import MarketHub


def _hub(tmp_path, monkeypatch) -> MarketHub:
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    hub = MarketHub("live")
    hub.set_mode("live")
    return hub


def _book_with_wall(hub: MarketHub, symbol: str = "BTCUSDT") -> None:
    now = time.time()
    bids = [["100.00", "15000"]] + [
        [f"{99.9 - index * 0.1:.1f}", "10"] for index in range(12)
    ]
    asks = [[f"{100.1 + index * 0.1:.1f}", "10"] for index in range(12)]
    hub.states[symbol].book.apply_snapshot(
        {"lastUpdateId": 1, "bids": bids, "asks": asks}, now
    )
    hub.set_book_ready(symbol, True)
    hub.on_ticker(symbol, {"c": "100", "h": "100", "l": "100", "P": "0", "q": "1"})


def _set_level(hub: MarketHub, symbol: str, qty: str) -> None:
    hub.states[symbol].book.apply_diff(
        {
            "e": "depthUpdate",
            "E": int(time.time() * 1000),
            "u": 99,
            "pu": 1,
            "b": [["100.00", qty]],
            "a": [],
        }
    )


def _age_registry(hub: MarketHub, seconds: float = 10.0) -> None:
    for record in hub.states["BTCUSDT"].wall_registry.values():
        record["first_seen"] -= seconds


def test_thinning_wall_is_not_a_spoof(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _book_with_wall(hub)
    hub.snapshot()
    assert ("bid", 100.0) in hub.states["BTCUSDT"].wall_registry
    _age_registry(hub)

    # The wall falls below the detection threshold but still rests: absorption.
    _set_level(hub, "BTCUSDT", "5000")
    hub.snapshot()
    assert not any(event["kind"] == "spoof" for event in hub.events)


def test_vanished_wall_is_a_spoof(tmp_path, monkeypatch) -> None:
    hub = _hub(tmp_path, monkeypatch)
    _book_with_wall(hub)
    hub.snapshot()
    _age_registry(hub)

    _set_level(hub, "BTCUSDT", "0")
    hub.snapshot()
    spoofs = [event for event in hub.events if event["kind"] == "spoof"]
    assert len(spoofs) == 1
    assert spoofs[0]["side"] == "bid"
    assert spoofs[0]["price"] == 100.0
    assert spoofs[0]["usd"] >= config.SPOOF_MIN_USD["BTCUSDT"]
