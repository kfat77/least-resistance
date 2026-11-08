/* MIN·RESISTANCE — static-site engine worker.
   Loads Pyodide (CPython compiled to WebAssembly), mounts the same Python
   analytics package the reference server uses from ./py/server, and feeds it
   with Binance USDⓈ-M market data fetched directly by the browser.
   Posts one full snapshot to the page every 900 ms.

   Classic worker on purpose: Pyodide is loaded with importScripts, and the
   module stays usable without any build step. */

'use strict';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const TICK_MS = 900;
const REST_TIMEOUT_MS = 8000;
const REST_REFRESH_MS = 30000;
const TRADE_POLL_MS = 6000;
const TRADE_FALLBACK_AFTER_MS = 30000;
const DEPTH_IDLE_RECONNECT_MS = 15000;
const WS_IDLE_RECONNECT_MS = 25000;
const WATCHDOG_MS = 5000;
const RESYNC_RETRY_MS = 1500;
const RESYNC_GAP_RETRY_MS = 500;
const RESYNC_COOLDOWN_MS = 30000;
const DEPTH_LIMIT = 1000;
const DEPTH_STREAM_SPEED = '100ms';
const DEPTH_BUFFER_MAX = 8000;
const WS_BACKOFF_START_MS = 1000;
const WS_BACKOFF_MAX_MS = 8000;
const SPOT_BACKOFF_START_MS = 1000;
const SPOT_BACKOFF_MAX_MS = 10000;
const PARTIAL_SNAPSHOT_AFTER_MS = 20000;
const FAPI_REST = 'https://fapi.binance.com';
const FUTURES_WS_BASE = 'wss://fstream.binance.com/stream?streams=';
const SPOT_WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';
const DATA_API_REST = 'https://data-api.binance.vision';
const DATA_API_WS_BASE = 'wss://data-stream.binance.vision/stream?streams=';
const PROBE_TIMEOUT_MS = 5000;

/* Two interchangeable data sources. USDⓈ-M futures is preferred because it
   carries funding/mark price/open interest and real liquidation orders; the
   public spot feed at data-api.binance.vision is the fallback when fapi and
   fstream are unreachable from the visitor's network. */
const SOURCE_FUTURES = {
  mode: 'futures',
  market: 'futures',
  label: 'USDⓈ-M PERP',
  feedSource: 'binance-usdm',
  rest: FAPI_REST,
  prefix: '/fapi/v1',
  ws: FUTURES_WS_BASE,
  derivatives: true,
};
const SOURCE_SPOT = {
  mode: 'spot',
  market: 'spot',
  label: '现货 SPOT',
  feedSource: 'binance-spot',
  rest: DATA_API_REST,
  prefix: '/api/v3',
  ws: DATA_API_WS_BASE,
  derivatives: false,
};
let source = SOURCE_FUTURES;

const PYODIDE_DIR = new URL('../vendor/pyodide/', self.location).href;
const PYODIDE_SCRIPT = new URL('../vendor/pyodide/pyodide.js', self.location).href;
const PY_SERVER_DIR = new URL('../py/server/', self.location).href;
const PY_FILES = ['config', 'book', 'analytics', 'predictor', 'hub'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pyodide = null;
let api = null;
let engineInitMs = 0;
let closing = false;

let lastStatus = '';
let lastDetail = '';
let lastSnapshotAt = 0;
let snapshotMs = 0;
let snapshotBusy = false;
let allowPartial = false;
let lastPredCount = -1;
let pendingPredictions = null;

let ws = null;
let wsOpen = false;
let wsFailures = 0;
let reconnectTimer = 0;
let lastFuturesMsgAt = 0;
let lastDepthAt = 0;
let restLoopsStarted = false;
let restBlockedUntil = 0;
let lastRestBlockAt = 0;

const buffers = {};
const syncing = {};
const booksReady = {};
const depthUid = {};
const lastWSTrade = {};
const tradeCursor = {};

let spotWs = null;
let spotOpen = false;
let spotFailures = 0;
let spotReconnectTimer = 0;
const spotMid = {};
const pendingSpotTrades = [];

for (const symbol of SYMBOLS) {
  buffers[symbol] = [];
  syncing[symbol] = false;
  booksReady[symbol] = false;
  depthUid[symbol] = 0;
  lastWSTrade[symbol] = 0;
  tradeCursor[symbol] = 0;
  spotMid[symbol] = 0;
}

/* ------------------------------------------------------------------ */
/* messaging                                                           */
/* ------------------------------------------------------------------ */

function readyInfo() {
  const ready = {};
  const prices = {};
  for (const symbol of SYMBOLS) {
    prices[symbol] = api ? Number(api.bookMid(symbol)) || 0 : 0;
    ready[symbol] = !!(booksReady[symbol] && prices[symbol] > 0);
  }
  return { mode: source.mode, market: source.market, marketLabel: source.label, ready, prices };
}

function postStatus(state, detail) {
  const text = detail || '';
  if (state === lastStatus && text === lastDetail) return;
  lastStatus = state;
  lastDetail = text;
  self.postMessage({ type: 'status', state, detail: text, engine: 'pyodide', ...readyInfo() });
}

function postNotice(text, tone, duration) {
  self.postMessage({ type: 'notice', text, tone: tone || 'amber', duration: duration || 6000 });
}

function logError(scope, err) {
  const message = err && err.message ? err.message : String(err);
  self.postMessage({ type: 'log', level: 'error', message: `${scope}: ${message}` });
}

self.onmessage = (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'init') {
    pendingPredictions = typeof data.predictions === 'string' ? data.predictions : null;
    applyPredictions();
  }
};

