"""Live Binance USD-M futures feed.

One combined websocket carries depth diffs, aggTrades, tickers, mark prices and
the all-market force-order stream.  Each symbol's order book is bootstrapped from
a REST snapshot and then follows the diff chain; a sequence gap triggers a fresh
snapshot instead of a corrupt book.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque

import aiohttp
import websockets

from . import config
from .book import ResyncRequired
from .hub import MarketHub


class LiveFeed:
    def __init__(self, hub: MarketHub) -> None:
        self.hub = hub
        self.symbols = list(config.SYMBOLS)
        self.session: aiohttp.ClientSession | None = None
        self.ws: websockets.WebSocketClientProtocol | None = None
        self.running = False
        self.syncing: dict[str, bool] = {symbol: False for symbol in self.symbols}
        self.buffers: dict[str, deque] = {
            symbol: deque(maxlen=8000) for symbol in self.symbols
        }
        self.sync_tasks: dict[str, asyncio.Task] = {}
        self.ws_trade_ts: dict[str, float] = {symbol: 0.0 for symbol in self.symbols}
        self.trade_ids: dict[str, int] = {symbol: 0 for symbol in self.symbols}
        self.streams = self._stream_names()
        self.url = config.FSTREAM_WS + "/".join(self.streams)
        self.spot_url = config.SPOT_STREAM_WS + "/".join(
            f"{symbol.lower()}@{stream}"
            for symbol in self.symbols
            for stream in ("aggTrade", "bookTicker")
        )
        self.spot_mid: dict[str, float] = {}
        self.backoff_s = 1.0
        self.consecutive_failures = 0
        # A 418/429 response bans the whole IP for minutes; retrying during the
        # ban extends it.  Every REST path is parked until this timestamp.
        self.rest_blocked_until = 0.0

    # -- public ----------------------------------------------------------
    async def run(self) -> None:
        self.running = True
        timeout = aiohttp.ClientTimeout(total=config.REST_TIMEOUT_S)
        # aiodns is broken on this Windows setup; the threaded resolver uses the
        # same system getaddrinfo path that requests and websockets already use.
        connector = aiohttp.TCPConnector(resolver=aiohttp.ThreadedResolver())
        self.session = aiohttp.ClientSession(timeout=timeout, connector=connector)
        spot_task = asyncio.create_task(self._spot_trades())
        try:
            while self.running:
                try:
                    await self._connection()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # transport failures are expected
                    self.consecutive_failures += 1
                    self.hub.feed["state"] = "reconnecting"
                    self.hub.feed["error"] = f"{type(exc).__name__}: {exc}"
                    self.hub.note_reconnect()
                    for rec in self.hub.feed["symbols"].values():
                        rec["connected"] = False
                        rec["book_ready"] = False
                    await asyncio.sleep(self.backoff_s)
                    self.backoff_s = min(self.backoff_s * 1.6, 8.0)
        finally:
            spot_task.cancel()
            if self.session is not None:
                await self.session.close()
            self.hub.feed["state"] = "offline"

    # -- websocket lifecycle ---------------------------------------------
    def _stream_names(self) -> list[str]:
        streams: list[str] = []
        for symbol in self.symbols:
            lower = symbol.lower()
            streams.append(f"{lower}@depth@{config.DEPTH_STREAM_SPEED}")
            streams.append(f"{lower}@aggTrade")
            streams.append(f"{lower}@ticker")
            streams.append(f"{lower}@markPrice@1s")
            streams.append(f"{lower}@bookTicker")
        streams.append("!forceOrder@arr")
        return streams

    async def _connection(self) -> None:
        async with websockets.connect(
            self.url,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
            max_size=2**25,
        ) as ws:
            self.ws = ws
            self.backoff_s = 1.0
            self.consecutive_failures = 0
            self.hub.set_mode("live", "binance-usdm")
            self.hub.feed["error"] = ""
            for symbol in self.symbols:
                self.buffers[symbol].clear()
                self.syncing[symbol] = False
                self.hub.states[symbol].book.ready = False
            for record in self.hub.feed["symbols"].values():
                record["connected"] = True
            for symbol in self.symbols:
                self._begin_sync(symbol)
            rest_task = asyncio.create_task(self._rest_loop())
            trade_task = asyncio.create_task(self._trade_loop())
            try:
                while True:
                    raw = await asyncio.wait_for(
                        ws.recv(), timeout=config.WS_IDLE_TIMEOUT_S
                    )
                    self._dispatch(raw)
            except asyncio.TimeoutError as exc:
                raise ConnectionError("websocket idle timeout") from exc
            finally:
                rest_task.cancel()
                trade_task.cancel()
                for task in self.sync_tasks.values():
                    task.cancel()
                for symbol in self.symbols:
                    self.syncing[symbol] = False

    # -- spot trade mirror ------------------------------------------------
    async def _spot_trades(self) -> None:
        """Mirror spot aggTrades into the futures tape.

        The futures aggTrade/markPrice/ticker streams are silent on some
        networks even though depth still flows, so the tape would otherwise be
        empty.  Spot trades carry the same aggressor flow; each price is scaled
        by futures_mid / spot_mid so wall and iceberg absorption still lines up
        with the futures book.
        """
        backoff = 1.0
        self.hub.feed["spot"] = "connecting"
        while self.running:
            try:
                async with websockets.connect(
                    self.spot_url,
                    ping_interval=20,
                    ping_timeout=20,
                    close_timeout=5,
                    max_size=2**23,
                ) as spot_ws:
                    backoff = 1.0
                    self.hub.feed["spot"] = "live"
                    async for raw in spot_ws:
                        self._dispatch_spot(raw)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.hub.feed["spot"] = f"reconnecting: {type(exc).__name__}"
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.6, 10.0)

    def _dispatch_spot(self, raw: str | bytes) -> None:
        try:
            message = json.loads(raw)
        except ValueError:
            return
        stream = message.get("stream", "")
        data = message.get("data")
        if not isinstance(data, dict):
            return
        symbol = data.get("s")
        if symbol not in self.hub.states:
            return
        if stream.endswith("@bookTicker"):
            try:
                bid = float(data["b"])
                ask = float(data["a"])
            except (KeyError, TypeError, ValueError):
                return
            if bid > 0 and ask > 0:
                self.spot_mid[symbol] = (bid + ask) / 2
            return
        if not stream.endswith("@aggTrade"):
            return
        try:
            price = float(data["p"])
        except (KeyError, TypeError, ValueError):
            return
        spot_mid = self.spot_mid.get(symbol, 0.0)
        futures_mid = self.hub.states[symbol].book.mid()
        if spot_mid <= 0 or not futures_mid:
            return
        ratio = futures_mid / spot_mid
        self.ws_trade_ts[symbol] = time.time()
        self.hub.on_trade(
            symbol,
            {
                "p": str(price * ratio),
                "q": data.get("q"),
                "T": data.get("T"),
                "m": data.get("m"),
            },
        )

    # -- dispatch ---------------------------------------------------------
    def _dispatch(self, raw: str | bytes) -> None:
        try:
            message = json.loads(raw)
        except ValueError:
            return
        stream = message.get("stream", "")
        data = message.get("data")
        if not isinstance(data, dict):
            return
        if stream == "!forceOrder@arr":
            self.hub.on_force_order(data)
            return
        symbol = data.get("s")
        if symbol not in self.hub.states:
            return
        if "@depth" in stream:
            self._on_depth(symbol, data)
        elif stream.endswith("@aggTrade"):
            self.ws_trade_ts[symbol] = time.time()
            self.hub.on_trade(symbol, data)
        elif stream.endswith("@ticker"):
            self.hub.on_ticker(symbol, data)
        elif "@markPrice" in stream:
            self.hub.on_mark_price(symbol, data)
        elif stream.endswith("@bookTicker"):
            try:
                bid = float(data["b"])
                ask = float(data["a"])
                if bid > 0 and ask > 0:
                    self.hub.states[symbol].ticker["last"] = (bid + ask) / 2
            except (KeyError, TypeError, ValueError):
                pass
        self.hub.note_message(symbol)

    def _on_depth(self, symbol: str, payload: dict) -> None:
        book = self.hub.states[symbol].book
        if self.syncing[symbol] or not book.ready:
            self.buffers[symbol].append(payload)
            return
        try:
            book.apply_diff(payload)
        except ResyncRequired:
            self.hub.note_resync(symbol)
            book.ready = False
            self.hub.set_book_ready(symbol, False)
            self._begin_sync(symbol, delay=0.3)

    # -- order-book sync --------------------------------------------------
    def _begin_sync(self, symbol: str, delay: float = 0.0) -> None:
        if self.syncing[symbol]:
            return
        self.syncing[symbol] = True
        book = self.hub.states[symbol].book
        book.ready = False
        self.hub.set_book_ready(symbol, False)
        task = asyncio.create_task(self._sync_once(symbol, delay))
        self.sync_tasks[symbol] = task

    def _clear_error(self, prefix: str) -> None:
        """Clear a transient feed error once the failing path has recovered."""
        current = self.hub.feed.get("error") or ""
        if current.startswith(prefix):
            self.hub.feed["error"] = ""

    async def _sync_once(self, symbol: str, delay: float) -> None:
        if delay:
            await asyncio.sleep(delay)
        retry_delay: float | None = None
        try:
            payload = await self._get(
                "/fapi/v1/depth",
                {"symbol": symbol, "limit": config.DEPTH_SNAPSHOT_LIMIT},
            )
            book = self.hub.states[symbol].book
            book.apply_snapshot(payload, time.time())
            buffer = self.buffers[symbol]
            gap = False
            while buffer:
                diff = buffer.popleft()
                if int(diff.get("u", 0)) <= book.last_update_id:
                    continue
                try:
                    book.apply_diff(diff, time.time())
                except ResyncRequired:
                    gap = True
                    break
            if gap:
                self.hub.note_resync(symbol)
                retry_delay = 0.5
            else:
                book.ready = True
                self.hub.set_book_ready(symbol, True)
                if all(
                    self.hub.states[item].book.ready for item in self.symbols
                ):
                    self._clear_error("depth sync")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # network or payload error, retry
            self.hub.feed["error"] = f"depth sync {symbol}: {exc}"
            retry_delay = 30.0 if "cooling down" in str(exc) else 1.5
        finally:
            self.syncing[symbol] = False
        if retry_delay is not None:
            self._begin_sync(symbol, delay=retry_delay)

    # -- REST loops -------------------------------------------------------
    async def _rest_loop(self) -> None:
        while True:
            for symbol in self.symbols:
                await self._refresh_premium(symbol)
                await self._refresh_ticker(symbol)
                await self._refresh_open_interest(symbol)
                await self._refresh_klines(symbol)
            await asyncio.sleep(config.REST_REFRESH_S)

    async def _trade_loop(self) -> None:
        """Poll aggTrades as a fallback for environments where the futures
        aggTrade websocket stream stays silent; skipped while WS trades flow.

        The poll interval is deliberately slow and uses /fapi/v1/trades
        (weight 5) instead of /fapi/v1/aggTrades (weight 20): fast aggTrades
        polling trips Binance's 418 IP ban and then every REST path, including
        depth resync, stops until the ban expires.
        """
        limit = 1000
        while True:
            for symbol in self.symbols:
                if time.time() - self.ws_trade_ts[symbol] < 30.0:
                    continue
                try:
                    rows = await self._get(
                        "/fapi/v1/trades", {"symbol": symbol, "limit": limit}
                    )
                except Exception as exc:
                    message = str(exc)
                    if "REST 418" in message or "REST 429" in message:
                        self.hub.feed["error"] = f"rate limited: {message}"
                        await asyncio.sleep(30.0)
                    elif "cooling down" in message:
                        await asyncio.sleep(20.0)
                    continue
                if not isinstance(rows, list):
                    continue
                self._clear_error("rate limited")
                parsed = []
                for row in rows:
                    try:
                        parsed.append(
                            (
                                int(row["id"]),
                                {
                                    "p": row["price"],
                                    "q": row["qty"],
                                    "T": row["time"],
                                    "m": row["isBuyerMaker"],
                                },
                            )
                        )
                    except (KeyError, TypeError, ValueError):
                        continue
                parsed.sort(key=lambda item: item[0])
                last_id = self.trade_ids[symbol]
                fresh = [item for item in parsed if item[0] > last_id]
                if last_id == 0:
                    fresh = fresh[-600:]
                for _, payload in fresh:
                    self.hub.on_trade(symbol, payload)
                if parsed:
                    self.trade_ids[symbol] = max(last_id, parsed[-1][0])
            limit = 500
            await asyncio.sleep(config.TRADE_POLL_S)

    async def _refresh_klines(self, symbol: str) -> None:
        for interval, limit, key in (
            ("1m", config.CANDLE_1M_LIMIT + 20, "1m"),
            ("15m", config.CANDLE_15M_LIMIT + 20, "15m"),
            ("5m", config.LIQ_MAP_KLINES, "5m"),
        ):
            try:
                rows = await self._get(
                    "/fapi/v1/klines",
                    {"symbol": symbol, "interval": interval, "limit": limit},
                )
            except Exception:
                continue
            parsed = []
            for row in rows:
                try:
                    parsed.append(
                        [
                            int(row[0]),
                            float(row[1]),
                            float(row[2]),
                            float(row[3]),
                            float(row[4]),
                            float(row[5]),
                        ]
                    )
                except (IndexError, TypeError, ValueError):
                    continue
            self.hub.set_candles(symbol, key, parsed)

    async def _refresh_open_interest(self, symbol: str) -> None:
        try:
            data = await self._get("/fapi/v1/openInterest", {"symbol": symbol})
            self.hub.set_open_interest(symbol, float(data.get("openInterest", 0.0)))
        except Exception:
            pass

    async def _refresh_ticker(self, symbol: str) -> None:
        try:
            data = await self._get("/fapi/v1/ticker/24hr", {"symbol": symbol})
            self.hub.on_ticker(
                symbol,
                {
                    "c": data["lastPrice"],
                    "h": data["highPrice"],
                    "l": data["lowPrice"],
                    "P": data["priceChangePercent"],
                    "q": data["quoteVolume"],
                },
            )
        except Exception:
            pass

    async def _refresh_premium(self, symbol: str) -> None:
        try:
            data = await self._get("/fapi/v1/premiumIndex", {"symbol": symbol})
            self.hub.on_mark_price(
                symbol,
                {
                    "p": data["markPrice"],
                    "i": data["indexPrice"],
                    "r": data["lastFundingRate"],
                    "T": data["nextFundingTime"],
                },
            )
        except Exception:
            pass

    async def _get(self, path: str, params: dict) -> dict | list:
        if self.session is None:
            raise RuntimeError("feed session is not running")
        cooldown = self.rest_blocked_until - time.time()
        if cooldown > 0:
            raise ConnectionError(f"REST cooling down for {cooldown:.0f}s")
        async with self.session.get(config.FAPI_REST + path, params=params) as response:
            if response.status in (418, 429):
                retry_after = 60
                raw = response.headers.get("Retry-After")
                if raw:
                    try:
                        retry_after = max(30, int(raw))
                    except ValueError:
                        pass
                self.rest_blocked_until = time.time() + retry_after
                raise ConnectionError(
                    f"REST {response.status} for {path}; retry after {retry_after}s"
                )
            if response.status != 200:
                raise ConnectionError(f"REST {response.status} for {path}")
            return await response.json()
