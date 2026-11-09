/* MIN·RESISTANCE — static-site transport + chrome.
   Same dashboard as app.js, but the transport is a Web Worker that runs the
   Python analytics under Pyodide and fetches Binance data directly. No server,
   no polling fallback: status messages describe the browser engine instead.
   Mock mode (?mock=1) still replays ./mock/snapshot.json. */

import { Dashboard } from './views.js';
import { fmtAge, fmtClock, fmtDurationZh, fmtHMS, fmtLatencyMs, num, setClass, setTxt } from './util.js';

const IS_MOCK = new URLSearchParams(window.location.search).get('mock') === '1';
const STALE_MS = 4500;
const SNAPSHOT_WATCHDOG_MS = 12000;
const WORKER_RETRY_MS = 2000;
const MAX_WORKER_RESTARTS = 1;
const PRED_STORAGE_KEY = 'mr-predictions-v1';

const STATUS_LABEL = {
  boot: '连接中',
  live: 'LIVE 实时',
  sim: 'SIM 模拟',
  polling: '轮询降级',
  reconnecting: '重连中',
  offline: '链路中断',
  mock: 'MOCK 模拟',
};

/* Worker states → dashboard chip states. `loading` keeps the connecting chip
   up until the first ready snapshot actually arrives. */
const ENGINE_STATUS = {
  loading: 'boot',
  live: 'live',
  reconnecting: 'reconnecting',
  offline: 'offline',
};

class App {
  constructor() {
    this.dash = null;
    this.snap = null;
    this.status = '';
    this.worker = null;
    this.workerRestarts = 0;
    this.workerTimer = 0;
    this.engine = IS_MOCK ? 'mock' : 'pyodide';
    this.engineInitMs = 0;
    this.engineDetail = '';
    this.marketMode = '';
    this.marketLabel = '';
    this.feedNote = '';
    this.readyFlags = {};
    this.readyPrices = {};
    this.snapshotMs = 0;
    this.lastSnapshotAt = 0;
    this.mockTimer = 0;
    this.mockBase = null;
    this.mockTick = 0;
    this.isMock = IS_MOCK;
    this.lastRecvAt = 0;
    this.rendered = false;
    this.toastTimer = 0;
    this.actionToastUntil = 0;
    this.clockText = '';

    this.chip = document.getElementById('conn-chip');
    this.chipLabel = document.getElementById('conn-label');
    this.feedSource = document.getElementById('feed-source');
    this.latencyEl = document.getElementById('latency');
    this.ageEl = document.getElementById('data-age');
    this.clockEl = document.getElementById('clock-time');
    this.toastEl = document.getElementById('toast');
    this.toastText = document.getElementById('toast-text');
    this.foot = {
      source: document.getElementById('foot-source'),
      latency: document.getElementById('foot-latency'),
      ts: document.getElementById('foot-ts'),
      uptime: document.getElementById('foot-uptime'),
    };
  }