/* ------------------------------------------------------------------ */
/* python bootstrap                                                     */
/* ------------------------------------------------------------------ */

const BRIDGE_SOURCE = [
  'import json, os, sys, time',
  'import pathlib',
  '',
  "os.makedirs('/app/server', exist_ok=True)",
  "os.makedirs('/app/data/live', exist_ok=True)",
  "if '/app' not in sys.path:",
  "    sys.path.insert(0, '/app')",
  '',
  'import server.config as config',
  "config.DATA_DIR = pathlib.Path('/app/data')",
  '',
  'from server import hub as hub_module',
  'from server.book import ResyncRequired',
  '',
  "hub = hub_module.MarketHub('live')",
  "hub.set_mode('live', 'browser-binance')",
  '',
  '_spot_state = "connecting"',
  "_market = {'mode': 'futures', 'label': 'USDⓈ-M PERP', 'feed_source': 'binance-usdm', 'note': ''}",
  '',
  'def _state(sym):',
  '    return hub.states.get(sym)',
  '',
  "def api_depth_snapshot(sym, payload_text):",
  '    state = _state(sym)',
  '    if state is None:',
  "        return 'resync'",
  '    try:',
  '        state.book.apply_snapshot(json.loads(payload_text), time.time())',
  "        return ''",
  '    except Exception:',
  "        return 'resync'",
  '',
  "def api_depth_diff(sym, payload_text):",
  '    state = _state(sym)',
  '    if state is None:',
  "        return 'resync'",
  '    try:',
  '        diff = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    try:',
  '        state.book.apply_diff(diff, time.time())',
  "        return ''",
  '    except ResyncRequired:',
  "        return 'resync'",
  '    except Exception:',
  "        return 'resync'",
  '',
  "def api_trade(sym, payload_text):",
  '    try:',
  '        payload = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    hub.on_trade(sym, payload)',
  "    return ''",
  '',
  "def api_ticker(sym, payload_text):",
  '    try:',
  '        payload = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    hub.on_ticker(sym, payload)',
  "    return ''",
  '',
  "def api_mark(sym, payload_text):",
  '    try:',
  '        payload = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    hub.on_mark_price(sym, payload)',
  "    return ''",
  '',
  "def api_force(payload_text):",
  '    try:',
  '        payload = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    hub.on_force_order(payload)',
  "    return ''",
  '',
  "def api_candles(sym, interval, payload_text):",
  '    try:',
  '        rows = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    hub.set_candles(sym, interval, rows)',
  "    return ''",
  '',
  "def api_oi(sym, value):",
  '    try:',
  '        hub.set_open_interest(sym, float(value))',
  '    except (TypeError, ValueError):',
  '        pass',
  "    return ''",
  '',
  "def api_book_ready(sym, ready):",
  '    state = _state(sym)',
  '    if state is not None:',
  '        state.book.ready = bool(ready)',
  '    hub.set_book_ready(sym, bool(ready))',
  "    return ''",
  '',
  "def api_book_ticker(sym, bid, ask):",
  '    state = _state(sym)',
  '    if state is not None and float(bid) > 0 and float(ask) > 0:',
  "        state.ticker['last'] = (float(bid) + float(ask)) / 2.0",
  "    return ''",
  '',
  'def api_book_mid(sym):',
  '    state = _state(sym)',
  '    if state is None:',
  '        return 0.0',
  '    mid = state.book.mid()',
  '    return float(mid) if mid else 0.0',
  '',
  "def api_note(sym):",
  '    hub.note_message(sym)',
  "    return ''",
  '',
  "def api_note_resync(sym):",
  '    hub.note_resync(sym)',
  "    return ''",
  '',
  'def api_note_reconnect(sym):',
  '    hub.note_reconnect(sym or None)',
  "    return ''",
  '',
  "def api_set_spot(state_text):",
  '    global _spot_state',
  '    _spot_state = str(state_text)',
  "    return ''",
  '',
  'def api_set_market(mode, label, feed_source, note):',
  '    global _market',
  "    _market = {'mode': str(mode), 'label': str(label),",
  "               'feed_source': str(feed_source), 'note': str(note or '')}",
  "    hub.set_mode('live', _market['feed_source'])",
  "    return ''",
  '',
  'def api_snapshot():',
  '    now = time.time()',
  "    hub.feed['state'] = 'live'",
  "    hub.feed['last_msg_ts'] = now",
  "    hub.feed['spot'] = _spot_state",
  '    snap = hub.snapshot()',
  "    feed = snap['feed']",
  "    feed['state'] = 'live'",
  "    feed['source'] = _market['feed_source']",
  "    feed['note'] = _market['note']",
  "    feed['last_msg_ts'] = now",
  "    feed['last_msg_age_s'] = 0",
  "    snap['mode'] = 'live'",
  "    snap['market'] = _market['mode']",
  "    snap['market_label'] = _market['label']",
  "    snap['uptime_s'] = round(now - hub.started, 1)",
  "    if _market['mode'] == 'spot':",
  '        for row in snap["symbols"].values():',
  "            row['mark_price'] = None",
  "            row['index_price'] = None",
  "            row['funding_rate'] = None",
  "            row['next_funding_ts'] = None",
  "            row['open_interest'] = None",
  '    return json.dumps(snap, ensure_ascii=False)',
  '',
  'def api_pred_dump():',
  '    data = {}',
  '    for sym, state in hub.states.items():',
  '        data[sym] = state.ledger.entries',
  '    return json.dumps(data, ensure_ascii=False)',
  '',
  'def api_pred_load(payload_text):',
  '    try:',
  '        data = json.loads(payload_text)',
  '    except ValueError:',
  "        return ''",
  '    if not isinstance(data, dict):',
  "        return ''",
  '    for sym, rows in data.items():',
  '        state = _state(sym)',
  '        if state is None or not isinstance(rows, list) or not rows:',
  '            continue',
  '        try:',
  '            ledger = state.ledger',
  '            ledger.path.parent.mkdir(parents=True, exist_ok=True)',
  "            ledger.path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')",
  '            ledger.entries = []',
  '            ledger._load()',
  '        except Exception:',
  '            continue',
  "    return ''",
].join('\n');

