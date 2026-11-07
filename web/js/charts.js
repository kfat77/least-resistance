/* MIN·RESISTANCE — hand-drawn Canvas charts (no library).
   Every chart: devicePixelRatio scaling, ResizeObserver, pointer tooltips,
   one-shot entrance animation, reduced-motion aware. */

import { clamp, fmtClock, fmtNum, fmtPrice, fmtUsdCompact, fmtUsdCompactSigned, fmtHMS, fmtPct, fmtDistPct, reducedMotion } from './util.js';

const COL = {
  mint: '#0ecb81',
  rose: '#f6465d',
  cyan: '#2dd4e8',
  amber: '#f0b90b',
  ink: '#eaeef4',
  ink2: '#b9c2ce',
  ink3: '#828e9d',
  ink4: '#5c6876',
  grid: 'rgba(130,142,157,0.1)',
  grid2: 'rgba(130,142,157,0.17)',
};

const MONO_S = '9px ui-monospace, "SF Mono", "Cascadia Mono", monospace';
const MONO_M = '10px ui-monospace, "SF Mono", "Cascadia Mono", monospace';
const SANS_S = '10px -apple-system, "Segoe UI", "PingFang SC", sans-serif';

const rgba = (hex, a) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};

class Chart {
  constructor(host) {
    this.host = host;
    this.canvas = host.querySelector('canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.tip = host.querySelector('.chart-tip');
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.data = null;
    this.pointerX = null;
    this.pointerY = null;
    this.phase = 1;
    this.started = false;
    this.animating = false;
    this.animStart = 0;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (this.canvas) this.bindPointer();
    this.resize();
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener(
      'pointermove',
      (e) => {
        const r = c.getBoundingClientRect();
        this.pointerX = e.clientX - r.left;
        this.pointerY = e.clientY - r.top;
        this.paint();
      },
      { passive: true }
    );
    c.addEventListener('pointerleave', () => {
      this.pointerX = null;
      this.pointerY = null;
      this.hideTip();
      this.paint();
    });
    c.addEventListener('pointercancel', () => {
      this.pointerX = null;
      this.pointerY = null;
      this.hideTip();
      this.paint();
    });
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  update(data) {
    this.data = data;
    if (!this.started) {
      this.started = true;
      if (reducedMotion()) {
        this.phase = 1;
        this.paint();
      } else {
        this.animate();
      }
      return;
    }
    if (!this.animating) this.paint();
  }

  animate() {
    this.animating = true;
    this.animStart = performance.now();
    const tick = (now) => {
      const t = clamp((now - this.animStart) / 720, 0, 1);
      this.phase = 1 - Math.pow(1 - t, 3);
      this.paint();
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        this.animating = false;
        this.phase = 1;
        this.paint();
      }
    };
    requestAnimationFrame(tick);
  }

  reset() {
    const { ctx, w, h } = this;
    if (!ctx) return false;
    ctx.clearRect(0, 0, w, h);
    return true;
  }

  showTip(html, x, y) {
    if (!this.tip) return;
    this.tip.innerHTML = html;
    this.tip.classList.add('is-on');
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let left = x + 14;
    if (left + tw > this.w - 4) left = x - tw - 14;
    left = clamp(left, 4, Math.max(4, this.w - tw - 4));
    let top = y - th - 12;
    if (top < 4) top = y + 18;
    top = clamp(top, 4, Math.max(4, this.h - th - 4));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${top}px`;
  }

  hideTip() {
    if (this.tip) this.tip.classList.remove('is-on');
  }

  msg(text, sub) {
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = SANS_S;
    ctx.fillStyle = COL.ink3;
    ctx.fillText(text, w / 2, h / 2 + (sub ? -7 : 0));
    if (sub) {
      ctx.font = MONO_S;
      ctx.fillStyle = COL.ink4;
      ctx.fillText(sub, w / 2, h / 2 + 10);
    }
  }

  text(str, x, y, align = 'left', color = COL.ink4, font = MONO_S, baseline = 'middle') {
    const { ctx } = this;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(str, x, y);
  }

  dashLine(x1, y1, x2, y2, color = COL.grid, dash = [3, 4], width = 1) {
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Spark: 1m close price, last 60 candles                              */
/* ------------------------------------------------------------------ */

export class Spark extends Chart {
  paint() {
    if (!this.reset()) return;
    const d = this.data;
    const { ctx, w, h } = this;
    if (!d || !d.length) return;
    const rows = d.slice(-64);
    const n = rows.length;
    if (n < 2) return;
    const padT = 6;
    const padB = 4;
    const plotH = h - padT - padB;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of rows) {
      const v = Number(c[4]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const first = Number(rows[0][4]);
    const last = Number(rows[n - 1][4]);
    const up = last >= first;
    const color = up ? COL.mint : COL.rose;
    const xOf = (i) => (i / (n - 1)) * w;
    const yOf = (v, scale = 1) => padT + plotH - ((v - lo) / (hi - lo)) * plotH * scale;
    const p = this.phase;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * p, h);
    ctx.clip();

    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, rgba(color, 0.22));
    grad.addColorStop(1, rgba(color, 0));
    ctx.beginPath();
    ctx.moveTo(xOf(0), h);
    for (let i = 0; i < n; i++) {
      const v = Number(rows[i][4]);
      const y = padT + plotH - ((v - lo) / (hi - lo)) * plotH * (0.18 + 0.82 * p);
      ctx.lineTo(xOf(i), y);
    }
    ctx.lineTo(xOf(n - 1), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = Number(rows[i][4]);
      const y = padT + plotH - ((v - lo) / (hi - lo)) * plotH * (0.18 + 0.82 * p);
      if (i === 0) ctx.moveTo(xOf(i), y);
      else ctx.lineTo(xOf(i), y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    const lastY = yOf(last, 0.18 + 0.82 * p);
    ctx.beginPath();
    ctx.arc(xOf(n - 1), lastY, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xOf(n - 1), lastY, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.16);
    ctx.fill();

    if (this.pointerX != null) {
      const i = clamp(Math.round((this.pointerX / w) * (n - 1)), 0, n - 1);
      const candle = rows[i];
      const v = Number(candle[4]);
      const x = xOf(i);
      const y = padT + plotH - ((v - lo) / (hi - lo)) * plotH;
      this.dashLine(x, padT, x, padT + plotH, rgba(COL.ink3, 0.45), [2, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = COL.ink;
      ctx.fill();
      const chg = first ? ((v - first) / first) * 100 : 0;
      this.showTip(
        `<div class="tp-t">${fmtClock(Number(candle[0])).slice(0, 5)} · 1M</div>` +
          `<div class="tp-r"><span>收盘</span><b>${fmtPrice(v)}</b></div>` +
          `<div class="tp-r"><span>窗口涨跌</span><b class="${chg >= 0 ? 'mint' : 'rose'}">${fmtPct(chg, 2, true)}</b></div>` +
          `<div class="tp-r"><span>成交量</span><b>${fmtNum(candle[5], 3)}</b></div>`,
        this.pointerX,
        this.pointerY
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Depth profile + estimated liquidation heat + wall markers           */
/* ------------------------------------------------------------------ */

export class DepthChart extends Chart {
  paint() {
    const d = this.data;
    if (!d || !d.profile || d.profile.length < 2) {
      this.msg('等待盘口数据', 'DEPTH PROFILE');
      return;
    }
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    const padL = 6;
    const padR = 6;
    const padT = 13;
    const padB = 17;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const base = padT + plotH;
    const prof = d.profile;
    const n = prof.length;
    const pMin = Number(prof[0].price);
    const pMax = Number(prof[n - 1].price);
    if (!(pMax > pMin)) {
      this.msg('盘口区间异常');
      return;
    }
    const xs = (price) => padL + ((price - pMin) / (pMax - pMin)) * plotW;
    const p = this.phase;

    let maxUsd = 0;
    for (const b of prof) {
      maxUsd = Math.max(maxUsd, Number(b.bid_usd) || 0, Number(b.ask_usd) || 0);
    }
    maxUsd = maxUsd || 1;

    /* estimated liquidation heat (model): compact strip along the top edge */
    const est = (d.estimated || []).filter((e) => e && Number.isFinite(Number(e.price)));
    if (est.length) {
      let maxEst = 0;
      for (const e of est) maxEst = Math.max(maxEst, Number(e.long_usd) || 0, Number(e.short_usd) || 0);
      maxEst = maxEst || 1;
      const stripH = 9;
      const step = Math.max(2, plotW / est.length + 0.8);
      for (const e of est) {
        const price = Number(e.price);
        if (price < pMin || price > pMax) continue;
        const total = (Number(e.long_usd) || 0) + (Number(e.short_usd) || 0);
        if (!total) continue;
        const a = Math.min(0.85, (total / maxEst) * 0.8 * p);
        if (a < 0.05) continue;
        const x = xs(price);
        ctx.fillStyle = rgba(COL.cyan, a);
        ctx.fillRect(x - step / 2, padT, step, stripH);
      }
      ctx.fillStyle = rgba(COL.cyan, 0.22);
      ctx.fillRect(padL, padT + stripH, plotW, 1);
    }

    /* grid */
    for (let g = 0; g <= 4; g++) {
      const y = padT + (plotH / 4) * g;
      this.dashLine(padL, y, w - padR, y, COL.grid, [2, 5]);
    }

    /* profile bars */
    const bw = Math.max(1, (plotW / n) * 0.62);
    const bidGrad = ctx.createLinearGradient(0, base, 0, padT);
    bidGrad.addColorStop(0, rgba(COL.mint, 0.42));
    bidGrad.addColorStop(1, rgba(COL.mint, 0.07));
    const askGrad = ctx.createLinearGradient(0, base, 0, padT);
    askGrad.addColorStop(0, rgba(COL.rose, 0.42));
    askGrad.addColorStop(1, rgba(COL.rose, 0.07));

    for (let i = 0; i < n; i++) {
      const b = prof[i];
      const x = padL + (i + 0.5) * (plotW / n) - bw / 2;
      const bid = (Number(b.bid_usd) || 0) / maxUsd;
      const ask = (Number(b.ask_usd) || 0) / maxUsd;
      if (bid > 0) {
        const bh = Math.max(1, bid * plotH * 0.9 * p);
        ctx.fillStyle = bidGrad;
        ctx.fillRect(x, base - bh, bw, bh);
      }
      if (ask > 0) {
        const bh = Math.max(1, ask * plotH * 0.9 * p);
        ctx.fillStyle = askGrad;
        ctx.fillRect(x, base - bh, bw, bh);
      }
    }

    /* walls */
    const walls = d.walls || [];
    for (const wall of walls) {
      const price = Number(wall.price);
      if (!Number.isFinite(price) || price < pMin || price > pMax) continue;
      const x = xs(price);
      const kind = wall.kind;
      const color = kind === 'spoof' ? COL.amber : kind === 'iceberg' ? COL.cyan : COL.ink2;
      this.dashLine(x, padT, x, base, rgba(color, 0.38), [2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padT - 5);
      ctx.lineTo(x + 3, padT - 1.5);
      ctx.lineTo(x, padT + 2);
      ctx.lineTo(x - 3, padT - 1.5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    /* mid line */
    const mid = Number(d.mid);
    if (Number.isFinite(mid) && mid > pMin && mid < pMax) {
      const x = xs(mid);
      this.dashLine(x, padT, x, base, 'rgba(233,239,248,0.3)', [4, 4], 1);
    }

    /* axes */
    this.text(`$${fmtUsdCompact(maxUsd)}`, padL + 2, padT + 20, 'left', 'rgba(154,168,186,0.5)', MONO_S);
    const axisY = h - 6;
    const marks = [-3, -1.5, 1.5, 3];
    for (const m of marks) {
      const price = mid * (1 + m / 100);
      const x = clamp(xs(price), padL, w - padR);
      const align = x < padL + 26 ? 'left' : x > w - padR - 26 ? 'right' : 'center';
      this.text(fmtPct(m, 1, true), x, axisY, align, COL.ink4, MONO_S);
    }
    if (Number.isFinite(mid)) this.text(fmtPrice(mid), xs(mid), axisY, 'center', COL.ink3, MONO_S);
    ctx.strokeStyle = COL.grid2;
    ctx.beginPath();
    ctx.moveTo(padL, base + 1);
    ctx.lineTo(w - padR, base + 1);
    ctx.stroke();

    /* hover */
    if (this.pointerX != null && this.pointerX >= padL && this.pointerX <= w - padR) {
      const idx = clamp(Math.floor(((this.pointerX - padL) / plotW) * n), 0, n - 1);
      const bin = prof[idx];
      const x = padL + (idx + 0.5) * (plotW / n);
      this.dashLine(x, padT, x, base, 'rgba(233,239,248,0.28)', [2, 3]);
      let nearest = null;
      let best = Infinity;
      for (const e of est) {
        const dd = Math.abs(Number(e.price) - Number(bin.price));
        if (dd < best) {
          best = dd;
          nearest = e;
        }
      }
      const rows = [
        `<div class="tp-t">价格 · ${fmtPrice(bin.price)}</div>`,
        `<div class="tp-r"><span>买盘深度</span><b class="mint">$${fmtUsdCompact(bin.bid_usd)}</b></div>`,
        `<div class="tp-r"><span>卖盘深度</span><b class="rose">$${fmtUsdCompact(bin.ask_usd)}</b></div>`,
      ];
      if (nearest) {
        rows.push(
          `<div class="tp-r"><span>模型多头强平</span><b class="rose">$${fmtUsdCompact(nearest.long_usd)}</b></div>`,
          `<div class="tp-r"><span>模型空头强平</span><b class="mint">$${fmtUsdCompact(nearest.short_usd)}</b></div>`
        );
      }
      rows.push(`<div class="tp-r"><span>距中间价</span><b>${fmtDistPct(Number(bin.dist_pct))}</b></div>`);
      this.showTip(rows.join(''), x, this.pointerY);
    } else {
      this.hideTip();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Friction curve: cumulative USD to move up vs down                   */
/* ------------------------------------------------------------------ */

export class FrictionChart extends Chart {
  paint() {
    const d = this.data;
    if (!d || !d.friction || d.friction.length < 2) {
      this.msg('等待摩擦数据', 'FRICTION CURVE');
      return;
    }
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    const rows = d.friction;
    const n = rows.length;
    const padL = 42;
    const padR = 8;
    const padT = 12;
    const padB = 17;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const base = padT + plotH;
    const xMax = Number(rows[n - 1].dist_pct) || 3;
    let yMax = 0;
    for (const r of rows) yMax = Math.max(yMax, Number(r.up_usd) || 0, Number(r.down_usd) || 0);
    yMax = yMax || 1;
    const p = this.phase;
    const xs = (dist) => padL + (dist / xMax) * plotW;
    const ys = (usd) => base - (usd / yMax) * plotH;

    /* y grid */
    for (let g = 0; g <= 3; g++) {
      const v = (yMax / 3) * g;
      const y = ys(v);
      this.dashLine(padL, y, w - padR, y, COL.grid, [2, 5]);
      this.text(`$${fmtUsdCompact(v, 1)}`, padL - 5, y, 'right', COL.ink4, MONO_S);
    }

    const drawSide = (key, color) => {
      ctx.beginPath();
      ctx.moveTo(xs(Number(rows[0].dist_pct)), base);
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        ctx.lineTo(xs(Number(r.dist_pct)), ys((Number(r[key]) || 0) * p));
      }
      ctx.lineTo(xs(Number(rows[n - 1].dist_pct)), base);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, base);
      grad.addColorStop(0, rgba(color, 0.16));
      grad.addColorStop(1, rgba(color, 0.02));
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const r = rows[i];
        const x = xs(Number(r.dist_pct));
        const y = ys((Number(r[key]) || 0) * p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.7;
      ctx.lineJoin = 'round';
      ctx.stroke();
    };

    drawSide('down_usd', COL.rose);
    drawSide('up_usd', COL.mint);

    /* crossing point: first place the two cumulative-cost curves flip order */
    let cross = null;
    for (let i = 0; i < n - 1; i++) {
      const d0 = (Number(rows[i].up_usd) || 0) - (Number(rows[i].down_usd) || 0);
      const d1 = (Number(rows[i + 1].up_usd) || 0) - (Number(rows[i + 1].down_usd) || 0);
      if (d0 === 0) {
        cross = { dist: Number(rows[i].dist_pct), usd: Number(rows[i].up_usd) || 0 };
        break;
      }
      if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
        const t = d0 / (d0 - d1);
        const dist = Number(rows[i].dist_pct) + t * (Number(rows[i + 1].dist_pct) - Number(rows[i].dist_pct));
        const usd = (Number(rows[i].up_usd) || 0) + t * ((Number(rows[i + 1].up_usd) || 0) - (Number(rows[i].up_usd) || 0));
        cross = { dist, usd };
        break;
      }
    }
    if (cross) {
      const x = xs(cross.dist);
      const y = ys(cross.usd * p);
      this.dashLine(x, padT, x, base, 'rgba(233,239,248,0.34)', [3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = COL.ink;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(COL.ink, 0.28);
      ctx.lineWidth = 1;
      ctx.stroke();
      const lbl = `交叉 ${cross.dist.toFixed(2)}%`;
      ctx.font = MONO_S;
      const tw = ctx.measureText(lbl).width;
      const lx = clamp(x + 8, padL, w - padR - tw - 8);
      ctx.fillStyle = 'rgba(5,7,11,0.82)';
      ctx.fillRect(lx - 3, padT - 2, tw + 6, 14);
      this.text(lbl, lx, padT + 5, 'left', COL.ink2, MONO_S);
    }

    /* axes */
    for (const tick of [0.5, 1, 2, 3]) {
      if (tick > xMax + 0.001) continue;
      this.text(fmtPct(tick, tick < 1 ? 1 : 0, false), xs(tick), h - 6, 'center', COL.ink4, MONO_S);
    }
    ctx.strokeStyle = COL.grid2;
    ctx.beginPath();
    ctx.moveTo(padL, base + 1);
    ctx.lineTo(w - padR, base + 1);
    ctx.stroke();

    /* hover */
    if (this.pointerX != null && this.pointerX >= padL && this.pointerX <= w - padR) {
      const dist = ((this.pointerX - padL) / plotW) * xMax;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = Math.abs(Number(rows[i].dist_pct) - dist);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      const r = rows[best];
      const x = xs(Number(r.dist_pct));
      this.dashLine(x, padT, x, base, 'rgba(233,239,248,0.26)', [2, 3]);
      const up = Number(r.up_usd) || 0;
      const down = Number(r.down_usd) || 0;
      const cheaper = up < down ? '上行更省' : down < up ? '下行更省' : '两侧相当';
      const toneCls = up < down ? 'mint' : 'rose';
      this.showTip(
        `<div class="tp-t">距离 · ${fmtDistPct(Number(r.dist_pct))}</div>` +
          `<div class="tp-r"><span>上行成本</span><b class="mint">$${fmtUsdCompact(up)}</b></div>` +
          `<div class="tp-r"><span>下行成本</span><b class="rose">$${fmtUsdCompact(down)}</b></div>` +
          `<div class="tp-r"><span>结论</span><b class="${toneCls}">${cheaper}</b></div>`,
        x,
        this.pointerY
      );
    } else {
      this.hideTip();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Liquidation map: model-estimated long/short fuel by price           */
/* ------------------------------------------------------------------ */

export class LiqMapChart extends Chart {
  paint() {
    const d = this.data;
    const est = d && d.estimated ? d.estimated.filter((e) => e && Number.isFinite(Number(e.price))) : [];
    if (!est.length) {
      this.msg('暂无模型清算估算', 'MODEL ESTIMATE');
      return;
    }
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    const raw = est.slice().sort((a, b) => Number(a.price) - Number(b.price));
    const nRaw = raw.length;
    const bucket = Math.max(1, Math.ceil(nRaw / 44));
    const rows = [];
    for (let i = 0; i < nRaw; i += bucket) {
      const chunk = raw.slice(i, i + bucket);
      const midRow = chunk[Math.floor(chunk.length / 2)];
      let long = 0;
      let short = 0;
      for (const c of chunk) {
        long += Number(c.long_usd) || 0;
        short += Number(c.short_usd) || 0;
      }
      rows.push({
        price: Number(midRow.price),
        long_usd: long / chunk.length,
        short_usd: short / chunk.length,
      });
    }
    const n = rows.length;
    const padL = 56;
    const padR = 8;
    const padT = 11;
    const padB = 14;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const pMin = Number(rows[0].price);
    const pMax = Number(rows[n - 1].price);
    if (!(pMax > pMin)) {
      this.msg('清算估算区间异常');
      return;
    }
    const cx = padL + plotW / 2;
    const halfW = plotW / 2 - 4;
    let maxSide = 0;
    for (const r of rows) maxSide = Math.max(maxSide, Number(r.long_usd) || 0, Number(r.short_usd) || 0);
    maxSide = maxSide || 1;
    const p = this.phase;
    const ys = (price) => padT + (1 - (price - pMin) / (pMax - pMin)) * plotH;
    const rowH = clamp(plotH / n - 1.2, 2.4, 6);

    /* center axis */
    this.dashLine(cx, padT, cx, padT + plotH, 'rgba(143,163,190,0.22)', [2, 4]);

    /* bars */
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const y = ys(Number(r.price)) - rowH / 2;
      const long = (Number(r.long_usd) || 0) / maxSide;
      const short = (Number(r.short_usd) || 0) / maxSide;
      if (long > 0.004) {
        const bw = Math.max(0.6, long * halfW * p);
        ctx.fillStyle = rgba(COL.rose, 0.2 + Math.min(0.5, long * 0.5));
        ctx.fillRect(cx - bw, y, bw, rowH);
      }
      if (short > 0.004) {
        const bw = Math.max(0.6, short * halfW * p);
        ctx.fillStyle = rgba(COL.mint, 0.2 + Math.min(0.5, short * 0.5));
        ctx.fillRect(cx, y, bw, rowH);
      }
    }

    /* price grid labels */
    const labelPrices = [pMax, (pMax + pMin) / 2, pMin];
    for (const price of labelPrices) {
      const y = ys(price);
      this.text(fmtPrice(price), padL - 6, y, 'right', COL.ink4, MONO_S);
      this.dashLine(padL, y, w - padR, y, COL.grid, [2, 5]);
    }

    /* current price */
    const cur = Number(d.price);
    if (Number.isFinite(cur) && cur >= pMin && cur <= pMax) {
      const y = ys(cur);
      this.dashLine(padL, y, w - padR, y, 'rgba(233,239,248,0.45)', [4, 4], 1);
      ctx.beginPath();
      ctx.arc(cx, y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = COL.ink;
      ctx.fill();
      const lbl = `现价 ${fmtPrice(cur)}`;
      ctx.font = MONO_S;
      const tw = ctx.measureText(lbl).width;
      ctx.fillStyle = 'rgba(5,7,11,0.86)';
      ctx.fillRect(w - padR - tw - 6, y - 12, tw + 6, 12);
      this.text(lbl, w - padR - 3, y - 6, 'right', COL.ink2, MONO_S);
    }

    /* side labels */
    this.text('← 多头强平', cx - 6, padT + plotH + 6, 'right', 'rgba(255,95,122,0.6)', MONO_S);
    this.text('空头强平 →', cx + 6, padT + plotH + 6, 'left', 'rgba(62,240,178,0.6)', MONO_S);

    /* hover */
    if (this.pointerX != null && this.pointerY != null) {
      const py = clamp(this.pointerY, padT, padT + plotH);
      const price = pMin + (1 - (py - padT) / plotH) * (pMax - pMin);
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = Math.abs(Number(rows[i].price) - price);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      const r = rows[best];
      const y = ys(Number(r.price));
      this.dashLine(padL, y, w - padR, y, 'rgba(233,239,248,0.22)', [2, 3]);
      const long = Number(r.long_usd) || 0;
      const short = Number(r.short_usd) || 0;
      this.showTip(
        `<div class="tp-t">模型估算 · ${fmtPrice(r.price)}</div>` +
          `<div class="tp-r"><span>多头强平</span><b class="rose">$${fmtUsdCompact(long)}</b></div>` +
          `<div class="tp-r"><span>空头强平</span><b class="mint">$${fmtUsdCompact(short)}</b></div>` +
          `<div class="tp-r"><span>距离现价</span><b>${fmtDistPct(((Number(r.price) - cur) / cur) * 100)}</b></div>`,
        this.pointerX,
        y
      );
    } else {
      this.hideTip();
    }
  }
}

/* ------------------------------------------------------------------ */
/* CVD: cumulative volume delta over the flow window                   */
/* ------------------------------------------------------------------ */

export class CvdChart extends Chart {
  paint() {
    const d = this.data;
    const rows = d && d.cvd ? d.cvd : [];
    if (rows.length < 2) {
      this.msg('等待主动流数据', 'CVD');
      return;
    }
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    const n = rows.length;
    const padL = 46;
    const padR = 8;
    const padT = 11;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const base = padT + plotH;
    let vMin = 0;
    let vMax = 0;
    for (const r of rows) {
      const v = Number(r[1]);
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (vMax === vMin) vMax = vMin + 1;
    const pad = (vMax - vMin) * 0.08;
    vMin -= pad;
    vMax += pad;
    const last = Number(rows[n - 1][1]);
    const color = last >= 0 ? COL.mint : COL.rose;
    const p = this.phase;
    const xs = (i) => padL + (i / (n - 1)) * plotW;
    const ys = (v) => padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;
    const zeroY = ys(0);

    /* grid */
    this.dashLine(padL, padT, w - padR, padT, COL.grid, [2, 5]);
    this.dashLine(padL, base, w - padR, base, COL.grid, [2, 5]);
    this.text(`$${fmtUsdCompact(vMax, 1)}`, padL - 5, padT + 3, 'right', COL.ink4, MONO_S);
    this.text(`$${fmtUsdCompact(vMin, 1)}`, padL - 5, base - 3, 'right', COL.ink4, MONO_S);

    /* zero line */
    this.dashLine(padL, zeroY, w - padR, zeroY, 'rgba(143,163,190,0.28)', [3, 4]);
    this.text('0', padL - 5, zeroY, 'right', COL.ink3, MONO_S);

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT - 2, plotW * p + 1, plotH + 4);
    ctx.clip();

    /* area */
    ctx.beginPath();
    ctx.moveTo(xs(0), zeroY);
    for (let i = 0; i < n; i++) ctx.lineTo(xs(i), ys(Number(rows[i][1])));
    ctx.lineTo(xs(n - 1), zeroY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, base);
    grad.addColorStop(0, rgba(color, 0.2));
    grad.addColorStop(1, rgba(color, 0.02));
    ctx.fillStyle = grad;
    ctx.fill();

    /* line */
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = ys(Number(rows[i][1]));
      if (i === 0) ctx.moveTo(xs(i), y);
      else ctx.lineTo(xs(i), y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    /* end dot */
    const endY = ys(last);
    ctx.beginPath();
    ctx.arc(xs(n - 1), endY, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    /* time labels */
    this.text(fmtHMS(Number(rows[0][0])), padL, h - 5, 'left', COL.ink4, MONO_S);
    this.text(fmtHMS(Number(rows[n - 1][0])), w - padR, h - 5, 'right', COL.ink4, MONO_S);

    /* hover */
    if (this.pointerX != null && this.pointerX >= padL && this.pointerX <= w - padR) {
      const t = (this.pointerX - padL) / plotW;
      const idx = clamp(Math.round(t * (n - 1)), 0, n - 1);
      const x = xs(idx);
      const v = Number(rows[idx][1]);
      this.dashLine(x, padT, x, base, 'rgba(233,239,248,0.26)', [2, 3]);
      ctx.beginPath();
      ctx.arc(x, ys(v), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = v >= 0 ? COL.mint : COL.rose;
      ctx.fill();
      this.showTip(
        `<div class="tp-t">CVD · ${fmtHMS(Number(rows[idx][0]))}</div>` +
          `<div class="tp-r"><span>累计成交差</span><b class="${v >= 0 ? 'mint' : 'rose'}">${fmtUsdCompactSigned(v)}</b></div>`,
        x,
        this.pointerY
      );
    } else {
      this.hideTip();
    }
  }
}

/* ------------------------------------------------------------------ */
/* CandleChart: 1m / 15m candles + volume + overlays + crosshair        */
/* ------------------------------------------------------------------ */

export class CandleChart extends Chart {
  constructor(host) {
    super(host);
    this.pinned = 0;
  }

  setPinned(price) {
    this.pinned = Number(price) || 0;
    if (this.data) this.paint();
  }

  paint() {
    const d = this.data;
    if (!d || !Array.isArray(d.candles) || d.candles.length < 3) {
      this.msg('等待 K 线数据', 'CANDLES · BINANCE USDⓈ-M');
      return;
    }
    if (!this.reset()) return;
    const { ctx, w, h } = this;
    const show = d.show || {};
    const padL = 6;
    const padR = 56;
    const padT = 8;
    const padB = 18;
    const plotW = Math.max(20, w - padL - padR);
    const volH = Math.max(30, Math.round((h - padT - padB) * 0.19));
    const priceH = Math.max(60, h - padT - padB - volH - 9);
    const priceBottom = padT + priceH;
    const volTop = priceBottom + 9;
    const volBottom = h - padB;
    const rows = d.candles.slice(-140);
    const n = rows.length;
    const step = plotW / n;
    const cw = clamp(step * 0.62, 1, 9);
    const p = this.phase;

    let lo = Infinity;
    let hi = -Infinity;
    let maxVol = 0;
    for (const c of rows) {
      const l = Number(c[3]);
      const gh = Number(c[2]);
      if (Number.isFinite(l)) lo = Math.min(lo, l);
      if (Number.isFinite(gh)) hi = Math.max(hi, gh);
      maxVol = Math.max(maxVol, Number(c[5]) || 0);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      this.msg('K 线数据异常');
      return;
    }
    const cur = Number(d.price) || Number(rows[n - 1][4]);
    lo = Math.min(lo, cur);
    hi = Math.max(hi, cur);
    if (this.pinned) {
      lo = Math.min(lo, this.pinned);
      hi = Math.max(hi, this.pinned);
    }
    if (hi <= lo) {
      hi = lo + 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
    const range = hi - lo;
    const xs = (i) => padL + (i + 0.5) * step;
    const ys = (price) => padT + ((hi - price) / range) * priceH * p + (1 - p) * priceH * 0.4;

    /* --- grid --- */
    for (let g = 0; g <= 3; g++) {
      const price = hi - (range * g) / 3;
      const y = padT + (priceH * g) / 3;
      this.dashLine(padL, y, padL + plotW, y, COL.grid, [2, 4]);
      this.text(fmtPrice(price), padL + plotW + 5, y, 'left', COL.ink4, MONO_S);
    }
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(padL, priceBottom + 0.5);
    ctx.lineTo(padL + plotW, priceBottom + 0.5);
    ctx.stroke();

    const tLabel = (ts) => {
      const hhmm = fmtClock(ts);
      return hhmm.slice(0, 5);
    };
    for (let g = 0; g <= 4; g++) {
      const i = Math.min(n - 1, Math.round((n - 1) * (g / 4)));
      const x = xs(i);
      if (g > 0 && g < 4) this.dashLine(x, padT, x, priceBottom, 'rgba(130,142,157,0.045)', [2, 5]);
      this.text(tLabel(Number(rows[i][0])), x, h - 6, g === 0 ? 'left' : g === 4 ? 'right' : 'center', COL.ink4, MONO_S);
    }

    /* --- volume --- */
    for (let i = 0; i < n; i++) {
      const c = rows[i];
      const o = Number(c[1]);
      const cl = Number(c[4]);
      const v = Number(c[5]) || 0;
      const vh = maxVol ? (v / maxVol) * (volBottom - volTop) * 0.9 * p : 0;
      const x = xs(i) - cw / 2;
      ctx.fillStyle = cl >= o ? 'rgba(14,203,129,0.34)' : 'rgba(246,70,93,0.34)';
      if (vh > 0) ctx.fillRect(x, volBottom - vh, cw, vh);
    }

    /* --- moving averages --- */
    const closes = rows.map((c) => Number(c[4]));
    const ma = (len) => closes.map((_, i) => {
      if (i < len - 1) return null;
      let sum = 0;
      for (let k = i - len + 1; k <= i; k++) sum += closes[k];
      return sum / len;
    });
    const drawMa = (len, color) => {
      const vals = ma(len);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (v == null) continue;
        const x = xs(i);
        const y = padT + ((hi - v) / range) * priceH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    if (show.ma) {
      drawMa(7, 'rgba(240,185,11,0.85)');
      drawMa(25, 'rgba(45,212,232,0.75)');
    }

    /* --- liquidation heat strip (model estimate) at right gutter --- */
    if (show.liqs && Array.isArray(d.clusters) && d.clusters.length) {
      let maxTotal = 0;
      for (const cl of d.clusters) maxTotal = Math.max(maxTotal, (Number(cl.long_usd) || 0) + (Number(cl.short_usd) || 0));
      maxTotal = maxTotal || 1;
      for (const cl of d.clusters) {
        const price = Number(cl.price);
        if (!(price > lo && price < hi)) continue;
        const total = (Number(cl.long_usd) || 0) + (Number(cl.short_usd) || 0);
        if (!total) continue;
        const y = padT + ((hi - price) / range) * priceH;
        const a = 0.16 + 0.44 * clamp(total / maxTotal, 0, 1);
        ctx.fillStyle = rgba(COL.cyan, a * p);
        ctx.fillRect(padL + plotW + 1, y - 1.5, 4, 3);
      }
    }

    /* --- walls / icebergs: right-edge markers + faint level line --- */
    if (show.walls) {
      const walls = Array.isArray(d.walls) ? d.walls.slice(0, 10) : [];
      for (const wall of walls) {
        const price = Number(wall.price);
        if (!(price > lo && price < hi)) continue;
        const y = padT + ((hi - price) / range) * priceH;
        const kind = wall.kind || 'resting';
        const color = kind === 'iceberg' ? COL.cyan : kind === 'spoof' ? COL.amber : COL.ink3;
        this.dashLine(padL + plotW * 0.58, y, padL + plotW, y, rgba(color, 0.3), [2, 4]);
        ctx.fillStyle = rgba(color, 0.9);
        const dir = wall.side === 'bid' ? 1 : -1;
        const ax = padL + plotW + 4;
        ctx.beginPath();
        ctx.moveTo(ax, y);
        ctx.lineTo(ax + 5, y - 3 * dir);
        ctx.lineTo(ax + 5, y + 3 * dir);
        ctx.closePath();
        ctx.fill();
      }
    }

    /* --- candles --- */
    for (let i = 0; i < n; i++) {
      const c = rows[i];
      const o = Number(c[1]);
      const gh = Number(c[2]);
      const l = Number(c[3]);
      const cl = Number(c[4]);
      if (![o, gh, l, cl].every(Number.isFinite)) continue;
      const up = cl >= o;
      const color = up ? COL.mint : COL.rose;
      const x = xs(i);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, ys(gh));
      ctx.lineTo(Math.round(x) + 0.5, ys(l));
      ctx.stroke();
      const yO = ys(o);
      const yC = ys(cl);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = color;
      if (cw >= 3) ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, bh);
      else ctx.fillRect(x, Math.min(yO, yC), Math.max(1, cw), bh);
    }

    /* --- current price line + tag --- */
    const cy = ys(cur);
    this.dashLine(padL, cy, padL + plotW, cy, 'rgba(240,185,11,0.75)', [4, 4], 1);
    ctx.fillStyle = COL.amber;
    ctx.fillRect(padL + plotW + 1, cy - 8, padR - 2, 16);
    this.text(fmtPrice(cur), w - 4, cy, 'right', '#10151b', MONO_M);

    /* --- pinned price line --- */
    if (this.pinned) {
      const py = ys(this.pinned);
      this.dashLine(padL, py, padL + plotW, py, 'rgba(45,212,232,0.7)', [3, 4], 1);
      const label = `点击 ${fmtPrice(this.pinned)}`;
      ctx.font = MONO_S;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(11,14,17,0.9)';
      ctx.fillRect(padL + plotW - tw - 8, py - 14, tw + 8, 13);
      this.text(label, padL + plotW - 4, py - 7, 'right', COL.cyan, MONO_S);
    }

    /* --- crosshair + tooltip --- */
    if (this.pointerX != null && this.pointerX >= padL && this.pointerX <= padL + plotW) {
      const idx = clamp(Math.floor((this.pointerX - padL) / step), 0, n - 1);
      const c = rows[idx];
      const o = Number(c[1]);
      const gh = Number(c[2]);
      const l = Number(c[3]);
      const cl = Number(c[4]);
      const v = Number(c[5]) || 0;
      const x = xs(idx);
      this.dashLine(x, padT, x, volBottom, 'rgba(234,238,244,0.26)', [2, 3]);
      if (this.pointerY != null && this.pointerY >= padT && this.pointerY <= priceBottom) {
        const hoverPrice = hi - ((this.pointerY - padT) / priceH) * range;
        this.dashLine(padL, this.pointerY, padL + plotW, this.pointerY, 'rgba(234,238,244,0.16)', [2, 3]);
        ctx.fillStyle = 'rgba(30,36,45,0.95)';
        ctx.fillRect(w - padR + 1, this.pointerY - 8, padR - 2, 16);
        this.text(fmtPrice(hoverPrice), w - 4, this.pointerY, 'right', COL.ink2, MONO_M);
      }
      const up = cl >= o;
      const chg = o ? ((cl - o) / o) * 100 : 0;
      this.showTip(
        `<div class="tp-t">${fmtClock(Number(c[0]))} · ${d.period === '15m' ? '15M' : '1M'}</div>` +
          `<div class="tp-r"><span>开 / 高</span><b>${fmtPrice(o)} / ${fmtPrice(gh)}</b></div>` +
          `<div class="tp-r"><span>低 / 收</span><b>${fmtPrice(l)} / ${fmtPrice(cl)}</b></div>` +
          `<div class="tp-r"><span>涨跌</span><b class="${up ? 'up' : 'down'}">${fmtPct(chg, 2, true)}</b></div>` +
          `<div class="tp-r"><span>成交量</span><b>${fmtNum(v, 3)}</b></div>`,
        x,
        this.pointerY == null ? padT + 20 : this.pointerY
      );
    } else {
      this.hideTip();
    }
  }
}

/** Create a chart by kind for a host element. */
export function createChart(kind, host) {
  let chart = null;
  switch (kind) {
    case 'spark':
      chart = new Spark(host);
      break;
    case 'candle':
      chart = new CandleChart(host);
      break;
    case 'depth':
      chart = new DepthChart(host);
      break;
    case 'friction':
      chart = new FrictionChart(host);
      break;
    case 'liqmap':
      chart = new LiqMapChart(host);
      break;
    case 'cvd':
      chart = new CvdChart(host);
      break;
    default:
      return null;
  }
  const canvas = chart && chart.canvas;
  if (canvas) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', CHART_LABELS[kind] || '行情图表');
  }
  return chart;
}

const CHART_LABELS = {
  spark: '近 60 分钟价格迷你走势图',
  candle: 'K 线主图，含成交量、当前价线、墙与冰山标记',
  depth: '订单簿深度剖面与模型清算热力',
  friction: '上行与下行累计摩擦成本曲线',
  liqmap: '模型估算强平地图',
  cvd: '累计成交量差 CVD 曲线',
};

export { COL, MONO_S, MONO_M, rgba, fmtNum };
