/* MIN·RESISTANCE — transport + chrome: WebSocket with exponential backoff,
   polling fallback, mock simulation (?mock=1), stale detection, clock and status. */

import { Dashboard } from './views.js';
import { fmtAge, fmtClock, fmtDurationZh, fmtHMS, fmtLatencyMs, num, setClass, setTxt } from './util.js';

const IS_MOCK = new URLSearchParams(window.location.search).get('mock') === '1';
const POLL_MS = 1800;
const BACKOFF_MS = [700, 1100, 1700, 2600, 3800, 6000];
const STALE_MS = 4500;
const WS_WATCHDOG_MS = 7000;

const STATUS_LABEL = {
  boot: '连接中',
  live: 'LIVE 实时',
  sim: 'SIM 模拟',
  polling: '轮询降级',
  reconnecting: '重连中',
  offline: '链路中断',
  mock: 'MOCK 模拟',
};

class App {
  constructor() {
    this.dash = null;
    this.snap = null;
    this.status = '';
    this.ws = null;
    this.wsOpen = false;
    this.backoffIdx = 0;
    this.reconnectTimer = 0;
    this.pollTimer = 0;
    this.mockTimer = 0;
    this.mockBase = null;
    this.mockTick = 0;
    this.isMock = IS_MOCK;
    this.lastRecvAt = 0;
    this.lastWsMsgAt = 0;
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
    window.__setWallMode = async (mode) => {
      if (this.isMock) throw new Error('mock snapshot is read-only');
      const res = await fetch('/api/wall-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'wall mode switch failed');
      this.toast(`墙模式已切换 · ${mode === 'magnet' ? '磁铁' : '障碍'}`, 'amber', 2400);
      return data;
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
    else this.connectWS(true);
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

  /* ---------------- transport ---------------- */

  connectWS(first) {
    if (first && !this.rendered) this.setStatus('boot');
    const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const url = `${proto}${window.location.host}/ws`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      if (!this.rendered) this.setStatus('offline');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.wsOpen = false;
    const watchdog = window.setTimeout(() => {
      if (!this.wsOpen) {
        try {
          ws.close();
        } catch {
          /* socket already dead */
        }
      }
    }, 8000);

    ws.onopen = () => {
      window.clearTimeout(watchdog);
      this.wsOpen = true;
      this.backoffIdx = 0;
      this.stopPolling();
    };

    ws.onmessage = (event) => {
      this.lastWsMsgAt = performance.now();
      let snap = null;
      try {
        snap = typeof event.data === 'string' ? JSON.parse(event.data) : null;
      } catch {
        snap = null;
      }
      if (!snap || !snap.symbols) return;
      this.handleSnapshot(snap, 'ws');
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };

    ws.onclose = () => {
      window.clearTimeout(watchdog);
      this.wsOpen = false;
      this.ws = null;
      if (this.isMock) return;
      this.setStatus(this.rendered ? 'polling' : 'offline');
      this.startPolling();
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.isMock) return;
    window.clearTimeout(this.reconnectTimer);
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx += 1;
    this.reconnectTimer = window.setTimeout(() => this.connectWS(false), delay);
  }

  startPolling() {
    if (this.pollTimer || this.isMock) return;
    const poll = async () => {
      try {
        const res = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const snap = await res.json();
        this.handleSnapshot(snap, this.wsOpen ? 'ws' : 'poll');
      } catch {
        if (!this.wsOpen) this.setStatus('offline');
      }
    };
    poll();
    this.pollTimer = window.setInterval(poll, POLL_MS);
  }

  stopPolling() {
    if (!this.pollTimer) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
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
    const now = Date.now();
    try {
      this.dash.render(snap, { now, mock: this.isMock });
      this.rendered = true;
      document.body.classList.remove('is-booting');
    } catch (err) {
      console.error('[min-resistance] render failed', err);
    }
    this.updateChrome(snap, now);
    this.setStatus(via === 'mock' ? 'mock' : via === 'ws' ? 'live' : 'polling');
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
  }

  syncOverlays() {
    if (!this.snap) {
      if (this.status === 'offline') {
        this.toast('行情链路中断 · WebSocket 自动重连、轮询兜底中', 'rose', 0);
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
      this.toast('行情链路中断 · WebSocket 自动重连、轮询兜底中', 'rose', 0);
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

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.lastWsMsgAt) {
      if (performance.now() - this.lastWsMsgAt > WS_WATCHDOG_MS) {
        try {
          this.ws.close();
        } catch {
          /* noop */
        }
      }
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
      setTxt(title, '行情链路中断 · 重试中');
      setTxt(sub, 'WebSocket 自动重连 · 轮询 /API/SNAPSHOT 兜底');
    } else {
      card.dataset.state = 'connecting';
      setTxt(title, '建立数据链路 · CONNECTING');
      setTxt(sub, 'BINANCE USDⓈ-M PERPETUAL · WS / 900MS');
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

const app = new App();
app.start();