const BRIDGE_NAMES = [
  ['depthSnapshot', 'api_depth_snapshot'],
  ['depthDiff', 'api_depth_diff'],
  ['trade', 'api_trade'],
  ['ticker', 'api_ticker'],
  ['mark', 'api_mark'],
  ['force', 'api_force'],
  ['candles', 'api_candles'],
  ['oi', 'api_oi'],
  ['bookReady', 'api_book_ready'],
  ['bookTicker', 'api_book_ticker'],
  ['bookMid', 'api_book_mid'],
  ['note', 'api_note'],
  ['noteResync', 'api_note_resync'],
  ['noteReconnect', 'api_note_reconnect'],
  ['setSpot', 'api_set_spot'],
  ['setMarket', 'api_set_market'],
  ['snapshot', 'api_snapshot'],
  ['predDump', 'api_pred_dump'],
  ['predLoad', 'api_pred_load'],
];

async function loadPythonModuleSources() {
  const entries = await Promise.all(
    PY_FILES.map(async (name) => {
      const url = `${PY_SERVER_DIR}${name}.py`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${name}.py HTTP ${response.status}`);
      return [name, await response.text()];
    })
  );
  return entries;
}

async function probeRest(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return response.ok || response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function probeWs(url) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    try {
      socket = new WebSocket(url);
    } catch {
      finish(false);
      return;
    }
    socket.onopen = () => finish(true);
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });
}

/* Prefer USDⓈ-M futures; fall back to the public spot feed when fapi/fstream
   are unreachable (both REST and WS must answer for futures mode). */
async function detectSource() {
  postStatus('loading', '探测 BINANCE 数据源 · FUTURES / SPOT');
  const [restOk, wsOk] = await Promise.all([
    probeRest(`${FAPI_REST}/fapi/v1/ping`),
    probeWs(`${FUTURES_WS_BASE}btcusdt@depth@100ms`),
  ]);
  if (restOk && wsOk) return SOURCE_FUTURES;
  return SOURCE_SPOT;
}

async function initEngine() {
  const started = performance.now();
  const sourceProbe = detectSource();
  postStatus('loading', '加载分析引擎 · PYODIDE CPYTHON/WASM');

  importScripts(PYODIDE_SCRIPT);
  if (typeof self.loadPyodide !== 'function') throw new Error('loadPyodide missing');
  postStatus('loading', '加载 CPython/WASM 运行时 · 首次约 5–15 秒');
  pyodide = await self.loadPyodide({ indexURL: PYODIDE_DIR });

  const sources = await loadPythonModuleSources();
  pyodide.FS.mkdirTree('/app/server');
  pyodide.FS.mkdirTree('/app/data/live');
  pyodide.FS.writeFile('/app/server/__init__.py', '');
  for (const [name, source] of sources) {
    pyodide.FS.writeFile(`/app/server/${name}.py`, source, { encoding: 'utf8' });
  }

  postStatus('loading', '挂载 server/*.py · 初始化 MARKET HUB');
  pyodide.runPython(BRIDGE_SOURCE);

  const bridge = {};
  for (const [key, globalName] of BRIDGE_NAMES) {
    const fn = pyodide.globals.get(globalName);
    if (typeof fn !== 'function') throw new Error(`bridge ${globalName} missing`);
    bridge[key] = fn;
  }
  api = bridge;
  engineInitMs = Math.round(performance.now() - started);
  applyPredictions();
  self.postMessage({
    type: 'engine',
    engine: 'pyodide',
    initMs: engineInitMs,
    pythonVersion: pyodide.runPython('import platform; platform.python_version()'),
  });

  setTimeout(() => {
    allowPartial = true;
  }, PARTIAL_SNAPSHOT_AFTER_MS);

  source = await sourceProbe;
  const note =
    source.mode === 'spot'
      ? 'FAPI/FSTREAM 不可达 · 已切换 BINANCE 公共现货行情；资金费率 / 标记价格 / 持仓量 / 强平不可用，清算地图为 K 线估算'
      : '';
  api.setMarket(source.mode, source.label, source.feedSource, note);
  postStatus('loading', `数据源 · ${source.label} · 建立订单簿`);

  connectMarket();
  if (source.derivatives) connectSpot();
  startWatchdog();
  startSnapshotLoop();
}

function applyPredictions() {
  if (!api || !pendingPredictions) return;
  try {
    api.predLoad(pendingPredictions);
    lastPredCount = -1;
  } catch (err) {
    logError('restore predictions', err);
  }
  pendingPredictions = null;
}

/* ------------------------------------------------------------------ */
/* REST helpers                                                         */
/* ------------------------------------------------------------------ */

function restUrl(path, params) {
  const url = new URL(source.rest + source.prefix + path);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

function restCooldownLeft() {
  return restBlockedUntil - Date.now();
}

async function restGet(path, params) {
  const cooldown = restCooldownLeft();
  if (cooldown > 0) {
    throw new Error(`REST cooling down for ${Math.ceil(cooldown / 1000)}s`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(restUrl(path, params), {
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`network ${err && err.name ? err.name : 'error'}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 418 || response.status === 429) {
    let retryAfter = 60;
    const raw = response.headers.get('retry-after');
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed)) retryAfter = Math.max(30, parsed);
    }
    restBlockedUntil = Date.now() + retryAfter * 1000;
    reportRestBlock(retryAfter);
    throw new Error(`REST ${response.status}; retry after ${retryAfter}s`);
  }
  if (!response.ok) throw new Error(`REST ${response.status} for ${path}`);
  return response.json();
}

