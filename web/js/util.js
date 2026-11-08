/* MIN·RESISTANCE — shared helpers: number/date formatting, DOM tiny helpers,
   tone mapping and reduced-motion detection. No dependencies. */

export const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

const NF_CACHE = new Map();

/** Cached fixed-fraction number formatter with en-US thousand separators. */
export function fmtNum(value, digits = 2) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const d = Math.max(0, Math.min(8, digits | 0));
  let nf = NF_CACHE.get(d);
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
      useGrouping: true,
    });
    NF_CACHE.set(d, nf);
  }
  return nf.format(v);
}

/** Decimals appropriate for an instrument price: 76,095.85 / 2,246.735. */
export function priceDigits(value) {
  const v = Math.abs(Number(value));
  if (!Number.isFinite(v) || v === 0) return 2;
  if (v >= 1000) return 2;
  if (v >= 100) return 3;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 6;
}

export function fmtPrice(value) {
  return fmtNum(value, priceDigits(value));
}

/** Compact USD magnitude: 99.68M, 1.20B, 812.4K. */
export function fmtUsdCompact(value, digits = 2) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const neg = v < 0;
  const a = Math.abs(v);
  let out;
  if (a >= 1e9) out = (a / 1e9).toFixed(digits) + 'B';
  else if (a >= 1e6) out = (a / 1e6).toFixed(digits) + 'M';
  else if (a >= 1e3) out = (a / 1e3).toFixed(1) + 'K';
  else out = a.toFixed(0);
  return (neg ? '-' : '') + out;
}

/** Compact plain quantity: 78.6K, 1.24M. */
export function fmtQtyCompact(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/** Signed percent already expressed in percent units (0.707 → +0.71%). */
export function fmtPct(value, digits = 2, signed = true) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const sign = signed && v > 0 ? '+' : '';
  return sign + fmtNum(v, digits) + '%';
}

/** Funding rate decimal → percent: 0.000013 → +0.0013%. */
export function fmtFunding(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  return sign + fmtNum(pct, Math.abs(pct) >= 0.01 ? 3 : 4) + '%';
}

/** Signed USD value with separator: +$1,234.50. */
export function fmtUsdSigned(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return sign + '$' + fmtNum(Math.abs(v), 2);
}

/** Compact signed USD: +1.24M. */
export function fmtUsdCompactSigned(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return sign + fmtUsdCompact(Math.abs(v));
}

/** Tone class name for a signed number. */
export function tone(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

const SHANGHAI_TZ = 'Asia/Shanghai';

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHANGHAI_TZ,
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const hmsFmt = timeFmt;

/** HH:MM:SS in UTC+8. */
export function fmtClock(ts = Date.now()) {
  try {
    return timeFmt.format(new Date(ts));
  } catch {
    return '--:--:--';
  }
}

export function fmtHMS(ts) {
  try {
    return hmsFmt.format(new Date(ts));
  } catch {
    return '--:--';
  }
}

/** Relative Chinese timestamp: 刚刚 / 12秒前 / 3分钟前 / 2小时前 / 3天前. */
export function relZh(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const diff = Math.max(0, now - t);
  const s = diff / 1000;
  if (s < 2) return '刚刚';
  if (s < 60) return `${Math.floor(s)}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

/** Compact Chinese duration: 12秒 / 3分12秒 / 1时02分 / 2天3时. */
export function fmtDurationZh(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${Math.floor(s)}秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}分${String(ss).padStart(2, '0')}秒`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}时${String(m).padStart(2, '0')}分`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}天${h}时`;
}

/** Data age for the top bar: 0.4s / 3.1s / 1m12s. */
export function fmtAge(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  return fmtDurationZh(s);
}

export function fmtLatencyMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.max(0, Math.round(n))}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

/** "1.25%" style distance, signed optional. */
export function fmtDistPct(v, digits = 2) {
  return fmtPct(v, digits, false);
}

export const DIR_TEXT = {
  up: '看涨',
  down: '看跌',
  neutral: '中性',
};

export const DIR_ARROW = {
  up: '▲',
  down: '▼',
  neutral: '◆',
};

export const DIR_EN = {
  up: 'UP BIAS',
  down: 'DOWN BIAS',
  neutral: 'NO EDGE',
};

export const KIND_TEXT = {
  iceberg: '冰山',
  spoof: '撤单',
  whale: '大单',
  liquidation: '强平',
};

export const KIND_EN = {
  iceberg: 'ICEBERG',
  spoof: 'SPOOF',
  whale: 'WHALE',
  liquidation: 'LIQ',
};

export const SIGNAL_KEY_TEXT = {
  book: '盘口失衡',
  walls: '墙/冰山吸收',
  liquidations: '清算燃料',
  flow: '主动流',
  vacuum: '流动性真空',
};

/** Escape text for safe innerHTML interpolation. */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build one element from an HTML string. */
export function frag(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** Set textContent only when it changed (avoids pointless layout work). */
export function setTxt(node, text) {
  if (!node) return;
  const next = String(text == null ? '—' : text);
  if (node.textContent !== next) node.textContent = next;
}

export function setClass(node, name, on) {
  if (!node) return;
  node.classList.toggle(name, !!on);
}

export function setHTML(node, html) {
  if (!node) return;
  if (node.__html !== html) {
    node.innerHTML = html;
    node.__html = html;
  }
}

/** requestAnimationFrame-based coalescing wrapper. */
export function rafCoalesce(fn) {
  let queued = false;
  let lastArgs = null;
  return function schedule(...args) {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/** True when the browser asks for reduced motion right now. */
export function reducedMotion() {
  return REDUCED_MOTION.matches;
}

export function prefersReducedMotion() {
  return REDUCED_MOTION.matches;
}

/** Fairly robust numeric read with fallback. */
export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Percent distance of `price` from `basis`, signed. */
export function pctFrom(price, basis) {
  if (!basis) return 0;
  return ((price - basis) / basis) * 100;
}
