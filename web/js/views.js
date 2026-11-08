/* MIN·RESISTANCE — exchange-style terminal view layer.
   Builds the skeleton once, then patches numbers in place on every snapshot. */

import {
  DIR_ARROW,
  DIR_EN,
  DIR_TEXT,
  KIND_TEXT,
  SIGNAL_KEY_TEXT,
  clamp,
  esc,
  fmtClock,
  fmtFunding,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtUsdCompact,
  fmtUsdCompactSigned,
  fmtDistPct,
  num,
  relZh,
  setClass,
  setHTML,
  setTxt,
  tone,
} from './util.js';
import { createChart } from './charts.js';

const PERIOD = { '1m': '1M', '15m': '15M' };
const SECTIONS = { terminal: '交易终端', depth: '深度结构', ledger: '预测账本', events: '事件流' };
const PANELS = {
  depth: '深度剖面',
  friction: '摩擦曲线',
  liqmap: '清算地图',
  cvd: '主动流 CVD',
  events: '事件流',
  accuracy: '预测账本',
};

const ICONS = { BTCUSDT: '₿', ETHUSDT: 'Ξ' };
const SHORT = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };

const BOOK_ROWS = 14;

function qs(sel, root = document) {
  return root.querySelector(sel);
}

function wallKey(price) {
  return Number(price).toFixed(6);
}

/* ------------------------------------------------------------------ */
/* small builders                                                      */
/* ------------------------------------------------------------------ */

function buildKpiStack(host, def) {
  const cells = def.rows
    .map(
      (row) =>
        `<div class="kpi-row2">${row
          .map(
            (cell) =>
              `<div class="kpi-cell"><i>${esc(cell.label)}</i><b data-k="${cell.key}">—</b><span data-k="${cell.key}:s">—</span></div>`
          )
          .join('')}</div>`
    )
    .join('');
  host.innerHTML =
    `<div class="kpi-big"><i>${esc(def.big.label)}</i><b data-k="big">—</b><span data-k="big:s">—</span></div>` +
    cells +
    (def.note ? `<div class="kpi-note">${def.note}</div>` : '');
  const refs = { big: qs('[data-k="big"]', host), bigS: qs('[data-k="big:s"]', host) };
  host.querySelectorAll('[data-k]').forEach((node) => {
    const key = node.getAttribute('data-k');
    const sk = key.endsWith(':s');
    const base = sk ? key.slice(0, -2) : key;
    if (!sk) refs[base] = node;
    else refs[base + 'S'] = node;
  });
  return refs;
}

function sparkRow(sym, info) {
  const marketLabel = (info && info.label) || 'PERP';
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'm-row';
  el.dataset.sym = sym;
  el.innerHTML =
    `<span class="m-id"><i>${ICONS[sym] || '•'}</i><b>${SHORT[sym] || sym}</b><em data-f="mkt">${esc(marketLabel)}</em></span>` +
    `<span class="m-nums"><b data-f="price">—</b><span data-f="chg">—</span></span>` +
    `<span class="m-spark"><canvas></canvas></span>` +
    `<span class="m-tag"><b data-f="struct">—</b><span class="m-dir" data-f="dir">—</span></span>`;
  el.setAttribute('aria-label', `${SHORT[sym] || sym} ${marketLabel}，点击切换`);
  return {
    el,
    refs: {
      mkt: qs('[data-f="mkt"]', el),
      price: qs('[data-f="price"]', el),
      chg: qs('[data-f="chg"]', el),
      struct: qs('[data-f="struct"]', el),
      dir: qs('[data-f="dir"]', el),
    },
    spark: null,
  };
}

function tapeEventRow(ev) {
  const sideText = { bid: '买', ask: '卖', long: '多', short: '空', buy: '买', sell: '卖' }[ev.side] || '—';
  const sideCls = `is-${ev.side || 'na'}`;
  const price = ev.price != null ? fmtPrice(ev.price) : '—';
  const title = esc(`${ev.display || ev.symbol || ''} ${ev.note || ''}`.trim());
  return (
    `<div class="trow trow--event" title="${title}">` +
    `<span class="tt">${fmtClock(Number(ev.ts) < 1e12 ? Number(ev.ts) * 1000 : Number(ev.ts)).slice(0, 8)}</span>` +
    `<span class="te-kind k-${esc(ev.kind || 'whale')}">${esc(KIND_TEXT[ev.kind] || ev.kind || '—')}</span>` +
    `<span class="ts ${sideCls}">${sideText}</span>` +
    `<span class="tp">${price}</span>` +
    `<span class="te-usd">$${fmtUsdCompact(num(ev.usd))}</span>` +
    `</div>`
  );
}