function reportRestBlock(retryAfter) {
  const now = Date.now();
  if (now - lastRestBlockAt < 10000) return;
  lastRestBlockAt = now;
  postStatus(
    lastStatus === 'live' ? 'live' : 'loading',
    `BINANCE REST 限速 · 全部请求暂停 ${retryAfter}s`
  );
  postNotice(
    `BINANCE REST 限速 (418/429) · 所有 REST 请求暂停 ${retryAfter} 秒后自动恢复；WS 行情不受影响`,
    'amber',
    8000
  );
}

function noteRestError(scope, err) {
  const message = err && err.message ? err.message : String(err);
  if (!/REST (418|429)|cooling down/.test(message)) return;
  if (lastStatus === 'live') return;
  postStatus('loading', `待同步 · ${scope}：${message}`);
}

async function refreshMarket(symbol) {
  try {
    const data = await restGet('/ticker/24hr', { symbol });
    api.ticker(
      symbol,
      JSON.stringify({
        c: data.lastPrice,
        h: data.highPrice,
        l: data.lowPrice,
        P: data.priceChangePercent,
        q: data.quoteVolume,
      })
    );
  } catch (err) {
    noteRestError(`ticker ${symbol}`, err);
  }
  if (!source.derivatives) return;
  try {
    const data = await restGet('/premiumIndex', { symbol });
    api.mark(
      symbol,
      JSON.stringify({
        p: data.markPrice,
        i: data.indexPrice,
        r: data.lastFundingRate,
        T: data.nextFundingTime,
      })
    );
  } catch (err) {
    noteRestError(`premium ${symbol}`, err);
  }
  try {
    const data = await restGet('/openInterest', { symbol });
    api.oi(symbol, Number(data.openInterest) || 0);
  } catch (err) {
    noteRestError(`oi ${symbol}`, err);
  }
}

