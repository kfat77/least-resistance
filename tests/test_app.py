"""HTTP and websocket surface."""

import asyncio
import time

from aiohttp.test_utils import TestClient, TestServer

from server import config
from server.app import CACHE_KEY, create_app
from server.hub import MarketHub


def _prepared_hub(tmp_path, monkeypatch) -> MarketHub:
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    hub = MarketHub("live")
    hub.set_mode("live")
    for symbol in config.SYMBOLS:
        hub.on_ticker(symbol, {"c": "100", "h": "110", "l": "90", "P": "2", "q": "999"})
        now = time.time()
        hub.states[symbol].book.apply_snapshot(
            {
                "lastUpdateId": 5,
                "bids": [["99.5", "20"]],
                "asks": [["100.5", "15"]],
            },
            now,
        )
        hub.set_book_ready(symbol, True)
    return hub


def test_health_and_snapshot_endpoints(tmp_path, monkeypatch) -> None:
    hub = _prepared_hub(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = create_app(hub)
        async with TestClient(TestServer(app)) as client:
            health = await (await client.get("/api/health")).json()
            assert health["ok"] is True
            assert health["mode"] == "live"
            price = health["symbols"]["BTCUSDT"]["price"]
            assert price == 100.0

            response = await client.get("/api/snapshot")
            assert response.status == 200
            snapshot = await response.json()
            assert snapshot["symbol_order"] == list(config.SYMBOLS)

    asyncio.run(scenario())


def test_websocket_pushes_full_snapshots(tmp_path, monkeypatch) -> None:
    hub = _prepared_hub(tmp_path, monkeypatch)

    async def scenario() -> None:
        app = create_app(hub)
        async with TestClient(TestServer(app)) as client:
            async with client.ws_connect("/ws") as ws:
                first = await ws.receive_json(timeout=5)
                assert first["mode"] == "live"
                assert "symbols" in first
                second = await ws.receive_json(timeout=5)
                assert second["ts"] >= first["ts"]

    asyncio.run(scenario())


def test_background_tick_builds_snapshots_without_requests(tmp_path, monkeypatch) -> None:
    """Prediction accounting must not depend on a dashboard being connected."""
    hub = _prepared_hub(tmp_path, monkeypatch)
    monkeypatch.setattr(config, "LEDGER_TICK_S", 0.05)

    async def scenario() -> None:
        app = create_app(hub)
        async with TestServer(app):
            cache = app[CACHE_KEY]
            assert cache._built_at == 0.0
            await asyncio.sleep(0.25)
            assert cache._built_at > 0.0

    asyncio.run(scenario())


def test_wall_mode_endpoint_switches_and_rejects_invalid(tmp_path, monkeypatch) -> None:
    hub = _prepared_hub(tmp_path, monkeypatch)
    other = "magnet" if hub.wall_mode == "barrier" else "barrier"

    async def scenario() -> None:
        app = create_app(hub)
        async with TestClient(TestServer(app)) as client:
            response = await client.post("/api/wall-mode", json={"mode": other})
            assert response.status == 200
            body = await response.json()
            assert body == {"ok": True, "wall_mode": other, "wall_mode_alt": hub.wall_mode_alt}

            snapshot = await (await client.get("/api/snapshot")).json()
            assert snapshot["model"]["wall_mode"] == other

            bad = await client.post("/api/wall-mode", json={"mode": "sideways"})
            assert bad.status == 400
            assert (await bad.json())["ok"] is False

    asyncio.run(scenario())