function tapeLargeRow(tr) {
  const buy = tr.side === 'buy';
  return (
    `<div class="trow">` +
    `<span class="tt">${fmtClock(Number(tr.ts)).slice(0, 8)}</span>` +
    `<span class="ts ${buy ? 'is-buy' : 'is-sell'}">${buy ? '买' : '卖'}</span>` +
    `<span class="tp">${fmtPrice(tr.price)}</span>` +
    `<span class="tu">$${fmtUsdCompact(num(tr.usd))}</span>` +
    `</div>`
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export class Dashboard {
  constructor(root = document) {
    this.root = root;
    this.snap = null;
    this.meta = { mock: false };
    this.sym = 'BTCUSDT';
    this.section = 'terminal';
    this.period = '1m';
    this.tab = 'depth';
    this.tape = 'large';
    this.filter = 'all';
    this.overlays = { walls: true, liqs: true, ma: false };
    this.pin = 0;
    this.mounted = false;
    this.charts = {};
    this.rows = {};
    this.market = {};
    this.tapeSig = '';
    this.evSig = '';
    this.accSig = '';
    this.bookRefs = [];
    this.keySig = '';
    this.onToast = null;
    this.bindEvents();
  }

  /* ---------- dom refs ---------- */
  ref(id) {
    if (!this._refs) this._refs = {};
    if (!this._refs[id]) this._refs[id] = document.getElementById(id);
    return this._refs[id];
  }

  /* ---------- mount skeleton ---------- */
  mount() {
    if (this.mounted) return;
    this.mounted = true;

    const grid = this.ref('work-grid');
    grid.hidden = false;
    const boot = this.ref('boot-card');
    if (boot) boot.hidden = true;

    /* markets */
    const list = this.ref('market-list');
    list.innerHTML = '';
    for (const sym of ['BTCUSDT', 'ETHUSDT']) {
      const label = (this.snap && this.snap.market_label) || 'PERP';
      const row = sparkRow(sym, { label });
      list.appendChild(row.el);
      this.market[sym] = row;
      row.spark = createChart('spark', qs('.m-spark', row.el));
    }

    /* order book shell: asks + mid + bids */
    const body = this.ref('book-body');
    body.innerHTML = '';
    const frag = document.createDocumentFragment();
    const makeRow = (side) => {
      const el = document.createElement('div');
      el.className = `brow brow--${side}`;
      el.setAttribute('role', 'listitem');
      el.innerHTML = `<span class="bp"></span><span class="bq"></span><span class="bc"></span>`;
      return el;
    };
    for (let i = 0; i < BOOK_ROWS; i++) frag.appendChild(makeRow('ask'));
    const mid = document.createElement('div');
    mid.className = 'bmid';
    mid.innerHTML = `<b data-f="mid">—</b><span data-f="spread">—</span><span class="bmid-bias" data-f="bias">—</span>`;
    frag.appendChild(mid);
    for (let i = 0; i < BOOK_ROWS; i++) frag.appendChild(makeRow('bid'));
    body.appendChild(frag);
    this.midRefs = {
      mid: qs('[data-f="mid"]', mid),
      spread: qs('[data-f="spread"]', mid),
      bias: qs('[data-f="bias"]', mid),
    };
    this.bookRefs = Array.from(body.querySelectorAll('.brow')).map((el) => ({
      el,
      price: qs('.bp', el),
      qty: qs('.bq', el),
      cum: qs('.bc', el),
      level: null,
    }));

    /* signal mini rows */
    const sig = this.ref('sig-mini');
    sig.innerHTML = '';
    for (const key of ['book', 'walls', 'liquidations', 'flow', 'vacuum']) {
      const row = document.createElement('div');
      row.className = 'sig-mini-row';
      row.innerHTML =
        `<span>${SIGNAL_KEY_TEXT[key] || key}</span>` +
        `<span class="sig-mini-track"><span class="sig-mini-fill" data-f="fill"></span></span>` +
        `<b data-f="val">—</b>`;
      sig.appendChild(row);
      this.rows[key] = { row, fill: qs('[data-f="fill"]', row), val: qs('[data-f="val"]', row) };
    }

    /* lower kpi stacks */
    this.depthRefs = buildKpiStack(this.ref('depth-kpis'), {
      big: { label: '中间价 / 点差', key: 'mid' },
      rows: [
        [
          { label: '买盘深度', key: 'bid' },
          { label: '卖盘深度', key: 'ask' },
        ],
        [
          { label: '1% 失衡', key: 'imb' },
          { label: '墙 / 冰山', key: 'walls' },
        ],
      ],
      note: '青色热力为<b>模型估算</b>，非交易所真实强平；挂单深度来自实时订单簿。',
    });
    this.frictionRefs = buildKpiStack(this.ref('friction-kpis'), {
      big: { label: '更省阻力方向', key: 'cheap' },
      rows: [
        [
          { label: '上行成本 @1%', key: 'up' },
          { label: '下行成本 @1%', key: 'down' },
        ],
        [
          { label: '成本交叉点', key: 'cross' },
          { label: '成本差', key: 'diff' },
        ],
      ],
      note: '累计吃单美元越低，该方向阻力越小；曲线交叉点即两种方向的成本翻转点。',
    });
    this.liqmapRefs = buildKpiStack(this.ref('liqmap-kpis'), {
      big: { label: '实际强平 · 24H', key: 'count' },
      rows: [
        [
          { label: '实际多头强平', key: 'long' },
          { label: '实际空头强平', key: 'short' },
        ],
        [
          { label: '模型多头估算', key: 'elong' },
          { label: '模型空头估算', key: 'eshort' },
        ],
      ],
      note: '实际强平来自交易所 forceOrder；左右图为<b>模型估算</b>，两者严格区分。',
    });
    this.cvdRefs = buildKpiStack(this.ref('cvd-kpis'), {
      big: { label: '净主动流 · 5M', key: 'delta' },
      rows: [
        [
          { label: '主动买入', key: 'buy' },
          { label: '主动卖出', key: 'sell' },
        ],
        [
          { label: '买卖比', key: 'ratio' },
          { label: '大单笔数', key: 'large' },
        ],
      ],
      note: 'CVD 为 10 秒桶累计的主动买卖差，近 15 分钟；大单为窗口内 ≥$250K 成交。',
    });

    /* charts */
    this.charts.candle = createChart('candle', this.ref('candle-host'));
    this.charts.depth = createChart('depth', this.ref('depth-host'));
    this.charts.friction = createChart('friction', this.ref('friction-host'));
    this.charts.liqmap = createChart('liqmap', this.ref('liqmap-host'));
    this.charts.cvd = createChart('cvd', this.ref('cvd-host'));

    this.appendLegend(this.ref('depth-host'), [
      ['mint', '买盘'],
      ['rose', '卖盘'],
      ['cyan', '模型强平'],
      ['amber', '墙 / 冰山'],
    ]);
    this.appendLegend(this.ref('friction-host'), [
      ['mint', '上行累计'],
      ['rose', '下行累计'],
      ['ink', '成本交叉'],
    ]);
    this.appendLegend(this.ref('liqmap-host'), [
      ['rose', '多头强平'],
      ['mint', '空头强平'],
      ['ink', '现价'],
    ]);
    this.appendLegend(this.ref('cvd-host'), [
      ['mint', 'CVD 累计差'],
      ['ink', '零轴'],
    ]);

    this.syncSegment();
    this.syncTabs();
  }


  appendLegend(host, items) {
    const box = host.closest('.chart-box');
    if (!box || !box.parentElement) return;
    const div = document.createElement('div');
    div.className = 'lp-legend';
    div.innerHTML = items
      .map(([tone, text]) => `<span class="lg lg-${tone}">${text}</span>`)
      .join('');
    box.parentElement.insertBefore(div, box.nextSibling);
  }
  /* ---------- events ---------- */
  bindEvents() {
    const root = this.root;
    root.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('nav-btn')) return this.goSection(t.dataset.view);
      if (t.classList.contains('pair-tab')) return this.setPair(t.dataset.sym);
      if (t.dataset.period) return this.setPeriod(t.dataset.period);
      if (t.dataset.ol) return this.toggleOverlay(t.dataset.ol, t);
      if (t.classList.contains('ltab')) return this.openPanel(t.dataset.panel);
      if (t.dataset.tape) return this.setTape(t.dataset.tape);
      if (t.classList.contains('ev-filter')) return this.setFilter(t.dataset.kind);
      if (t.classList.contains('m-row')) return this.setPair(t.dataset.sym);
      return null;
    });

    root.addEventListener('click', (e) => {
      const row = e.target.closest('.brow');
      if (!row || !row.dataset.price) return;
      this.togglePin(Number(row.dataset.price));
    });
  }

  goSection(view) {
    if (!SECTIONS[view]) return;
    this.section = view;
    for (const btn of this.root.querySelectorAll('.nav-btn')) {
      const on = btn.dataset.view === view;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (view === 'depth') this.openPanel('depth');
    if (view === 'ledger') this.openPanel('accuracy');
    if (view === 'events') this.openPanel('events');
    const lower = this.ref('lower');
    const target = view === 'terminal' ? 0 : lower;
    if (target === 0) window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (lower) lower.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  setPair(sym) {
    if (!sym || sym === this.sym) return;
    this.sym = sym;
    this.pin = 0;
    this.charts.candle.setPinned(0);
    for (const btn of this.root.querySelectorAll('.pair-tab')) {
      const on = btn.dataset.sym === sym;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.tapeSig = '';
    this.evSig = '';
    this.accSig = '';
    if (this.snap) this.paint();
    this.note(`已切换 ${SHORT[sym] || sym} · ${sym}`, 'muted');
  }

  setPeriod(period) {
    if (!PERIOD[period] || period === this.period) return;
    this.period = period;
    this.syncSegment();
    if (this.snap) this.paintChart();
  }

  toggleOverlay(key, btn) {
    if (!(key in this.overlays)) return;
    this.overlays[key] = !this.overlays[key];
    if (btn) btn.classList.toggle('is-on', this.overlays[key]);
    if (this.snap) this.paintChart();
  }

  openPanel(panel) {
    if (!PANELS[panel]) return;
    this.tab = panel;
    this.syncTabs();
    if (this.snap) this.paintLower();
    this.note(`结构面板 · ${PANELS[panel]}`, 'muted');
  }

  setTape(mode) {
    if (mode !== 'large' && mode !== 'events') return;
    if (mode === this.tape) return;
    this.tape = mode;
    this.tapeSig = '';
    for (const btn of this.root.querySelectorAll('[data-tape]')) btn.classList.toggle('is-on', btn.dataset.tape === mode);
    if (this.snap) this.paintTape();
  }

  setFilter(kind) {
    if (!kind) return;
    this.filter = kind;
    this.evSig = '';
    for (const btn of this.root.querySelectorAll('.ev-filter')) {
      btn.classList.toggle('is-active', btn.dataset.kind === kind);
    }
    if (this.snap) this.paintEvents();
  }

  togglePin(price) {
    this.pin = this.pin && Math.abs(this.pin - price) < 1e-9 ? 0 : price;
    this.charts.candle.setPinned(this.pin);
    for (const r of this.bookRefs) {
      if (!r.level) continue;
      r.el.classList.toggle('is-pinned', Math.abs(r.level.price - price) < 1e-9 && this.pin > 0);
    }
    if (this.pin) this.note(`已标记 ${fmtPrice(this.pin)} · 再次点击取消`, 'amber');
    else this.note('已取消标记', 'muted');
  }

  syncSegment() {
    for (const btn of this.root.querySelectorAll('[data-period]')) btn.classList.toggle('is-on', btn.dataset.period === this.period);
  }

  syncTabs() {
    for (const btn of this.root.querySelectorAll('.ltab')) {
      const on = btn.dataset.panel === this.tab;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const panel of this.root.querySelectorAll('.lower-panels .lpanel')) {
      panel.hidden = panel.dataset.panel !== this.tab;
    }
    const meta = this.ref('lower-meta');
    if (meta) setTxt(meta, `${this.sym} · ${PANELS[this.tab] || ''}`);
  }

  note(text, toneName = 'muted') {
    if (typeof this.onToast === 'function') this.onToast(text, toneName);
  }

  /* ---------- data helpers ---------- */
  symbolData(sym = this.sym) {
    return (this.snap && this.snap.symbols && this.snap.symbols[sym]) || null;
  }

  /* ---------- render ---------- */
  render(snap, meta = {}) {
    this.snap = snap;
    this.meta = meta;
    if (!this.mounted) this.mount();
    if (!this._tapeInit) {
      this._tapeInit = true;
      const syms = snap.symbols || {};
      const anyLarge = Object.values(syms).some((x) => (((x || {}).flow || {}).large || []).length);
      if (!anyLarge && (snap.events || []).length) {
        this.tape = 'events';
        for (const btn of this.root.querySelectorAll('[data-tape]')) {
          btn.classList.toggle('is-on', btn.dataset.tape === 'events');
        }
      }
    }
    this.paint();
  }

  paint() {
    const s = this.symbolData();
    if (!s) return;
    const mkt = (this.snap && this.snap.market_label) || 'PERP';
    const tkMkt = this.ref('tk-mkt');
    if (tkMkt) setTxt(tkMkt, mkt);
    const chMkt = this.ref('ch-mkt');
    if (chMkt) setTxt(chMkt, mkt);
    this.paintTicker(s);
    this.paintHeader(s);
    this.paintChart(s);
    this.paintLeft(s);
    this.paintKeyLevels(s);
    this.paintBook(s);
    this.paintTape();
    this.paintPred(s);
    this.paintLower();
    this.syncTabs();
  }

  paintTicker(s) {
    const ob = s.orderbook || {};
    setTxt(this.ref('tk-icon'), ICONS[s.symbol] || '•');
    setTxt(this.ref('tk-sym'), s.symbol || '—');
    setTxt(this.ref('tk-price'), fmtPrice(s.price));
    const chg = num(s.change_24h_pct);
    const chgNode = this.ref('tk-chg');
    setTxt(chgNode, fmtPct(chg, 2, true));
    setClass(chgNode, 'up', chg > 0);
    setClass(chgNode, 'down', chg < 0);
    setTxt(this.ref('tk-chg-abs'), `${signedUsdAbs(chg, s.price)} 24H`);
    setTxt(this.ref('tk-high'), fmtPrice(s.high_24h));
    setTxt(this.ref('tk-low'), fmtPrice(s.low_24h));
    setTxt(this.ref('tk-vol'), `$${fmtUsdCompact(num(s.quote_volume_24h))}`);
    const hasFunding = s.funding_rate != null;
    const nf = s.next_funding_ts ? relZh(Number(s.next_funding_ts), Date.now()) : '—';
    setTxt(this.ref('tk-funding'), hasFunding ? `${fmtFunding(num(s.funding_rate))} · ${nf}` : '—');
    setTxt(this.ref('tk-oi'), s.open_interest != null ? `${fmtNum(num(s.open_interest) / 1000, 1)}K` : '—');
    const hasMark = s.mark_price != null && s.index_price != null;
    setTxt(this.ref('tk-mark'), hasMark ? `${fmtPrice(s.mark_price)} / ${fmtPrice(s.index_price)}` : '—');
    setTxt(
      this.ref('tk-spread'),
      `${fmtNum(num(ob.spread_bps), 2)} bps · ${fmtPct(num(ob.imbalance_1pct) * 100, 1, true)}`
    );
  }

  paintHeader(s) {
    setTxt(this.ref('ch-sym'), `${SHORT[s.symbol] || s.symbol} · ${s.symbol}`);
    setTxt(this.ref('ch-ready'), s.ready ? 'BOOK SYNC' : 'SYNCING');
    setClass(this.ref('ch-ready'), 'is-on', !!s.ready);
    setTxt(this.ref('ch-price'), fmtPrice(s.price));
    const chgNode = this.ref('ch-chg');
    const chg = num(s.change_24h_pct);
    setTxt(chgNode, fmtPct(chg, 2, true));
    setClass(chgNode, 'up', chg > 0);
    setClass(chgNode, 'down', chg < 0);
    const candles = this.periodCandles(s);
    const last = candles[candles.length - 1];
    if (last) {
      setTxt(
        this.ref('ch-ohlc'),
        `O ${fmtPrice(last[1])}  H ${fmtPrice(last[2])}  L ${fmtPrice(last[3])}  C ${fmtPrice(last[4])}`
      );
    }
  }

  periodCandles(s) {
    const key = this.period === '15m' ? 'candles_15m' : 'candles_1m';
    const list = (s.chart && s.chart[key]) || [];
    return Array.isArray(list) ? list : [];
  }

  paintChart(s) {
    s = s || this.symbolData();
    if (!s) return;
    const ob = s.orderbook || {};
    this.charts.candle.update({
      candles: this.periodCandles(s),
      price: s.price,
      period: this.period,
      show: this.overlays,
      walls: ob.walls || [],
      clusters: (s.liquidations && s.liquidations.clusters) || [],
      pinned: this.pin,
    });
    for (const el of this.root.querySelectorAll('.cf-ma')) el.hidden = !this.overlays.ma;
  }

  paintLeft(s) {
    const ob = s.orderbook || {};
    const bid = num(ob.bid_depth_usd);
    const ask = num(ob.ask_depth_usd);
    const total = bid + ask;
    if (!total) {
      setTxt(this.ref('rs-bid'), '—');
      setTxt(this.ref('rs-ask'), '—');
      setTxt(this.ref('rs-verdict'), '等待盘口数据…');
      return;
    }
    const bias = (bid - ask) / total;
    const norm = clamp(bias * 20, -1, 1);
    setTxt(this.ref('rs-bid'), `$${fmtUsdCompact(bid)}`);
    setTxt(this.ref('rs-ask'), `$${fmtUsdCompact(ask)}`);
    const pct = 50 + norm * 50;
    const bBar = this.ref('rs-bar-b');
    const aBar = this.ref('rs-bar-a');
    if (bBar) bBar.style.width = `${pct.toFixed(2)}%`;
    if (aBar) aBar.style.width = `${(100 - pct).toFixed(2)}%`;

    const needle = this.ref('rs-needle');
    if (needle) needle.setAttribute('transform', `rotate(${(norm * 62).toFixed(2)} 100 84)`);
    const arc = this.ref('rs-needle-arc');
    if (arc) {
      const half = 135;
      const len = Math.min(half, Math.abs(bias) * 20 * half);
      arc.style.stroke = norm >= 0 ? 'var(--up)' : 'var(--down)';
      arc.setAttribute('stroke-dasharray', `${len.toFixed(1)} 999`);
      arc.setAttribute('stroke-dashoffset', String(norm >= 0 ? -half : -(half - len)));
    }
    const verdict = this.ref('rs-verdict');
    const dir = norm > 0.12 ? 'up' : norm < -0.12 ? 'down' : 'neutral';
    const label = dir === 'up' ? '买盘更厚 · 上行阻力更小' : dir === 'down' ? '卖盘更厚 · 下行阻力更小' : '两侧挂单接近均衡';
    setHTML(verdict, `${label} <em>${dir === 'up' ? 'UP RESISTANCE LOWER' : dir === 'down' ? 'DOWN RESISTANCE LOWER' : 'BALANCED'}</em>`);
    const tag = this.ref('bias-tag');
    if (tag) {
      setTxt(tag, `${DIR_TEXT[dir]} ${DIR_ARROW[dir]}`);
      setClass(tag, 'is-on', dir !== 'neutral');
      tag.style.color = dir === 'up' ? 'var(--up)' : dir === 'down' ? 'var(--down)' : 'var(--ink-3)';
    }

    /* markets */
    const order = (this.snap && this.snap.symbol_order) || ['BTCUSDT', 'ETHUSDT'];
    for (const sym of order) {
      const row = this.market[sym];
      const sd = this.symbolData(sym);
      if (!row || !sd) continue;
      const pred = sd.prediction || {};
      const pdir = pred.direction || 'neutral';
      if (row.refs.mkt) {
        setTxt(row.refs.mkt, (this.snap && this.snap.market_label) || 'PERP');
      }
      setTxt(row.refs.price, fmtPrice(sd.price));
      const rowChg = num(sd.change_24h_pct);
      setTxt(row.refs.chg, fmtPct(rowChg, 2, true));
      setClass(row.refs.chg, 'up', rowChg > 0);
      setClass(row.refs.chg, 'down', rowChg < 0);
      const walls = ((sd.orderbook && sd.orderbook.walls) || []).length;
      const ice = ((sd.orderbook && sd.orderbook.icebergs) || []).length;
      setTxt(row.refs.struct, `墙 ${walls} · 冰 ${ice}`);
      setTxt(row.refs.dir, `${DIR_TEXT[pdir]} ${DIR_ARROW[pdir]}`);
      setClass(row.refs.dir, 'is-up', pdir === 'up');
      setClass(row.refs.dir, 'is-down', pdir === 'down');
      row.el.classList.toggle('is-on', sym === this.sym);
      const candles = (sd.chart && sd.chart.candles_1m) || [];
      if (row.spark) row.spark.update(candles);
    }
  }

  paintKeyLevels(s) {
    const list = this.ref('key-list');
    if (!list) return;
    const ob = s.orderbook || {};
    const mid = num(ob.mid) || num(s.mid) || num(s.price);
    const pred = s.prediction || {};
    const walls = ob.walls || [];
    const levels = pred.levels || [];
    const clusters = (s.liquidations && s.liquidations.clusters) || [];

    const res = [];
    const sup = [];
    const add = (price, type, side, usd) => {
      const p = num(price);
      if (!p || !mid) return;
      const dist = ((p - mid) / mid) * 100;
      if (!Number.isFinite(dist) || Math.abs(dist) < 0.008) return;
      (dist > 0 ? res : sup).push({ price: p, type, side, usd: num(usd), dist });
    };

    for (const w of walls) {
      const p = num(w.price);
      if (!p) continue;
      const up = p >= mid;
      add(p, up ? '卖墙' : '买墙', up ? 'ask' : 'bid', w.usd);
    }
    for (const l of levels) {
      const p = num(l.price);
      if (!p) continue;
      const up = p >= mid;
      const type = l.kind === 'liq' ? (up ? '空头清算' : '多头清算') : up ? '卖墙' : '买墙';
      add(p, type, up ? 'ask' : 'bid', l.usd);
    }
    for (const c of clusters) {
      const p = num(c.price);
      if (!p) continue;
      const up = p >= mid;
      const usd = up ? num(c.short_usd) : num(c.long_usd);
      if (usd > 0) add(p, up ? '空头清算' : '多头清算', up ? 'ask' : 'bid', usd);
    }

    const near = (rows) =>
      rows
        .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))
        .filter((r, i, a) => i === 0 || Math.abs(r.price - a[i - 1].price) / mid > 0.00002)
        .slice(0, 3);
    const resRows = near(res);
    const supRows = near(sup);

    const sig = `${this.sym}:${resRows.map((r) => `${r.price}:${r.type}:${r.usd}`).join('|')}:${supRows
      .map((r) => `${r.price}:${r.type}:${r.usd}`)
      .join('|')}`;
    if (sig === this.keySig) return;
    this.keySig = sig;

    if (!resRows.length && !supRows.length) {
      list.innerHTML = '<div class="key-empty">近端无显著挂单壁垒</div>';
      return;
    }

    const rowHtml = (r) => {
      const tone = r.side === 'ask' ? 'is-ask' : 'is-bid';
      const usd = r.usd > 0 ? `$${fmtUsdCompact(r.usd)}` : '—';
      return (
        `<div class="krow ${tone}" role="listitem" title="${r.type} · 距中价 ${r.dist.toFixed(2)}% · ${usd}">` +
        `<span class="kp num">${fmtPrice(r.price)}</span>` +
        `<span class="kt">${r.type}</span>` +
        `<span class="kd num">${fmtPct(r.dist, 2, true)}</span>` +
        `<span class="ku num">${usd}</span>` +
        `</div>`
      );
    };
    const group = (cls, label, en, rows) =>
      `<div class="key-group ${cls}">` +
      `<div class="kg-head ${cls}"><b>${label}</b><em>${en}</em></div>` +
      (rows.length ? rows.map(rowHtml).join('') : '<div class="key-empty key-empty--sm">近端无显著挂单壁垒</div>') +
      `</div>`;
    list.innerHTML =
      (resRows.length ? group('res', '上方阻力', 'RESISTANCE', resRows) : '') +
      (supRows.length ? group('sup', '下方支撑', 'SUPPORT', supRows) : '');
  }

  paintBook(s) {
    const ob = s.orderbook || {};
    const ladder = ob.ladder || {};
    const asksRaw = (ladder.asks || []).slice(0, BOOK_ROWS);
    const bidsRaw = (ladder.bids || []).slice(0, BOOK_ROWS);
    const asks = asksRaw.slice().reverse();
    const levels = asks.concat(bidsRaw);
    const maxCum = levels.reduce((m, l) => Math.max(m, num(l.cum_usd)), 1);

    const wallSide = new Map();
    for (const w of ob.walls || []) {
      wallSide.set(wallKey(w.price), w.kind === 'iceberg' ? 'ice' : 'wall');
    }
    const icePrices = new Set(((ob.icebergs || []).map((i) => wallKey(i.price))));

    this.bookRefs.forEach((row, i) => {
      const level = levels[i];
      if (!level) {
        row.level = null;
        row.el.hidden = true;
        return;
      }
      row.el.hidden = false;
      row.level = level;
      const price = num(level.price);
      const key = wallKey(price);
      const side = i < BOOK_ROWS ? 'ask' : 'bid';
      row.el.dataset.price = String(price);
      row.el.classList.toggle('brow--ask', side === 'ask');
      row.el.classList.toggle('brow--bid', side === 'bid');
      const kind = wallSide.get(key);
      row.el.classList.toggle('is-wall', kind === 'wall');
      row.el.classList.toggle('is-ice', kind === 'ice' || icePrices.has(key));
      row.el.classList.toggle('is-pinned', this.pin > 0 && Math.abs(price - this.pin) < 1e-9);
      setTxt(row.price, fmtPrice(price));
      setTxt(row.qty, fmtNum(num(level.qty), 3));
      setTxt(row.cum, fmtUsdCompact(num(level.cum_usd)));
      row.el.style.setProperty('--w', `${((num(level.cum_usd) / maxCum) * 100).toFixed(1)}%`);
      row.el.style.setProperty(
        '--bar',
        side === 'ask' ? 'rgba(246,70,93,0.13)' : 'rgba(14,203,129,0.13)'
      );
    });

    if (this.midRefs) {
      setTxt(this.midRefs.mid, fmtPrice(ob.mid != null ? ob.mid : s.price));
      setTxt(this.midRefs.spread, `点差 ${fmtNum(num(ob.spread_bps), 2)} bps`);
      setTxt(this.midRefs.bias, `1% 失衡 ${fmtPct(num(ob.imbalance_1pct) * 100, 1, true)}`);
    }
    const spreadTag = this.ref('book-spread');
    if (spreadTag) setTxt(spreadTag, `点差 ${fmtNum(num(ob.spread_bps), 2)} bps`);

    const bidSum = bidsRaw.reduce((m, l) => m + num(l.usd), 0);
    const askSum = asksRaw.reduce((m, l) => m + num(l.usd), 0);
    const ratio = askSum ? bidSum / askSum : 0;
    setTxt(this.ref('book-ratio'), ratio ? ratio.toFixed(2) : '—');
    setTxt(this.ref('book-ice'), String((ob.icebergs || []).length));
    setTxt(this.ref('book-wall'), String((ob.walls || []).length));

    const bib = this.ref('book-bi-b');
    const bia = this.ref('book-bi-a');
    const tot = bidSum + askSum;
    if (bib && bia && tot) {
      bib.style.width = `${((bidSum / tot) * 100).toFixed(1)}%`;
      bia.style.width = `${((askSum / tot) * 100).toFixed(1)}%`;
    }
  }

  paintTape() {
    const host = this.ref('tape-list');
    if (!host) return;
    const s = this.symbolData();
    if (!s) return;
    let rows = [];
    if (this.tape === 'large') {
      const large = (s.flow && s.flow.large) || [];
      rows = large.slice(-10).reverse();
      const sig = `${this.sym}:${rows.length}:${rows[0] ? rows[0].ts : 0}`;
      if (sig === this.tapeSig) return;
      this.tapeSig = sig;
      host.innerHTML = rows.length
        ? rows.map(tapeLargeRow).join('')
        : `<div class="empty empty--sm"><b>暂无大单成交</b><span>最近 5 分钟窗口内没有 ≥$250K 的主动成交</span></div>`;
    } else {
      const all = (this.snap && this.snap.events) || [];
      rows = all.slice(-10).reverse();
      const sig = `${this.sym}:${rows.length}:${rows[0] ? rows[0].ts : 0}:${all.length}`;
      if (sig === this.tapeSig) return;
      this.tapeSig = sig;
      host.innerHTML = rows.length
        ? rows.map(tapeEventRow).join('')
        : `<div class="empty empty--sm"><b>暂无事件</b><span>冰山 / 撤单 / 大单 / 强平事件会出现在这里</span></div>`;
    }
    host.scrollTop = 0;
  }

  paintPred(s) {
    const pred = s.prediction || {};
    const dir = pred.direction || 'neutral';
    const pill = this.ref('pd-pill');
    if (pill) {
      setHTML(pill, `${DIR_TEXT[dir]} ${DIR_ARROW[dir]} <em>${DIR_EN[dir]}</em>`);
      setClass(pill, 'is-up', dir === 'up');
      setClass(pill, 'is-down', dir === 'down');
    }
    const conf = num(pred.confidence);
    setTxt(this.ref('pd-conf'), `${(conf * 100).toFixed(0)}%`);
    const pUp = num(pred.p_up);
    const bar = this.ref('pd-bar');
    if (bar) {
      bar.style.width = `${(clamp(pUp, 0, 1) * 100).toFixed(1)}%`;
      const barWrap = bar.parentElement;
      if (barWrap) barWrap.classList.toggle('is-down', dir === 'down');
    }
    const edge = num(pred.score);
    setTxt(this.ref('pd-pup'), fmtPct(pUp * 100, 1, false));
    setTxt(this.ref('pd-edge'), `权重分 ${fmtNum(edge, 3)}`);

    const target = this.ref('pd-target');
    const targetDist = this.ref('pd-target-dist');
    const hasTarget = pred.target_price != null;
    setTxt(target, hasTarget ? fmtPrice(pred.target_price) : '—');
    setClass(target, 'is-mute', !hasTarget);
    setClass(target, 'up', hasTarget);
    setTxt(
      targetDist,
      hasTarget && num(s.price) ? `${fmtDistPct(pctFrom(pred.target_price, s.price), 2)} 距现价` : '中性预测无目标价'
    );

    const inval = this.ref('pd-inval');
    const invalDist = this.ref('pd-inval-dist');
    const hasInval = pred.invalidation_price != null;
    setTxt(inval, hasInval ? fmtPrice(pred.invalidation_price) : '—');
    setClass(inval, 'is-mute', !hasInval);
    setClass(inval, 'down', hasInval);
    setTxt(
      invalDist,
      hasInval && num(s.price) ? `${fmtDistPct(pctFrom(pred.invalidation_price, s.price), 2)} 距现价` : '等待方向确认'
    );

    const acc = s.accuracy || {};
    setTxt(this.ref('pd-horizon'), `${num(pred.horizon_min, 15)}m`);
    const hit = acc.hit_rate;
    setTxt(
      this.ref('pd-acc'),
      hit == null
        ? `样本 ${num(acc.samples)} · 待结算 ${num(acc.pending)}`
        : `命中 ${(num(hit) * 100).toFixed(0)}% · Brier ${num(acc.brier).toFixed(2)} · ${num(acc.samples)}次`
    );

    /* five signals */
    const rows = s.signals || [];
    for (const sig of rows) {
      const row = this.rows[sig.key];
      if (!row) continue;
      const score = num(sig.score);
      setTxt(row.val, fmtNum(score, 3));
      setClass(row.val, 'is-pos', score > 0.0005);
      setClass(row.val, 'is-neg', score < -0.0005);
      const fill = row.fill;
      if (fill) {
        const w = Math.abs(score) * 50;
        fill.style.width = `${w.toFixed(2)}%`;
        fill.style.left = score >= 0 ? '50%' : `${(50 - w).toFixed(2)}%`;
        fill.classList.toggle('is-neg', score < 0);
      }
      row.row.title = `${sig.label || SIGNAL_KEY_TEXT[sig.key] || sig.key} · 权重 ${(num(sig.weight) * 100).toFixed(0)}% · 贡献 ${sig.contribution != null ? fmtNum(sig.contribution, 3) : '—'}：${sig.detail || ''}`;
    }
  }

  paintLower() {
    const s = this.symbolData();
    if (!s) return;
    if (this.tab === 'depth') {
      this.paintDepth(s);
      this.charts.depth.update({
        profile: (s.orderbook && s.orderbook.profile) || [],
        estimated: (s.liquidations && s.liquidations.estimated) || [],
        walls: (s.orderbook && s.orderbook.walls) || [],
        mid: s.orderbook && s.orderbook.mid,
      });
    } else if (this.tab === 'friction') {
      this.paintFriction(s);
      this.charts.friction.update({ friction: s.friction || [], price: s.price });
    } else if (this.tab === 'liqmap') {
      this.paintLiqmap(s);
      this.charts.liqmap.update({
        estimated: (s.liquidations && s.liquidations.estimated) || [],
        price: s.price,
        clusters: (s.liquidations && s.liquidations.clusters) || [],
      });
    } else if (this.tab === 'cvd') {
      this.paintCvd(s);
      this.charts.cvd.update({ cvd: (s.flow && s.flow.cvd) || [] });
    } else if (this.tab === 'events') {
      this.paintEvents();
    } else if (this.tab === 'accuracy') {
      this.paintAccuracy(s);
    }
  }

  paintDepth(s) {
    const ob = s.orderbook || {};
    const refs = this.depthRefs;
    const bid = num(ob.bid_depth_usd);
    const ask = num(ob.ask_depth_usd);
    const total = bid + ask || 1;
    setTxt(refs.big, fmtPrice(ob.mid != null ? ob.mid : s.price));
    setTxt(refs.bigS, `点差 ${fmtNum(num(ob.spread_bps), 2)} bps · 失衡 ${fmtPct(num(ob.imbalance_1pct) * 100, 1, true)}`);
    setTxt(refs.bid, `$${fmtUsdCompact(bid)}`);
    setTxt(refs.bidS, `占比 ${fmtPct((bid / total) * 100, 1, false)}`);
    setTxt(refs.ask, `$${fmtUsdCompact(ask)}`);
    setTxt(refs.askS, `占比 ${fmtPct((ask / total) * 100, 1, false)}`);
    setTxt(refs.imb, fmtPct(num(ob.imbalance_1pct) * 100, 1, true));
    setTxt(refs.imbS, '±1% 挂单失衡');
    setTxt(refs.walls, `${((ob.walls || []).length)} / ${((ob.icebergs || []).length)}`);
    setTxt(refs.wallsS, '可见墙体 / 冰山');
  }

  paintFriction(s) {
    const refs = this.frictionRefs;
    const rows = s.friction || [];
    const up1 = near(rows, 1);
    const down1 = near(rows, 1);
    const cross = crossing(rows);
    const upUsd = up1 ? num(up1.up_usd) : 0;
    const downUsd = down1 ? num(down1.down_usd) : 0;
    const cheaper = upUsd <= downUsd ? '上行' : '下行';
    setTxt(refs.big, cheaper);
    setTxt(refs.bigS, `成本比 ${downUsd ? (upUsd / downUsd).toFixed(2) : '—'}× · 上行/下行`);
    setTxt(refs.up, `$${fmtUsdCompact(upUsd)}`);
    setTxt(refs.upS, '吃掉卖盘所需');
    setTxt(refs.down, `$${fmtUsdCompact(downUsd)}`);
    setTxt(refs.downS, '吃掉买盘所需');
    setTxt(refs.cross, cross ? `${fmtNum(cross.dist, 2)}%` : '—');
    setTxt(refs.crossS, cross ? '两方向成本翻转点' : '当前区间未交叉');
    const diff = Math.abs(upUsd - downUsd);
    setTxt(refs.diff, `$${fmtUsdCompact(diff)}`);
    setTxt(refs.diffS, cheaper === '上行' ? '上行更省' : '下行更省');
  }

  paintLiqmap(s) {
    const refs = this.liqmapRefs;
    const liq = s.liquidations || {};
    const est = liq.estimated || [];
    let elong = 0;
    let eshort = 0;
    for (const e of est) {
      elong += num(e.long_usd);
      eshort += num(e.short_usd);
    }
    setTxt(refs.big, `${num(liq.count)} 笔`);
    setTxt(refs.bigS, num(liq.count) ? '窗口内实际强平成交' : '当前窗口无真实强平');
    setTxt(refs.long, `$${fmtUsdCompact(num(liq.total_long_usd))}`);
    setTxt(refs.longS, '交易所 forceOrder');
    setTxt(refs.short, `$${fmtUsdCompact(num(liq.total_short_usd))}`);
    setTxt(refs.shortS, '交易所 forceOrder');
    setTxt(refs.elong, `$${fmtUsdCompact(elong)}`);
    setTxt(refs.elongS, '模型估算 · 非交易所数据');
    setTxt(refs.eshort, `$${fmtUsdCompact(eshort)}`);
    setTxt(refs.eshortS, '模型估算 · 非交易所数据');
  }

  paintCvd(s) {
    const refs = this.cvdRefs;
    const flow = s.flow || {};
    const delta = num(flow.delta_usd);
    setTxt(refs.big, fmtUsdCompactSigned(delta));
    setClass(refs.big, 'up', delta > 0);
    setClass(refs.big, 'down', delta < 0);
    setTxt(refs.bigS, `归一化 ${fmtNum(num(flow.ratio), 3)} · ${num(flow.window_s, 300)}s 窗口`);
    setTxt(refs.buy, `$${fmtUsdCompact(num(flow.buy_usd))}`);
    setTxt(refs.buyS, `${num(flow.trades)} 笔主动成交`);
    setTxt(refs.sell, `$${fmtUsdCompact(num(flow.sell_usd))}`);
    setTxt(refs.sellS, '主动卖出');
    const ratio = num(flow.sell_usd) ? num(flow.buy_usd) / num(flow.sell_usd) : 0;
    setTxt(refs.ratio, ratio ? `${ratio.toFixed(2)}×` : '—');
    setTxt(refs.ratioS, '买 / 卖');
    setTxt(refs.large, String(((flow.large || []) || []).length));
    setTxt(refs.largeS, '窗口内大单');
  }

  paintEvents() {
    const host = this.ref('ev-list');
    const meta = this.ref('ev-meta');
    if (!host) return;
    const all = (this.snap && this.snap.events) || [];
    const counts = { all: all.length, iceberg: 0, spoof: 0, whale: 0, liquidation: 0 };
    for (const ev of all) if (counts[ev.kind] != null) counts[ev.kind]++;
    for (const btn of this.root.querySelectorAll('.ev-filter')) {
      const em = btn.querySelector('em');
      if (em) setTxt(em, String(counts[btn.dataset.kind] != null ? counts[btn.dataset.kind] : 0));
    }
    const rows = (this.filter === 'all' ? all : all.filter((e) => e.kind === this.filter)).slice(-60).reverse();
    const sig = `${this.filter}:${rows.length}:${rows[0] ? rows[0].ts : 0}`;
    if (meta) setTxt(meta, `共 ${all.length} 条 · 显示 ${rows.length} 条 · 最新 ${rows[0] ? relZh(Number(rows[0].ts), Date.now()) : '—'}`);
    if (sig === this.evSig) return;
    this.evSig = sig;
    host.innerHTML = rows.length
      ? rows
          .map((ev) => {
            const sideMap = { bid: '买', ask: '卖', long: '多', short: '空', buy: '买', sell: '卖' };
            return (
              `<div class="ev-row">` +
              `<span class="ev-time">${relZh(Number(ev.ts), Date.now())}</span>` +
              `<span class="ev-kind k-${esc(ev.kind || 'whale')}">${esc(KIND_TEXT[ev.kind] || ev.kind || '—')}</span>` +
              `<span class="ev-sym">${esc(SHORT[ev.symbol] || ev.symbol || '—')}</span>` +
              `<span class="ev-side is-${esc(ev.side || 'na')}">${sideMap[ev.side] || '—'}</span>` +
              `<span class="ev-price">${fmtPrice(ev.price)}</span>` +
              `<span class="ev-usd">$${fmtUsdCompact(num(ev.usd))}</span>` +
              `<span class="ev-note">${esc(ev.note || '')}</span>` +
              `</div>`
            );
          })
          .join('')
      : `<div class="empty"><b>暂无${this.filter === 'all' ? '' : (KIND_TEXT[this.filter] || '')}事件</b><span>事件流由 ICEBERG / SPOOF / WHALE / LIQUIDATION 检测产生</span></div>`;
  }

  paintAccuracy(s) {
    const acc = s.accuracy || {};
    const rate = acc.hit_rate;
    const ring = this.ref('acc-ring-val');
    const rateText = this.ref('acc-rate');
    setTxt(rateText, rate == null ? '—' : `${(num(rate) * 100).toFixed(0)}%`);
    if (ring) {
      const c = 307.876;
      ring.setAttribute('stroke-dashoffset', String(rate == null ? c : c * (1 - clamp(num(rate), 0, 1))));
      ring.style.stroke = rate != null && num(rate) >= 0.5 ? 'var(--up)' : 'var(--down)';
    }
    const stats = this.ref('acc-stats');
    const statSig = `${num(acc.samples)}:${num(acc.hits)}:${num(acc.pending)}:${acc.brier != null ? acc.brier : 'n'}:${num(acc.logged)}`;
    if (stats && statSig !== this.accStatSig) {
      this.accStatSig = statSig;
      stats.innerHTML =
        `<div class="acc-stat"><i>已结算样本</i><b>${num(acc.samples)}</b><span>累计记录 ${num(acc.logged)}</span></div>` +
        `<div class="acc-stat"><i>命中次数</i><b>${num(acc.hits)}</b><span>方向正确</span></div>` +
        `<div class="acc-stat"><i>BRIER 分数</i><b>${acc.brier == null ? '—' : num(acc.brier).toFixed(3)}</b><span>${acc.brier == null ? '样本不足' : '越低越准'}</span></div>` +
        `<div class="acc-stat"><i>待结算</i><b>${num(acc.pending)}</b><span>${num(acc.pending)} 个 15 分钟窗口</span></div>`;
    }
    const hist = this.ref('acc-hist');
    const recent = (acc.recent || []).slice(-8).reverse();
    const histSig = `${recent.length}:${recent[0] ? recent[0].ts : 0}`;
    if (hist && histSig !== this.accHistSig) {
      this.accHistSig = histSig;
      hist.innerHTML = recent.length
        ? recent
            .map((r) => {
              const dirText = DIR_TEXT[r.direction] || '—';
              const resolved = r.resolved;
              const res = !resolved ? '待结算' : r.correct ? '命中' : '未中';
              const resCls = !resolved ? 'wait' : r.correct ? 'ok' : 'bad';
              return (
                `<div class="acc-row">` +
                `<span>${fmtClock(Number(r.ts)).slice(0, 5)}</span>` +
                `<span>${dirText}</span>` +
                `<span>P(UP) ${fmtPct(num(r.p_up) * 100, 1, false)}</span>` +
                `<span>${r.move_pct != null ? fmtPct(num(r.move_pct), 2, true) : '—'}</span>` +
                `<span class="res ${resCls}">${res}</span>` +
                `</div>`
              );
            })
            .join('')
        : `<div class="empty empty--sm"><b>暂无已结算预测</b><span>15 分钟窗口结算后，命中结果会出现在这里</span></div>`;
    }
  }
}

/* helpers */
function crossing(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  for (let i = 0; i < rows.length - 1; i++) {
    const d0 = num(rows[i].up_usd) - num(rows[i].down_usd);
    const d1 = num(rows[i + 1].up_usd) - num(rows[i + 1].down_usd);
    if (d0 === 0) return { dist: num(rows[i].dist_pct) };
    if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
      const t = d0 / (d0 - d1);
      return { dist: num(rows[i].dist_pct) + t * (num(rows[i + 1].dist_pct) - num(rows[i].dist_pct)) };
    }
  }
  return null;
}

function near(rows, dist) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = rows[0];
  let bestD = Infinity;
  for (const r of rows) {
    const d = Math.abs(num(r.dist_pct) - dist);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

function signedUsdAbs(chgPct, price) {
  const abs = (num(price) * num(chgPct)) / 100;
  const sign = abs >= 0 ? '+' : '−';
  return `${sign}${Math.abs(abs).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function pctFrom(price, base) {
  const p = num(price);
  const b = num(base);
  if (!b) return 0;
  return ((p - b) / b) * 100;
}