async function refreshKlines(symbol) {
  for (const [interval, limit] of [
    ['1m', 180],
    ['15m', 96],
    ['5m', 288],
  ]) {
    try {
      const rows = await restGet('/klines', { symbol, interval, limit });
      const parsed = [];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!Array.isArray(row) || row.length < 6) continue;
          parsed.push([
            Number(row[0]),
            Number(row[1]),
            Number(row[2]),
            Number(row[3]),
            Number(row[4]),
            Number(row[5]),
          ]);
        }
      }
      api.candles(symbol, interval, JSON.stringify(parsed));
    } catch (err) {
      noteRestError(`klines ${symbol} ${interval}`, err);
    }
  }
}

async function refreshAllMarket() {
  for (const symbol of SYMBOLS) {
    if (closing) return;
    await refreshMarket(symbol);
    await refreshKlines(symbol);
  }
}

async function pollTradesFallback() {
  const now = Date.now();
  for (const symbol of SYMBOLS) {
    if (closing) return;
    if (now - lastWSTrade[symbol] < TRADE_FALLBACK_AFTER_MS) continue;
    let rows;
    try {
      rows = await restGet('/trades', { symbol, limit: 500 });
    } catch (err) {
      noteRestError(`trades ${symbol}`, err);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    const parsed = [];
    for (const row of rows) {
      try {
        parsed.push({
          id: Number(row.id),
          p: row.price,
          q: row.qty,
          T: row.time,
          m: row.isBuyerMaker,
        });
      } catch {
        /* malformed row from the REST payload */
      }
    }
    parsed.sort((a, b) => a.id - b.id);
    const cursor = tradeCursor[symbol];
    let fresh = parsed.filter((row) => row.id > cursor);
    if (cursor === 0) fresh = fresh.slice(-300);
    for (const row of fresh) {
      api.trade(symbol, JSON.stringify({ p: row.p, q: row.q, T: row.T, m: row.m }));
    }
    if (parsed.length) {
      tradeCursor[symbol] = Math.max(cursor, parsed[parsed.length - 1].id);
    }
  }
}

function startRestLoops() {
  if (restLoopsStarted) return;
  restLoopsStarted = true;
  refreshAllMarket();
  (async () => {
    while (!closing) {
      await sleep(REST_REFRESH_MS);
      if (closing) break;
      await refreshAllMarket();
    }
  })();
  (async () => {
    while (!closing) {
      await sleep(TRADE_POLL_MS);
      if (closing) break;
      await pollTradesFallback();
    }
  })();
}

/* ------------------------------------------------------------------ */
/* futures websocket + order-book sync                                  */
/* ------------------------------------------------------------------ */

function marketStreams() {
  const streams = [];
  for (const symbol of SYMBOLS) {
    const lower = symbol.toLowerCase();
    streams.push(`${lower}@depth@${DEPTH_STREAM_SPEED}`);
    streams.push(`${lower}@aggTrade`);
    streams.push(`${lower}@bookTicker`);
    if (source.derivatives) {
      streams.push(`${lower}@ticker`);
      streams.push(`${lower}@markPrice@1s`);
    }
  }
  if (source.derivatives) streams.push('!forceOrder@arr');
  return streams;
}

function connectMarket() {
  if (closing) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  let socket;
  try {
    socket = new WebSocket(source.ws + marketStreams().join('/'));
  } catch (err) {
    logError('market socket', err);
    scheduleReconnect();
    return;
  }
  ws = socket;
  wsOpen = false;
  socket.onopen = () => {
    if (ws !== socket) return;
    wsOpen = true;
    wsFailures = 0;
    lastFuturesMsgAt = Date.now();
    lastDepthAt = Date.now();
    for (const symbol of SYMBOLS) {
      buffers[symbol].length = 0;
      syncing[symbol] = false;
      booksReady[symbol] = false;
      depthUid[symbol] = 0;
      api.bookReady(symbol, false);
    }
    postStatus('loading', `建立订单簿 · ${source.label} · REST SNAPSHOT 1000 档 + 深度增量`);
    for (const symbol of SYMBOLS) beginSync(symbol, 0);
    startRestLoops();
  };
  socket.onmessage = (event) => {
    try {
      onMarketMessage(event.data);
    } catch (err) {
      logError('market dispatch', err);
    }
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* socket already closed */
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    wsOpen = false;
    if (closing) return;
    for (const symbol of SYMBOLS) {
      booksReady[symbol] = false;
      depthUid[symbol] = 0;
      api.bookReady(symbol, false);
    }
    api.noteReconnect('');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (closing || reconnectTimer) return;
  wsFailures += 1;
  const delay = Math.min(
    WS_BACKOFF_START_MS * Math.pow(1.6, Math.min(wsFailures - 1, 6)),
    WS_BACKOFF_MAX_MS
  );
  postStatus(
    wsFailures >= 3 ? 'offline' : 'reconnecting',
    `行情 WS 重建链路 · 第 ${wsFailures} 次 · ${Math.round(delay)}ms 后重试`
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    connectMarket();
  }, delay);
}

function forceReconnect() {
  const socket = ws;
  ws = null;
  wsOpen = false;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* socket already closed */
    }
  }
  scheduleReconnect();
}

