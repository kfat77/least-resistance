"""Entry point: resolves the data source, starts the hub and the web server."""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import webbrowser
from pathlib import Path

from aiohttp import web

from server import config
from server.app import create_app
from server.feed import LiveFeed
from server.hub import MarketHub


ROOT = Path(__file__).resolve().parent
BANNER = r"""
  __  __ ___ _   _     ____  _____ ____ _____ ___ ____  _   _  ____ _____
 |  \/  |_ _| \ | |   |  _ \| ____/ ___|_   _|_ _/ ___|| | | |/ ___|_   _|
 | |\/| || ||  \| |   | |_) |  _| \___ \ | |  | |\___ \| | | | |     | |
 | |  | || || |\  |   |  _ <| |___ ___) || |  | | ___) | |_| | |___  | |
 |_|  |_|___|_| \_|   |_| \_\_____|____/ |_| |___|____/ \___/ \____| |_|
"""


def resolve_mode(requested: str, timeout_s: float = 4.0) -> tuple[str, str]:
    """Return (mode, note); 'auto' probes Binance futures REST first."""
    if requested in ("live", "sim"):
        return requested, "已指定数据源"
    try:
        import requests

        response = requests.get(config.FAPI_REST + "/fapi/v1/ping", timeout=timeout_s)
        if response.status_code == 200:
            return "live", "Binance USD-M 期货 API 可达"
        return "sim", f"Binance 返回 HTTP {response.status_code}，切换到模拟源"
    except Exception as exc:  # noqa: BLE001 - any network failure means offline
        return "sim", f"网络不可用（{type(exc).__name__}），切换到模拟源"


async def main(args: argparse.Namespace) -> None:
    mode, note = resolve_mode(args.mode, args.probe_timeout)
    for path in (
        ROOT / "data" / mode,
        ROOT / "web" / "css",
        ROOT / "web" / "js",
        ROOT / "web" / "mock",
        ROOT / "web" / "assets",
    ):
        path.mkdir(parents=True, exist_ok=True)

    hub = MarketHub(mode)
    feed = LiveFeed(hub) if mode == "live" else _make_sim_feed(hub)
    app = create_app(hub)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    url = f"http://{args.host}:{args.port}/"
    print(BANNER)
    print(f"  data source : {mode.upper()}  ({note})")
    shadow_mode = next(m for m in config.WALL_MODES if m != config.WALL_MODE)
    print(f"  wall mode   : {config.WALL_MODE.upper()}  (A/B shadow: {shadow_mode})")
    print(f"  dashboard   : {url}")
    print(f"  snapshot    : {url}api/snapshot")
    print(f"  websocket   : ws://{args.host}:{args.port}/ws")
    print("  Ctrl+C to stop\n", flush=True)
    if args.open:
        webbrowser.open(url)

    feed_task = asyncio.create_task(feed.run())
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        feed.running = False  # type: ignore[attr-defined]
        feed_task.cancel()
        try:
            await feed_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        await runner.cleanup()


def _make_sim_feed(hub: MarketHub):
    from server.sim import SimFeed

    return SimFeed(hub)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MIN-RESISTANCE market dashboard")
    parser.add_argument("--mode", choices=("auto", "live", "sim"), default="auto",
                        help="data source; auto probes Binance first (default)")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--probe-timeout", type=float, default=4.0)
    parser.add_argument(
        "--wall-mode",
        choices=config.WALL_MODES,
        default=None,
        help="override WALL_MODE for this process; the other mode is logged in shadow",
    )
    parser.add_argument("--open", action="store_true", help="open the dashboard in a browser")
    return parser


def run() -> None:
    args = build_parser().parse_args()
    if args.wall_mode is not None:
        config.WALL_MODE = args.wall_mode
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\n  stopped", file=sys.stderr)


if __name__ == "__main__":
    run()
