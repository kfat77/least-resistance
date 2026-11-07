"""Offline simulator smoke test: full snapshot from synthetic market data."""

import asyncio
import contextlib

from server import config
from server.hub import MarketHub
from server.sim import SimFeed


def test_simulator_produces_live_looking_snapshot(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")

    async def scenario() -> list[dict]:
        hub = MarketHub("sim")
        feed = SimFeed(hub)
        task = asyncio.create_task(feed.run())
        samples: list[dict] = []
        try:
            for _ in range(10):
                await asyncio.sleep(0.4)
                samples.append(hub.snapshot())
        finally:
            feed.stop()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return samples

    samples = asyncio.run(scenario())
    snapshot = samples[-1]
    assert snapshot["mode"] == "sim"
    assert snapshot["feed"]["source"] == "simulator"
    for sample in samples:
        for symbol in config.SYMBOLS:
            book = sample["symbols"][symbol]["orderbook"]
            assert book["mid"] > 0
            assert book["spread_bps"] > 0
    for symbol in config.SYMBOLS:
        data = snapshot["symbols"][symbol]
        assert data["ready"] is True
        assert data["price"] > 0
        assert data["orderbook"]["mid"] > 0
        assert data["orderbook"]["profile"]
        assert data["orderbook"]["ladder"]["bids"]
        assert data["orderbook"]["ladder"]["asks"]
        assert data["flow"]["trades"] > 0
        assert data["chart"]["candles_1m"]
        assert data["prediction"]["direction"] in {"up", "down", "neutral"}
    assert snapshot["events"]