function startWatchdog() {
  setInterval(() => {
    if (closing || !api) return;
    const now = Date.now();
    if (wsOpen && lastDepthAt && now - lastDepthAt > DEPTH_IDLE_RECONNECT_MS) {
      postStatus(
        'reconnecting',
        `深度流 ${Math.round((now - lastDepthAt) / 1000)}s 无推送 · 重建 WS`
      );
      forceReconnect();
      return;
    }
    if (wsOpen && lastFuturesMsgAt && now - lastFuturesMsgAt > WS_IDLE_RECONNECT_MS) {
      postStatus(
        'reconnecting',
        `行情流 ${Math.round((now - lastFuturesMsgAt) / 1000)}s 无消息 · 重建 WS`
      );
      forceReconnect();
      return;
    }
    if (!ws && !reconnectTimer) scheduleReconnect();
  }, WATCHDOG_MS);
}

function onMarketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const stream = message.stream || '';
  const data = message.data;
  if (!data || typeof data !== 'object') return;
  lastFuturesMsgAt = Date.now();
  if (stream === '!forceOrder@arr') {
    api.force(JSON.stringify(data));
    return;
  }
  const symbol = data.s;
  if (!SYMBOLS.includes(symbol)) return;
  if (stream.indexOf('@depth') !== -1) {
    onDepth(symbol, data);
  } else if (stream.endsWith('@aggTrade')) {
    lastWSTrade[symbol] = Date.now();
    api.trade(symbol, JSON.stringify(data));
  } else if (stream.endsWith('@ticker')) {
    api.ticker(symbol, JSON.stringify(data));
  } else if (stream.indexOf('@markPrice') !== -1) {
    api.mark(symbol, JSON.stringify(data));
  } else if (stream.endsWith('@bookTicker')) {
    const bid = Number(data.b);
    const ask = Number(data.a);
    if (bid > 0 && ask > 0) api.bookTicker(symbol, bid, ask);
  } else {
    return;
  }
  api.note(symbol);
}

function onDepth(symbol, payload) {
  lastDepthAt = Date.now();
  if (syncing[symbol] || !booksReady[symbol]) {
    const buffer = buffers[symbol];
    buffer.push(payload);
    if (buffer.length > DEPTH_BUFFER_MAX) buffer.shift();
    return;
  }
  if (!source.derivatives) {
    const U = Number(payload.U) || 0;
    const u = Number(payload.u) || 0;
    const prev = depthUid[symbol] || 0;
    if (!(u > 0) || !(prev > 0)) return;
    if (u <= prev) return;
    /* Spot diff events carry no `pu`, so the continuity rule is enforced here:
       every new event must start exactly where the previous one ended. */
    if (U !== prev + 1) {
      api.noteResync(symbol);
      beginSync(symbol, 0);
      return;
    }
  }
  const result = api.depthDiff(symbol, JSON.stringify(payload));
  if (result === 'resync') {
    api.noteResync(symbol);
    beginSync(symbol, 300);
    return;
  }
  if (!source.derivatives) depthUid[symbol] = Number(payload.u) || depthUid[symbol];
}

