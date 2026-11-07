"""HTTP + websocket application serving the dashboard and snapshot stream."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from pathlib import Path

from aiohttp import web

from . import config
from .hub import MarketHub

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"

HUB_KEY = web.AppKey("hub", MarketHub)


class SnapshotCache:
    """Builds at most one full snapshot per short interval."""

    def __init__(self, hub: MarketHub, ttl_s: float = 0.4) -> None:
        self.hub = hub
        self.ttl_s = ttl_s
        self._snapshot: dict | None = None
        self._built_at = 0.0

    def get(self) -> dict:
        now = time.monotonic()
        if self._snapshot is None or now - self._built_at >= self.ttl_s:
            self._snapshot = self.hub.snapshot()
            self._built_at = now
        return self._snapshot


CACHE_KEY = web.AppKey("snapshot_cache", SnapshotCache)


async def index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(WEB_ROOT / "index.html")


async def api_snapshot(request: web.Request) -> web.Response:
    cache: SnapshotCache = request.app[CACHE_KEY]
    return web.json_response(
        cache.get(), dumps=lambda value: json.dumps(value, ensure_ascii=False)
    )


async def api_health(request: web.Request) -> web.Response:
    hub: MarketHub = request.app[HUB_KEY]
    return web.json_response(
        {
            "ok": all(record.get("book_ready") for record in hub.feed["symbols"].values()),
            "mode": hub.mode,
            "base_mode": hub.base_mode,
            "uptime_s": round(time.time() - hub.started, 1),
            "feed_state": hub.feed.get("state"),
            "symbols": {
                symbol: {
                    "connected": record.get("connected"),
                    "book_ready": record.get("book_ready"),
                    "price": hub.states[symbol].ticker.get("last"),
                }
                for symbol, record in hub.feed["symbols"].items()
            },
        }
    )


async def websocket(request: web.Request) -> web.WebSocketResponse:
    hub: MarketHub = request.app[HUB_KEY]
    cache: SnapshotCache = request.app[CACHE_KEY]
    response = web.WebSocketResponse(heartbeat=25, compress=False)
    await response.prepare(request)

    async def push() -> None:
        while not response.closed:
            await asyncio.sleep(config.PUSH_INTERVAL_MS / 1000)
            if response.closed:
                return
            try:
                await response.send_str(
                    json.dumps(hub.snapshot(), ensure_ascii=False)
                )
            except (ConnectionResetError, RuntimeError):
                return

    try:
        await response.send_str(json.dumps(cache.get(), ensure_ascii=False))
        push_task = asyncio.create_task(push())
        try:
            # Draining incoming frames is what processes ping/pong and close frames.
            async for msg in response:
                if msg.type == web.WSMsgType.ERROR:
                    break
        finally:
            push_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await push_task
    except (ConnectionResetError, RuntimeError):
        pass
    finally:
        await response.close()
    return response


def create_app(hub: MarketHub) -> web.Application:
    app = web.Application()
    app[HUB_KEY] = hub
    app[CACHE_KEY] = SnapshotCache(hub)
    app.router.add_get("/", index)
    app.router.add_get("/api/snapshot", api_snapshot)
    app.router.add_get("/api/health", api_health)
    app.router.add_get("/ws", websocket)
    app.router.add_static("/css", WEB_ROOT / "css")
    app.router.add_static("/js", WEB_ROOT / "js")
    app.router.add_static("/mock", WEB_ROOT / "mock")
    app.router.add_static("/assets", WEB_ROOT / "assets")
    return app