  start() {
    this.dash = new Dashboard(document);
    this.dash.onToast = (message, toneName) => {
      this.actionToastUntil = Date.now() + 2200;
      this.toast(message, toneName || 'muted', 2200);
    };
    window.__setWallMode = (mode) => {
      if (this.isMock) throw new Error('mock snapshot is read-only');
      if (!this.worker) throw new Error('engine not ready');
      localStorage.setItem('mr-wall-mode', mode);
      this.worker.postMessage({ type: 'wallMode', mode });
      return Promise.resolve({ ok: true });
    };
    this.tickClock();
    setInterval(() => this.tickClock(), 300);
    setInterval(() => this.tickMeta(), 400);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.snap && this.dash && this.dash.mounted) {
        this.dash.render(this.snap, { now: Date.now(), mock: this.isMock });
      }
    });
    if (this.isMock) this.startMock();
    else this.startEngine();
    this.initNav();
  }

  /* section nav: scroll lower panel into view (used by the top nav buttons) */
  initNav() {
    const hash = window.location.hash;
    if (!hash) return;
    const dash = this.dash;
    if (hash === '#depth') dash.goSection('depth');
    else if (hash === '#ledger') dash.goSection('ledger');
    else if (hash === '#events') dash.goSection('events');
  }

  /* ---------------- transport: pyodide worker ---------------- */

  startEngine() {
    if (this.workerTimer) {
      window.clearTimeout(this.workerTimer);
      this.workerTimer = 0;
    }
    if (!this.rendered) this.setStatus('boot');
    this.setBootState('connecting');
    let worker;
    try {
      worker = new Worker(new URL('./engine-worker.js', import.meta.url));
    } catch (err) {
      console.error('[min-resistance] worker unavailable', err);
      this.failEngine('Worker 不可用');
      return;
    }
    this.worker = worker;
    worker.onmessage = (event) => this.onEngineMessage(event.data);
    worker.onerror = (event) => {
      const reason = event && event.message ? event.message : 'engine worker crashed';
      console.error('[min-resistance] engine worker crashed:', reason);
      this.failEngine(reason);
    };
    worker.onmessageerror = () => this.failEngine('worker message decode error');
    worker.postMessage({
      type: 'init',
      predictions: this.readPredictions(),
      wallMode: localStorage.getItem('mr-wall-mode') || '',
    });
  }

  onEngineMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'snapshot') {
      const snap = data.snap;
      if (!snap || !snap.symbols) return;
      this.snapshotMs = num(data.snapshotMs);
      this.lastSnapshotAt = Date.now();
      this.handleSnapshot(snap, 'ws');
      this.updateMrState();
      return;
    }
    if (data.type === 'status') {
      this.engineDetail = data.detail || '';
      if (data.ready) this.readyFlags = data.ready;
      if (data.prices) this.readyPrices = data.prices;
      if (data.mode) this.marketMode = data.mode;
      if (data.marketLabel) this.marketLabel = data.marketLabel;
      this.applyEngineStatus(data.state);
      return;
    }
    if (data.type === 'engine') {
      this.engineInitMs = num(data.initMs);
      this.engine = data.engine || 'pyodide';
      console.info(
        `[min-resistance] ${this.engine} ready in ${Math.round(this.engineInitMs)}ms` +
          (data.pythonVersion ? ` · Python ${data.pythonVersion}` : '')
      );
      this.updateMrState();
      return;
    }
    if (data.type === 'pred') {
      this.writePredictions(data.data);
      return;
    }
    if (data.type === 'notice') {
      this.toast(data.text, data.tone || 'amber', num(data.duration, 6000));
      return;
    }
    if (data.type === 'log') {
      const level = data.level === 'error' ? 'error' : 'log';
      console[level](`[min-resistance] ${data.message || ''}`);
    }
  }

  applyEngineStatus(state) {
    const mapped = ENGINE_STATUS[state] || 'boot';
    this.setStatus(mapped);
    if (this.worker && !this.rendered && mapped === 'boot') this.setBootState('connecting');
    this.updateMrState();
  }

  failEngine(reason) {
    this.engineDetail = `分析引擎异常：${reason}`;
    this.terminateWorker();
    if (!this.isMock && this.workerRestarts < MAX_WORKER_RESTARTS) {
      this.workerRestarts += 1;
      console.warn(`[min-resistance] restarting engine worker (attempt ${this.workerRestarts})`);
      this.workerTimer = window.setTimeout(() => {
        this.workerTimer = 0;
        this.startEngine();
      }, WORKER_RETRY_MS);
      if (!this.rendered) this.setStatus('boot');
      return;
    }
    this.setStatus('offline');
    this.toast('浏览器分析引擎未能启动 · 请刷新页面重试', 'rose', 0);
  }

  terminateWorker() {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      /* worker already gone */
    }
    this.worker = null;
  }

  readPredictions() {
    try {
      return window.localStorage.getItem(PRED_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  writePredictions(payload) {
    if (typeof payload !== 'string' || !payload) return;
    try {
      window.localStorage.setItem(PRED_STORAGE_KEY, payload);
    } catch {
      /* storage disabled or full: persistence is best effort */
    }
  }

  updateMrState() {
    window.__mrState = {
      status: this.status,
      lastSnapshotAt: this.lastSnapshotAt,
      snapshotMs: this.snapshotMs,
      engine: this.engine,
      initMs: this.engineInitMs,
      detail: this.engineDetail,
      rendered: this.rendered,
      market: this.marketMode,
      marketLabel: this.marketLabel,
      ready: this.readyFlags,
      prices: this.readyPrices,
      note: this.feedNote,
    };
  }

  /* ---------------- mock mode ---------------- */

  async startMock() {
    this.setStatus('boot');
    try {
      const res = await fetch('./mock/snapshot.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const base = await res.json();
      if (!base || !base.symbols) throw new Error('mock snapshot malformed');
      const shift = Date.now() - num(base.ts, Date.now());
      base.ts = Date.now();
      const bumpTs = (ts) => {
        const n = num(ts);
        if (!n) return n;
        return n > 1e12 ? n + shift : n + shift / 1000;
      };
      if (Array.isArray(base.events)) base.events = base.events.map((ev) => ({ ...ev, ts: bumpTs(ev.ts) }));
      for (const key of Object.keys(base.symbols || {})) {
        const s = base.symbols[key];
        const chart = s.chart || {};
        for (const series of [chart.candles_1m, chart.candles_15m]) {
          if (Array.isArray(series)) for (const candle of series) if (Array.isArray(candle)) candle[0] = bumpTs(candle[0]);
        }
        const flow = s.flow || {};
        if (Array.isArray(flow.cvd)) for (const pt of flow.cvd) if (Array.isArray(pt)) pt[0] = bumpTs(pt[0]);
        if (Array.isArray(flow.large)) for (const tr of flow.large) tr.ts = bumpTs(tr.ts);
        const acc = s.accuracy || {};
        if (Array.isArray(acc.recent)) for (const r of acc.recent) r.ts = bumpTs(r.ts);
        const liq = s.liquidations || {};
        if (Array.isArray(liq.recent)) for (const r of liq.recent) r.ts = bumpTs(r.ts);
        if (s.prediction && s.prediction.updated_ts) s.prediction.updated_ts = bumpTs(s.prediction.updated_ts);
      }
      this.mockBase = base;
      this.mockTick = 0;
      const push = () => {
        try {
          this.pushMockFrame();
        } catch {
          /* keep the mock clock alive even on a malformed frame */
        }
      };
      push();
      this.mockTimer = window.setInterval(push, 900);
      this.toast('MOCK 模式 · 静态快照模拟推送，非真实行情', 'amber', 4200);
    } catch {
      this.setStatus('offline');
      window.setTimeout(() => this.startMock(), 2500);
    }
  }

  pushMockFrame() {
    const base = this.mockBase;
    if (!base) return;
    const now = Date.now();
    this.mockTick += 1;
    const snap = structuredClone(base);
    snap.ts = now;
    snap.mode = 'sim';
    snap.base_mode = 'mock';
    snap.uptime_s = num(snap.uptime_s) + this.mockTick * 0.9;
    snap.feed = { ...snap.feed, state: 'live', source: 'mock-static', last_msg_ts: now / 1000, last_msg_age_s: 0 };
    const wobble = Math.sin(this.mockTick / 11) * 0.6 + (Math.random() - 0.5) * 0.5;
    for (const key of snap.symbol_order || []) {
      const s = snap.symbols[key];
      if (!s) continue;
      const ob = s.orderbook || {};
      const mid = num(ob.mid, num(s.mid, num(s.price)));
      const spreadUsd = Math.max(mid * num(ob.spread_bps) * 1e-4, mid * 1e-6);
      const price = mid + wobble * spreadUsd * 2.2;
      s.price = price;
      s.updated_ts = now;
      const candles = s.chart && s.chart.candles_1m;
      if (Array.isArray(candles) && candles.length) {
        const last = candles[candles.length - 1];
        last[4] = price;
        last[2] = Math.max(num(last[2]), price);
        last[3] = Math.min(num(last[3]), price);
        last[5] = num(last[5]) + Math.random() * 1.5;
      }
      if (s.flow && Array.isArray(s.flow.cvd) && s.flow.cvd.length) {
        const tail = s.flow.cvd[s.flow.cvd.length - 1];
        tail[1] = num(tail[1]) + wobble * 1200;
      }
    }
    if (this.mockTick % 13 === 0 && snap.symbols.BTCUSDT) {
      const btc = snap.symbols.BTCUSDT;
      const kinds = ['iceberg', 'spoof', 'whale'];
      const kind = kinds[this.mockTick % kinds.length];
      snap.events = (Array.isArray(snap.events) ? snap.events : []).slice(-79);
      snap.events.push({
        ts: now,
        kind,
        symbol: 'BTCUSDT',
        display: 'BTC',
        side: kind === 'whale' ? 'buy' : 'bid',
        price: btc.price,
        usd: 260000 + Math.random() * 900000,
        note: '模拟事件 · MOCK',
      });
    }
    this.handleSnapshot(snap, 'mock');
  }

  /* ---------------- snapshot handling ---------------- */

  handleSnapshot(snap, via) {
    if (!snap || !snap.symbols) return;
    this.snap = snap;
    this.lastRecvAt = performance.now();
    if (snap.market) this.marketMode = snap.market;
    if (snap.market_label) this.marketLabel = snap.market_label;
    if (snap.feed && snap.feed.note) this.feedNote = snap.feed.note;
    const now = Date.now();
    try {
      this.dash.render(snap, { now, mock: this.isMock });
      this.rendered = true;
      document.body.classList.remove('is-booting');
    } catch (err) {
      console.error('[min-resistance] render failed', err);
    }
    this.updateChrome(snap, now);
    if (via === 'mock') this.setStatus('mock');
    else if (this.snapshotLive(snap)) this.setStatus('live');
    else if (this.status === 'live') this.setStatus('boot');
    this.updateMrState();
  }

  /* LIVE means both books are ready and each symbol has a real price. A
     partial snapshot must never flip the chip to live. */
  snapshotLive(snap) {
    const rows = snap.symbols || {};
    const order =
      Array.isArray(snap.symbol_order) && snap.symbol_order.length
        ? snap.symbol_order
        : Object.keys(rows);
    return (
      order.length > 0 &&
      order.every((sym) => {
        const row = rows[sym] || {};
        return row.ready === true && num(row.price) > 0;
      })
    );
  }

  updateChrome(snap, now) {
    const latency = Math.max(0, now - num(snap.ts, now));
    const source = (snap.feed && snap.feed.source) || '—';
    setTxt(this.feedSource, source);
    setTxt(this.latencyEl, fmtLatencyMs(latency));
    setClass(this.latencyEl, 'is-warn', latency > 1500);
    setClass(this.latencyEl, 'is-bad', latency > 3000);
    if (this.foot.source) setTxt(this.foot.source, source);
    if (this.foot.latency) setTxt(this.foot.latency, fmtLatencyMs(latency));
    if (this.foot.ts) setTxt(this.foot.ts, `${fmtHMS(num(snap.ts))} UTC+8`);
    if (this.foot.uptime) setTxt(this.foot.uptime, fmtDurationZh(num(snap.uptime_s)));
    this.tickMeta();
  }

  setStatus(state) {
    if (this.status === state) return;
    this.status = state;
    if (this.chip) this.chip.dataset.state = state === 'mock' ? 'mock' : state;
    if (this.chipLabel) setTxt(this.chipLabel, STATUS_LABEL[state] || state);
    this.syncOverlays();
    this.updateMrState();
  }

  syncOverlays() {
    if (!this.snap) {
      if (this.status === 'offline') {
        this.toast('行情链路中断 · 浏览器直连 Binance 重连中', 'rose', 0);
        this.setBootState('offline');
      } else {
        this.hideToast();
        this.setBootState('connecting');
      }
      return;
    }
    const age = Math.max(0, Date.now() - num(this.snap.ts, Date.now()));
    const stale = age > STALE_MS;
    document.body.classList.toggle('is-stale', stale);

    if (this.isMock) {
      if (Date.now() > this.actionToastUntil) this.hideToast();
      return;
    }
    if (this.status === 'offline') {
      this.toast('行情链路中断 · 浏览器直连 Binance 重连中', 'rose', 0);
      return;
    }
    if (stale) {
      this.toast(`数据延迟 ${fmtAge(age)} · 推送停滞，正在恢复`, 'amber', 0);
      return;
    }
    this.hideToast();
  }

  /* ---------------- chrome timers ---------------- */

  tickClock() {
    const text = fmtClock(Date.now());
    if (text !== this.clockText) {
      this.clockText = text;
      if (this.clockEl) this.clockEl.textContent = text;
    }
  }

  tickMeta() {
    const snap = this.snap;
    if (!snap) return;
    const now = Date.now();
    const age = Math.max(0, now - num(snap.ts, now));
    if (this.ageEl) {
      setTxt(this.ageEl, fmtAge(age));
      setClass(this.ageEl, 'is-warn', age > STALE_MS);
      setClass(this.ageEl, 'is-bad', age > 9000);
    }
    if (this.latencyEl && !this.isMock) setTxt(this.latencyEl, fmtLatencyMs(age));
    if (this.foot.latency) setTxt(this.foot.latency, fmtLatencyMs(age));

    const stale = age > STALE_MS;
    document.body.classList.toggle('is-stale', stale);

    if (
      !this.isMock &&
      this.lastSnapshotAt &&
      now - this.lastSnapshotAt > SNAPSHOT_WATCHDOG_MS &&
      this.status !== 'offline'
    ) {
      this.setStatus('polling');
    }

    if (this.status === 'offline' || stale) this.syncOverlays();
    else if (this.toastEl && !this.toastEl.hidden) this.syncOverlays();
  }

  setBootState(state) {
    const card = document.querySelector('.boot-card');
    if (!card) return;
    const title = card.querySelector('p');
    const sub = card.querySelector('em');
    if (state === 'offline') {
      card.dataset.state = 'offline';
      setTxt(title, '行情链路中断 · 自动重试中');
      setTxt(sub, '浏览器直连 BINANCE · WASM 分析引擎 · 自动重连');
    } else {
      card.dataset.state = 'connecting';
      setTxt(title, '浏览器分析引擎初始化 · BROWSER ENGINE');
      setTxt(sub, this.engineDetail || 'PYODIDE CPYTHON → WASM · BINANCE 直连 · 无后端');
    }
  }

  toast(message, tone = 'amber', duration = 0) {
    if (!this.toastEl || !this.toastText) return;
    this.toastEl.hidden = false;
    this.toastEl.dataset.tone = tone;
    setTxt(this.toastText, message);
    window.clearTimeout(this.toastTimer);
    if (duration > 0) this.toastTimer = window.setTimeout(() => this.hideToast(), duration);
  }

  hideToast() {
    if (!this.toastEl) return;
    window.clearTimeout(this.toastTimer);
    this.toastEl.hidden = true;
  }
}

window.__mrState = {
  status: 'boot',
  lastSnapshotAt: 0,
  snapshotMs: 0,
  engine: IS_MOCK ? 'mock' : 'pyodide',
  initMs: 0,
  detail: '',
  rendered: false,
  market: '',
  marketLabel: '',
  ready: {},
  prices: {},
  note: '',
};

const app = new App();
app.start();