function beginSync(symbol, delayMs) {
  if (syncing[symbol]) return;
  syncing[symbol] = true;
  booksReady[symbol] = false;
  api.bookReady(symbol, false);
  if (delayMs > 0) setTimeout(() => syncOnce(symbol), delayMs);
  else syncOnce(symbol);
}

async function syncOnce(symbol) {
  let retryMs = null;
  try {
    const payload = await restGet('/depth', {
      symbol,
      limit: DEPTH_LIMIT,
    });
    if (!payload || typeof payload !== 'object') throw new Error('empty depth snapshot');
    const snapshotResult = api.depthSnapshot(symbol, JSON.stringify(payload));
    if (snapshotResult === 'resync') throw new Error('snapshot rejected by book');
    const lastUpdateId = Number(payload.lastUpdateId) || 0;
    const buffer = buffers[symbol];
    let prev = lastUpdateId;
    let first = true;
    let gap = false;
    while (buffer.length) {
      const diff = buffer.shift();
      const U = Number(diff.U) || 0;
      const u = Number(diff.u) || 0;
      if (u <= prev) continue;
      if (source.derivatives) {
        if (api.depthDiff(symbol, JSON.stringify(diff)) === 'resync') {
          gap = true;
          break;
        }
        continue;
      }
      /* Spot: replay only a contiguous chain starting at the snapshot id. */
      if (first) {
        if (!(U <= lastUpdateId + 1 && lastUpdateId + 1 <= u)) {
          gap = true;
          break;
        }
      } else if (U !== prev + 1) {
        gap = true;
        break;
      }
      if (api.depthDiff(symbol, JSON.stringify(diff)) === 'resync') {
        gap = true;
        break;
      }
      prev = u;
      first = false;
    }
    if (gap) {
      api.noteResync(symbol);
      retryMs = RESYNC_GAP_RETRY_MS;
    } else {
      depthUid[symbol] = prev;
      booksReady[symbol] = true;
      api.bookReady(symbol, true);
    }
  } catch (err) {
    api.bookReady(symbol, false);
    const message = err && err.message ? err.message : String(err);
    retryMs = /cooling down/.test(message) ? RESYNC_COOLDOWN_MS : RESYNC_RETRY_MS;
    if (lastStatus !== 'live') {
      postStatus('loading', `订单簿同步重试 · ${symbol} · ${message}`);
    }
    logError(`depth sync ${symbol}`, err);
  } finally {
    syncing[symbol] = false;
  }
  if (retryMs !== null) beginSync(symbol, retryMs);
}

function allBooksReady() {
  return SYMBOLS.every((symbol) => booksReady[symbol]);
}

/* LIVE is only claimed from a complete snapshot: both order books ready and a
   real price for each symbol. Anything less stays connecting. */
function updateLiveStatus(snap) {
  const rows = (snap && snap.symbols) || {};
  const readyAll = SYMBOLS.every((symbol) => {
    const row = rows[symbol] || {};
    return row.ready === true && Number(row.price) > 0;
  });
  if (readyAll) {
    if (lastStatus === 'live') return;
    postStatus('live', `${source.label} · 深度 + 成交 · PYODIDE ${Math.round(engineInitMs)}ms`);
    if (source.derivatives) flushPendingSpotTrades();
    return;
  }
  if (lastStatus === 'live') {
    postStatus('reconnecting', '订单簿重新同步 · 等待完整快照');
  } else if (lastStatus !== 'loading' && lastStatus !== 'offline') {
    postStatus('loading', '等待完整订单簿快照 · BOOK SYNC');
  }
}

/* ------------------------------------------------------------------ */
/* spot websocket (trade tape + spot mid)                               */
/* ------------------------------------------------------------------ */

function connectSpot() {
  if (closing) return;
  clearTimeout(spotReconnectTimer);
  spotReconnectTimer = 0;
  const streams = [];
  for (const symbol of SYMBOLS) {
    const lower = symbol.toLowerCase();
    streams.push(`${lower}@aggTrade`);
    streams.push(`${lower}@bookTicker`);
  }
  let socket;
  try {
    socket = new WebSocket(SPOT_WS_BASE + streams.join('/'));
  } catch (err) {
    logError('spot socket', err);
    scheduleSpotReconnect();
    return;
  }
  spotWs = socket;
  spotOpen = false;
  socket.onopen = () => {
    if (spotWs !== socket) return;
    spotOpen = true;
    spotFailures = 0;
    api.setSpot('live');
  };
  socket.onmessage = (event) => {
    try {
      onSpotMessage(event.data);
    } catch (err) {
      logError('spot dispatch', err);
    }
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* socket already closed */
    }
  };
  socket.onclose = () => {
    if (spotWs !== socket) return;
    spotWs = null;
    spotOpen = false;
    if (closing) return;
    api.setSpot('reconnecting');
    scheduleSpotReconnect();
  };
}

function scheduleSpotReconnect() {
  if (closing || spotReconnectTimer) return;
  spotFailures += 1;
  const delay = Math.min(
    SPOT_BACKOFF_START_MS * Math.pow(1.6, Math.min(spotFailures - 1, 6)),
    SPOT_BACKOFF_MAX_MS
  );
  spotReconnectTimer = setTimeout(() => {
    spotReconnectTimer = 0;
    connectSpot();
  }, delay);
}

function onSpotMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const stream = message.stream || '';
  const data = message.data;
  if (!data || typeof data !== 'object') return;
  const symbol = data.s;
  if (!SYMBOLS.includes(symbol)) return;
  if (stream.endsWith('@bookTicker')) {
    const bid = Number(data.b);
    const ask = Number(data.a);
    if (bid > 0 && ask > 0) spotMid[symbol] = (bid + ask) / 2;
    return;
  }
  if (!stream.endsWith('@aggTrade')) return;
  const spotPrice = Number(data.p);
  if (!(spotPrice > 0)) return;
  const futuresMid = Number(api.bookMid(symbol)) || 0;
  const spotPx = spotMid[symbol] || 0;
  if (futuresMid > 0 && spotPx > 0) {
    dispatchSpotTrade(symbol, data, spotPrice * (futuresMid / spotPx));
    return;
  }
  pendingSpotTrades.push({ symbol, data, spotPrice });
  if (pendingSpotTrades.length > 500) pendingSpotTrades.shift();
}

function dispatchSpotTrade(symbol, data, price) {
  lastWSTrade[symbol] = Date.now();
  api.trade(
    symbol,
    JSON.stringify({
      p: String(price),
      q: data.q,
      T: data.T,
      m: data.m,
    })
  );
}

function flushPendingSpotTrades() {
  if (!pendingSpotTrades.length) return;
  const queue = pendingSpotTrades.splice(0);
  for (const item of queue) {
    const futuresMid = Number(api.bookMid(item.symbol)) || 0;
    const spotPx = spotMid[item.symbol] || 0;
    if (!(futuresMid > 0) || !(spotPx > 0)) continue;
    dispatchSpotTrade(item.symbol, item.data, item.spotPrice * (futuresMid / spotPx));
  }
}

/* ------------------------------------------------------------------ */
/* snapshot loop                                                        */
/* ------------------------------------------------------------------ */

function startSnapshotLoop() {
  const tick = () => {
    if (closing || snapshotBusy || !api) return;
    if (!allowPartial && !allBooksReady()) return;
    snapshotBusy = true;
    try {
      const started = performance.now();
      const text = api.snapshot();
      const snap = JSON.parse(text);
      snapshotMs = Math.round(performance.now() - started);
      lastSnapshotAt = Date.now();
      self.postMessage({ type: 'snapshot', snap, snapshotMs, engine: 'pyodide' });
      persistPredictionsIfChanged(snap);
      updateLiveStatus(snap);
    } catch (err) {
      logError('snapshot build', err);
    } finally {
      snapshotBusy = false;
    }
  };
  tick();
  setInterval(tick, TICK_MS);
}

function persistPredictionsIfChanged(snap) {
  let count = 0;
  const symbols = (snap && snap.symbols) || {};
  for (const symbol of SYMBOLS) {
    const accuracy = (symbols[symbol] || {}).accuracy || {};
    count += Number(accuracy.logged) || 0;
  }
  if (count === lastPredCount) return;
  lastPredCount = count;
  try {
    self.postMessage({ type: 'pred', data: api.predDump() });
  } catch (err) {
    logError('prediction dump', err);
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                 */
/* ------------------------------------------------------------------ */

initEngine().catch((err) => {
  logError('engine init', err);
  postStatus(
    'offline',
    `分析引擎初始化失败 · ${err && err.message ? err.message : err}`
  );
});
