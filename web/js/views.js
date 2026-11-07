/* MIN·RESISTANCE — view layer: builds the hero cards and analysis panels once,
   then patches them in place on every snapshot (no re-render churn). */

import { createChart } from './charts.js';
import {
  clamp,
  esc,
  fmtClock,
  fmtDurationZh,
  fmtFunding,
  fmtHMS,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtQtyCompact,
  fmtUsdCompact,
  fmtUsdCompactSigned,
  frag,
  num,
  relZh,
  setClass,
  setHTML,
  setTxt,
  tone,
  DIR_ARROW,
  DIR_EN,
  DIR_TEXT,
  KIND_TEXT,
} from './util.js';

const PANEL_KINDS = ['depth', 'friction', 'liqmap', 'ladder', 'flow', 'signals', 'accuracy'];
const LADDER_ROWS = 14;

const SIDE_TEXT = { bid: '买', ask: '卖', buy: '买', sell: '卖', long: '多', short: '空' };
const SIDE_TONE = { bid: 'up', ask: 'down', buy: 'up', sell: 'down', long: 'down', short: 'up' };

/** Normalize seconds or milliseconds epoch to milliseconds. */
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  return n > 1e12 ? n : n * 1000;
}

function signed(n, digits = 3) {
  const v = Number(n) || 0;
  return (v > 0 ? '+' : '') + fmtNum(v, digits);
}

function toneClass(n, eps = 0) {
  const v = Number(n) || 0;
  if (v > eps) return 'up';
  if (v < -eps) return 'down';
  return 'flat';
}

function statCell(label, field) {
  return `<div class="stat"><span class="micro">${label}</span><b data-f="${field}">—</b><i data-f="${field}-sub">—</i></div>`;
}

/* ------------------------------------------------------------------ */
/* compass                                                             */
/* ------------------------------------------------------------------ */

function compassSvg() {
  const cx = 110;
  const cy = 86;
  const r = 70;
  const pt = (deg, rad) => [
    (cx + rad * Math.cos((deg * Math.PI) / 180)).toFixed(1),
    (cy + rad * Math.sin((deg * Math.PI) / 180)).toFixed(1),
  ];
  let ticks = '';
  for (let i = 0; i <= 8; i++) {
    const deg = 180 + (i / 8) * 180;
    const major = i % 2 === 0;
    const [x1, y1] = pt(deg, major ? 57 : 62);
    const [x2, y2] = pt(deg, 70);
    ticks += `<line class="cp-tick${major ? ' major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return `<svg class="cp-svg" viewBox="0 0 220 112" role="img" aria-label="买卖压力方向罗盘">
    <path class="cp-arc-bg" d="M40 86 A70 70 0 0 1 180 86"/>
    <path class="cp-arc-side rose" d="M40 86 A70 70 0 0 1 110 16"/>
    <path class="cp-arc-side mint" d="M110 16 A70 70 0 0 1 180 86"/>
    ${ticks}
    <text class="cp-lbl" x="40" y="105" text-anchor="middle" fill="#ff5f7a" opacity="0.7">下行</text>
    <text class="cp-lbl" x="110" y="105" text-anchor="middle" fill="#6b7a8d">均衡</text>
    <text class="cp-lbl" x="180" y="105" text-anchor="middle" fill="#3ef0b2" opacity="0.7">上行</text>
    <g class="cp-needle" data-needle>
      <line class="needle-halo" x1="110" y1="86" x2="110" y2="28" stroke="#9aa8ba"/>
      <line x1="110" y1="86" x2="110" y2="28" stroke="#9aa8ba"/>
    </g>
    <circle class="cp-hub-outer" cx="110" cy="86" r="6.5"/>
    <circle class="cp-hub-inner" cx="110" cy="86" r="2.2"/>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* hero symbol card                                                    */
/* ------------------------------------------------------------------ */

function buildHeroCard(info) {
  const el = frag(`
  <article class="sym-card" data-tone="flat" data-sym="${esc(info.key)}">
    <div class="sc-head">
      <div class="sc-id">
        <span class="sc-sym">${esc(info.display)}<small>${esc(info.key.replace(info.display, '') || 'USDT')}</small></span>
        <span class="sc-pair">USDⓈ-M PERP</span>
      </div>
      <div class="sc-ready" data-f="ready"><i></i><span>BOOK</span></div>
    </div>
    <div class="sc-main">
      <div class="sc-price-wrap">
        <div class="sc-price-label"><span class="micro">LAST PRICE / 最新价</span><span class="live-tick" data-f="tick">● LIVE</span></div>
        <div class="sc-price" data-f="price">—</div>
        <div class="sc-chg">
          <span class="chg-num" data-f="chg">—</span>
          <span class="chg-abs" data-f="chg-abs">—</span>
          <span class="micro">24H · ${esc(info.display)}USDT</span>
        </div>
      </div>
      <div class="compass" aria-label="阻力平衡">
        ${compassSvg()}
      </div>
    </div>
    <div class="cp-balance" aria-hidden="true">
      <span class="b" data-f="bal-b" style="width:50%"></span>
      <span class="a" data-f="bal-a" style="width:50%"></span>
    </div>
    <div class="cp-legend">
      <span class="mint">买盘 <b data-f="bid-depth">—</b></span>
      <span class="rose">卖盘 <b data-f="ask-depth">—</b></span>
    </div>
    <div class="cp-verdict" data-f="verdict">等待盘口…</div>
    <div class="range-wrap">
      <div class="range-top">
        <span>24H LOW <b data-f="low">—</b></span>
        <span><span class="micro">24H RANGE</span></span>
        <span>24H HIGH <b data-f="high">—</b></span>
      </div>
      <div class="range-bar"><span class="range-pin" data-f="pin" style="left:50%"></span></div>
    </div>
    <div class="stat-grid">
      ${statCell('MARK', 'mark')}
      ${statCell('INDEX', 'index')}
      ${statCell('FUNDING', 'funding')}
      ${statCell('OPEN INT', 'oi')}
      ${statCell('24H VOL', 'vol')}
      ${statCell('SPREAD', 'spread')}
    </div>
    <div class="pred" data-f="pred" data-dir="neutral">
      <div class="pred-head">
        <span class="pred-dir" data-f="pred-dir" data-dir="neutral"><span class="dir-ico">◆</span>中性 <em>NO EDGE</em></span>
        <span class="pred-conf" data-f="pred-conf">CONF —</span>
      </div>
      <div class="pbar"><span data-f="pbar" style="width:50%"></span></div>
      <div class="pred-grid">
        <div class="pg"><span class="micro">P(UP)</span><b data-f="p-up">—</b></div>
        <div class="pg"><span class="micro">目标价</span><b data-f="target">—</b></div>
        <div class="pg"><span class="micro">失效价</span><b data-f="invalid">—</b></div>
        <div class="pg"><span class="micro">视界</span><b data-f="horizon">—</b></div>
      </div>
      <p class="pred-narrative" data-f="narrative">—</p>
      <div class="levels" data-f="levels"></div>
    </div>
    <div class="spark-wrap"><canvas></canvas><div class="chart-tip"></div><span class="spark-cap micro">1M · 近 60 分钟</span></div>
  </article>`);

  const q = (sel) => el.querySelector(sel);
  const refs = {
    ready: q('[data-f="ready"]'),
    tick: q('[data-f="tick"]'),
    price: q('[data-f="price"]'),
    chg: q('[data-f="chg"]'),
    chgAbs: q('[data-f="chg-abs"]'),
    low: q('[data-f="low"]'),
    high: q('[data-f="high"]'),
    pin: q('[data-f="pin"]'),
    needle: q('[data-needle]'),
    balB: q('[data-f="bal-b"]'),
    balA: q('[data-f="bal-a"]'),
    bidDepth: q('[data-f="bid-depth"]'),
    askDepth: q('[data-f="ask-depth"]'),
    verdict: q('[data-f="verdict"]'),
    pred: q('[data-f="pred"]'),
    predDir: q('[data-f="pred-dir"]'),
    predConf: q('[data-f="pred-conf"]'),
    pbar: q('[data-f="pbar"]'),
    pUp: q('[data-f="p-up"]'),
    target: q('[data-f="target"]'),
    invalid: q('[data-f="invalid"]'),
    horizon: q('[data-f="horizon"]'),
    narrative: q('[data-f="narrative"]'),
    levels: q('[data-f="levels"]'),
  };
  const stat = (f) => [q(`[data-f="${f}"]`), q(`[data-f="${f}-sub"]`)];

  const sparkWrap = q('.spark-wrap');

  const update = (s, now, mock) => {
    const pct = num(s.change_24h_pct);
    el.dataset.tone = toneClass(pct, 0.0005);
    const price = num(s.price != null ? s.price : s.mid);
    setTxt(refs.price, fmtPrice(price));
    if (refs.tick) {
      setTxt(refs.tick, mock ? '● MOCK' : '● LIVE');
      setClass(refs.tick, 'is-sim', !!mock);
    }

    refs.chg.textContent = fmtPct(pct, 2, true);
    refs.chg.className = `chg-num ${toneClass(pct, 0.0005)}`;
    if (price > 0 && pct > -100) {
      const open = price / (1 + pct / 100);
      refs.chgAbs.textContent = `${price - open >= 0 ? '+' : ''}${fmtPrice(price - open)}`;
    } else {
      refs.chgAbs.textContent = '—';
    }

    refs.low.textContent = fmtPrice(s.low_24h);
    refs.high.textContent = fmtPrice(s.high_24h);
    const hi = num(s.high_24h);
    const lo = num(s.low_24h);
    if (hi > lo) {
      refs.pin.style.left = `${clamp(((price - lo) / (hi - lo)) * 100, 0, 100)}%`;
      refs.pin.className = `range-pin is-${el.dataset.tone}`;
    }

    const ob = s.orderbook || {};
    const bid = num(ob.bid_depth_usd);
    const ask = num(ob.ask_depth_usd);
    const totalDepth = bid + ask;
    const bias = totalDepth > 0 ? (bid - ask) / totalDepth : 0;
    const angle = clamp(bias * 7, -0.98, 0.98) * 90;
    if (refs.needle) {
      refs.needle.style.transform = `rotate(${angle.toFixed(2)}deg)`;
      refs.needle.classList.toggle('is-up', bias > 0.004);
      refs.needle.classList.toggle('is-down', bias < -0.004);
      refs.needle.classList.toggle('is-flat', Math.abs(bias) <= 0.004);
    }
    setTxt(refs.bidDepth, `$${fmtUsdCompact(bid)}`);
    setTxt(refs.askDepth, `$${fmtUsdCompact(ask)}`);
    const balB = clamp(50 + bias * 50, 3, 97);
    if (refs.balB) refs.balB.style.width = `${balB.toFixed(2)}%`;
    if (refs.balA) refs.balA.style.width = `${(100 - balB).toFixed(2)}%`;

    let verdict;
    if (bias > 0.012) verdict = '买盘更厚 <em>UP RESISTANCE LOWER</em>';
    else if (bias < -0.012) verdict = '卖盘更厚 <em>DOWN RESISTANCE LOWER</em>';
    else verdict = '两侧势均力敌 <em>BALANCED</em>';
    setHTML(refs.verdict, verdict);

    const ready = !!s.ready && !!ob.mid;
    setClass(refs.ready, 'is-on', ready);
    const readyTxt = refs.ready.querySelector('span');
    if (readyTxt) setTxt(readyTxt, ready ? 'BOOK READY' : 'BOOK SYNC');

    const [mark, markSub] = stat('mark');
    setTxt(mark, fmtPrice(s.mark_price));
    setTxt(markSub, '标记价格');
    const [index, indexSub] = stat('index');
    setTxt(index, fmtPrice(s.index_price));
    setTxt(indexSub, price ? `基差 ${fmtPct(((num(s.mark_price) - num(s.index_price)) / (num(s.index_price) || 1)) * 100, 3, true)}` : '现货指数');
    const [funding, fundingSub] = stat('funding');
    setTxt(funding, fmtFunding(s.funding_rate));
    const fr = num(s.funding_rate);
    funding.className = fr > 1e-9 ? 'up' : fr < -1e-9 ? 'down' : '';
    setTxt(fundingSub, `下次 ${fmtHMS(toMs(s.next_funding_ts))}`);
    const [oi, oiSub] = stat('oi');
    setTxt(oi, fmtQtyCompact(s.open_interest));
    setTxt(oiSub, `$${fmtUsdCompact(num(s.open_interest) * price)} 名义`);
    const [vol, volSub] = stat('vol');
    setTxt(vol, `$${fmtUsdCompact(num(s.quote_volume_24h))}`);
    setTxt(volSub, '24H 成交额');
    const [spread, spreadSub] = stat('spread');
    setTxt(spread, `${fmtNum(num(ob.spread_bps), 2)} bps`);
    setTxt(spreadSub, `1% 失衡 ${fmtPct(num(ob.imbalance_1pct) * 100, 1, true)}`);

    const pred = s.prediction || {};
    const dir = pred.direction === 'up' || pred.direction === 'down' ? pred.direction : 'neutral';
    refs.pred.dataset.dir = dir;
    refs.predDir.dataset.dir = dir;
    setHTML(
      refs.predDir,
      `<span class="dir-ico">${DIR_ARROW[dir]}</span>${DIR_TEXT[dir]} <em>${DIR_EN[dir]}</em>`
    );
    const pUp = clamp(num(pred.p_up), 0, 1);
    const conf = clamp(num(pred.confidence), 0, 1);
    setTxt(refs.predConf, `CONF ${fmtPct(conf * 100, 0, false)} · ${num(pred.horizon_min, 15)}M`);
    if (refs.pbar) refs.pbar.style.width = `${(pUp * 100).toFixed(1)}%`;
    setTxt(refs.pUp, fmtPct(pUp * 100, 1, false));
    const hasTarget = pred.target_price != null && Number.isFinite(Number(pred.target_price));
    const hasInvalid = pred.invalidation_price != null && Number.isFinite(Number(pred.invalidation_price));
    setTxt(refs.target, hasTarget ? fmtPrice(pred.target_price) : '—');
    setTxt(refs.invalid, hasInvalid ? fmtPrice(pred.invalidation_price) : '—');
    refs.target.className = hasTarget ? 'mint' : 'muted';
    refs.invalid.className = hasInvalid ? 'rose' : 'muted';
    refs.target.title = hasTarget ? '' : '中性预测不设目标价';
    refs.invalid.title = hasInvalid ? '' : '中性预测不设失效价';
    setTxt(refs.horizon, `${num(pred.horizon_min, 15)} 分钟`);
    setTxt(refs.narrative, pred.narrative || '—');
    const levels = Array.isArray(pred.levels) ? pred.levels.slice(0, 4) : [];
    setHTML(
      refs.levels,
      levels
        .map((lv) => {
          const kind = lv.kind === 'liq' ? 'liq' : 'wall';
          const label = esc(lv.label || (kind === 'liq' ? '清算' : '墙体'));
          return `<span class="lvl" data-kind="${kind}" title="${esc(label)} · 距离 ${fmtPct(num(lv.dist_pct), 2, true)}"><i class="ln"></i><b>${fmtPrice(lv.price)}</b>${label}</span>`;
        })
        .join('')
    );
    refs.levels.style.display = levels.length ? '' : 'none';
  };

  return { el, update, chartSpecs: [{ kind: 'spark', selector: '.spark-wrap' }], charts: {} };
}

/* ------------------------------------------------------------------ */
/* generic panel shell                                                 */
/* ------------------------------------------------------------------ */

function shell(kind, info, tags, body) {
  return `<article class="panel panel--${kind}" data-sym="${esc(info.key)}">
    <header class="panel-head">
      <div class="ph-id"><span class="ph-sym">${esc(info.display)}</span><span class="ph-pair">${esc(info.key)} · PERP</span></div>
      <div class="ph-tags">${tags}</div>
    </header>
    <div class="panel-body">${body}</div>
  </article>`;
}

/* ------------------------------------------------------------------ */
/* 01 depth profile                                                    */
/* ------------------------------------------------------------------ */

function buildDepthPanel(info) {
  const el = frag(
    shell(
      'depth',
      info,
      `<span class="tag" data-tag="walls">墙体 —</span><span class="tag cyan">模型热力</span><span class="tag">±3%</span>`,
      `<div class="kpi-row">
        <div class="kpi"><span class="k">买盘深度 BID</span><b class="v mint" data-f="bid">—</b><span class="s" data-f="bid-s">—</span></div>
        <div class="kpi"><span class="k">卖盘深度 ASK</span><b class="v rose" data-f="ask">—</b><span class="s" data-f="ask-s">—</span></div>
        <div class="kpi"><span class="k">中间价 / 点差</span><b class="v" data-f="mid">—</b><span class="s" data-f="spread">—</span></div>
      </div>
      <div class="chart-box h-180"><canvas></canvas><div class="chart-tip"></div></div>
      <div class="legend">
        <span class="l-mint"><i></i>买盘挂单</span>
        <span class="l-rose"><i></i>卖盘挂单</span>
        <span class="l-cyan"><i></i>模型清算热力</span>
        <span class="l-amber"><i></i>墙体 / 冰山</span>
      </div>
      <div class="pnl-note"><span class="tag cyan">估算</span><span>青色热力为模型估算，非交易所真实强平；挂单深度为实时订单簿。</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const refs = {
    bid: q('[data-f="bid"]'),
    bidS: q('[data-f="bid-s"]'),
    ask: q('[data-f="ask"]'),
    askS: q('[data-f="ask-s"]'),
    mid: q('[data-f="mid"]'),
    spread: q('[data-f="spread"]'),
    walls: q('[data-tag="walls"]'),
  };
  const update = (s) => {
    const ob = s.orderbook || {};
    const bid = num(ob.bid_depth_usd);
    const ask = num(ob.ask_depth_usd);
    const total = bid + ask;
    setTxt(refs.bid, `$${fmtUsdCompact(bid)}`);
    setTxt(refs.ask, `$${fmtUsdCompact(ask)}`);
    setTxt(refs.bidS, `占比 ${total ? fmtPct((bid / total) * 100, 1, false) : '—'}`);
    setTxt(refs.askS, `占比 ${total ? fmtPct((ask / total) * 100, 1, false) : '—'}`);
    setTxt(refs.mid, fmtPrice(ob.mid != null ? ob.mid : s.price));
    setTxt(refs.spread, `点差 ${fmtNum(num(ob.spread_bps), 2)} bps · 失衡 ${fmtPct(num(ob.imbalance_1pct) * 100, 1, true)}`);
    const walls = Array.isArray(ob.walls) ? ob.walls.length : 0;
    const ice = Array.isArray(ob.icebergs) ? ob.icebergs.length : 0;
    setTxt(refs.walls, `墙体 ${walls} · 冰山 ${ice}`);
  };
  return {
    el,
    update,
    updateChart(charts, s) {
      const ob = s.orderbook || {};
      charts.depth.update({
        profile: ob.profile || [],
        estimated: (s.liquidations && s.liquidations.estimated) || [],
        walls: ob.walls || [],
        mid: ob.mid,
      });
    },
    chartSpecs: [{ kind: 'depth', selector: '.chart-box' }],
    charts: {},
  };
}

/* ------------------------------------------------------------------ */
/* 02 friction                                                         */
/* ------------------------------------------------------------------ */

function frictionCrossing(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  for (let i = 0; i < rows.length - 1; i++) {
    const d0 = num(rows[i].up_usd) - num(rows[i].down_usd);
    const d1 = num(rows[i + 1].up_usd) - num(rows[i + 1].down_usd);
    if (d0 === 0) return { dist: num(rows[i].dist_pct), up: num(rows[i].up_usd) };
    if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
      const t = d0 / (d0 - d1);
      return {
        dist: num(rows[i].dist_pct) + t * (num(rows[i + 1].dist_pct) - num(rows[i].dist_pct)),
        up: num(rows[i].up_usd) + t * (num(rows[i + 1].up_usd) - num(rows[i].up_usd)),
      };
    }
  }
  return null;
}

function nearDist(rows, dist) {
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

function buildFrictionPanel(info) {
  const el = frag(
    shell(
      'friction',
      info,
      `<span class="tag mint">上行</span><span class="tag rose">下行</span><span class="tag" data-tag="cross">交叉 —</span>`,
      `<div class="kpi-row">
        <div class="kpi"><span class="k">上行成本 @1%</span><b class="v mint" data-f="up1">—</b><span class="s">吃掉卖盘所需 USD</span></div>
        <div class="kpi"><span class="k">下行成本 @1%</span><b class="v rose" data-f="down1">—</b><span class="s">吃掉买盘所需 USD</span></div>
        <div class="kpi"><span class="k">更省阻力方向</span><b class="v" data-f="cheaper">—</b><span class="s" data-f="ratio">—</span></div>
      </div>
      <div class="chart-box h-180"><canvas></canvas><div class="chart-tip"></div></div>
      <div class="legend">
        <span class="l-mint"><i class="line"></i>上行累计成本</span>
        <span class="l-rose"><i class="line"></i>下行累计成本</span>
        <span class="l-ink"><i></i>成本交叉点</span>
      </div>
      <div class="pnl-note"><span class="tag">实时</span><span>累计吃单美元越低，该方向阻力越小；交叉点右侧由曲线上方一侧主导。</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const refs = {
    up1: q('[data-f="up1"]'),
    down1: q('[data-f="down1"]'),
    cheaper: q('[data-f="cheaper"]'),
    ratio: q('[data-f="ratio"]'),
    cross: q('[data-tag="cross"]'),
  };
  const update = (s) => {
    const rows = Array.isArray(s.friction) ? s.friction : [];
    const r1 = nearDist(rows, 1);
    const up = r1 ? num(r1.up_usd) : 0;
    const down = r1 ? num(r1.down_usd) : 0;
    setTxt(refs.up1, r1 ? `$${fmtUsdCompact(up)}` : '—');
    setTxt(refs.down1, r1 ? `$${fmtUsdCompact(down)}` : '—');
    if (r1) {
      const cheaper = up < down ? '上行' : down < up ? '下行' : '均衡';
      setTxt(refs.cheaper, cheaper);
      refs.cheaper.className = `v ${up < down ? 'mint' : down < up ? 'rose' : ''}`;
      const ratio = down > 0 ? up / down : null;
      setTxt(refs.ratio, ratio ? `成本比 ${fmtNum(ratio, 2)}× · 上行/下行` : '—');
    } else {
      setTxt(refs.cheaper, '—');
      setTxt(refs.ratio, '—');
    }
    const cross = frictionCrossing(rows);
    setTxt(refs.cross, cross ? `交叉 ${cross.dist.toFixed(2)}%` : '无交叉');
  };
  return {
    el,
    update,
    updateChart(charts, s) {
      charts.friction.update({ friction: s.friction || [], price: s.price });
    },
    chartSpecs: [{ kind: 'friction', selector: '.chart-box' }],
    charts: {},
  };
}

/* ------------------------------------------------------------------ */
/* 03 liquidation map                                                  */
/* ------------------------------------------------------------------ */

function buildLiqPanel(info) {
  const el = frag(
    shell(
      'liqmap',
      info,
      `<span class="tag cyan">模型估算</span><span class="tag amber">非交易所数据</span>`,
      `<div class="kpi-row">
        <div class="kpi"><span class="k">实际强平 24H</span><b class="v" data-f="count">—</b><span class="s" data-f="count-s">交易所 forceOrder</span></div>
        <div class="kpi"><span class="k">实际多头强平</span><b class="v rose" data-f="long">—</b><span class="s">真实成交</span></div>
        <div class="kpi"><span class="k">实际空头强平</span><b class="v mint" data-f="short">—</b><span class="s">真实成交</span></div>
      </div>
      <div class="chart-box h-165"><canvas></canvas><div class="chart-tip"></div></div>
      <div class="legend">
        <span class="l-rose"><i></i>多头强平（下方）</span>
        <span class="l-mint"><i></i>空头强平（上方）</span>
        <span class="l-ink"><i></i>现价</span>
        <span class="l-note">条长 = 估算强平 USD</span>
      </div>
      <div class="pnl-note"><span class="tag cyan">模型</span><span data-f="note">模型估算，非交易所强平数据。</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const refs = {
    count: q('[data-f="count"]'),
    countS: q('[data-f="count-s"]'),
    long: q('[data-f="long"]'),
    short: q('[data-f="short"]'),
    note: q('[data-f="note"]'),
  };
  const update = (s) => {
    const liq = s.liquidations || {};
    const count = num(liq.count);
    setTxt(refs.count, `${count} 笔`);
    setTxt(refs.countS, count ? '交易所真实强平' : '当前窗口无真实强平');
    setTxt(refs.long, `$${fmtUsdCompact(num(liq.total_long_usd))}`);
    setTxt(refs.short, `$${fmtUsdCompact(num(liq.total_short_usd))}`);
    setTxt(refs.note, liq.estimated_note || '模型估算，非交易所强平数据。');
  };
  return {
    el,
    update,
    updateChart(charts, s) {
      const liq = s.liquidations || {};
      const est = (liq.estimated && liq.estimated.length ? liq.estimated : (s.chart && s.chart.estimated_liq) || []);
      charts.liqmap.update({ estimated: est, price: s.price, clusters: liq.clusters || [] });
    },
    chartSpecs: [{ kind: 'liqmap', selector: '.chart-box' }],
    charts: {},
  };
}

/* ------------------------------------------------------------------ */
/* 04 ladder                                                           */
/* ------------------------------------------------------------------ */

function ladderRowsHtml(side) {
  let html = '';
  for (let i = 0; i < LADDER_ROWS; i++) {
    html += `<div class="lrow lrow--${side}" data-i="${i}"><span class="bar"></span><span class="p">—</span><span class="q">—</span><span class="u">—</span></div>`;
  }
  return html;
}

function buildLadderPanel(info) {
  const el = frag(
    shell(
      'ladder',
      info,
      `<span class="tag" data-tag="spread">点差 —</span><span class="tag">28 档</span>`,
      `<div class="ladder">
        <div class="ladder-head"><span>价格 PRICE</span><span>数量 QTY</span><span>累计 USD</span></div>
        <div class="lrows asks" data-l="asks">${ladderRowsHtml('ask')}</div>
        <div class="lmid">
          <b data-f="mid">—</b>
          <span class="lm-spread">点差 <b data-f="spread">—</b></span>
          <span data-f="imb">—</span>
        </div>
        <div class="lrows bids" data-l="bids">${ladderRowsHtml('bid')}</div>
        <div class="ladder-foot">
          <span>买/卖 <b data-f="ratio">—</b></span>
          <span>冰山 <b data-f="ice">—</b></span>
          <span>墙体 <b data-f="walls">—</b></span>
        </div>
      </div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const askRows = Array.from(el.querySelectorAll('[data-l="asks"] .lrow'));
  const bidRows = Array.from(el.querySelectorAll('[data-l="bids"] .lrow'));
  const refs = {
    mid: q('[data-f="mid"]'),
    spread: q('[data-f="spread"]'),
    imb: q('[data-f="imb"]'),
    ratio: q('[data-f="ratio"]'),
    ice: q('[data-f="ice"]'),
    walls: q('[data-f="walls"]'),
    tagSpread: q('[data-tag="spread"]'),
  };

  const paintRows = (rows, levels, maxCum, wallMap, iceMap) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lv = levels[i];
      if (!lv || !Number.isFinite(Number(lv.price))) {
        row.style.display = 'none';
        continue;
      }
      row.style.display = '';
      const price = Number(lv.price);
      const cum = Number(lv.cum_usd) || 0;
      const w = maxCum > 0 ? clamp((cum / maxCum) * 100, 0.5, 100) : 0;
      const bar = row.querySelector('.bar');
      if (bar) bar.style.setProperty('--w', `${w.toFixed(1)}%`);
      setTxt(row.querySelector('.p'), fmtPrice(price));
      setTxt(row.querySelector('.q'), fmtNum(lv.qty, price >= 1000 ? 3 : 2));
      setTxt(row.querySelector('.u'), fmtUsdCompact(cum));
      const wall = wallMap.get(price.toFixed(4));
      const ice = iceMap.has(price.toFixed(4));
      setClass(row, 'is-wall', !!wall || ice);
      setClass(row, 'is-ice', (wall && wall.kind === 'iceberg') || (!wall && ice));
      setClass(row, 'is-spoof', !!wall && wall.kind === 'spoof');
      row.title = `${fmtPrice(price)} · ${fmtNum(lv.qty, 3)} · 累计 $${fmtUsdCompact(cum)}${wall ? ` · 墙体 ${wall.kind}` : ''}`;
    }
  };

  const update = (s) => {
    const ob = s.orderbook || {};
    const ladder = ob.ladder || {};
    const asks = (ladder.asks || []).slice(0, LADDER_ROWS);
    const bids = (ladder.bids || []).slice(0, LADDER_ROWS);
    const walls = Array.isArray(ob.walls) ? ob.walls : [];
    const icebergs = Array.isArray(ob.icebergs) ? ob.icebergs : [];
    const wallMap = new Map();
    for (const w of walls) {
      if (w && Number.isFinite(Number(w.price))) wallMap.set(Number(w.price).toFixed(4), w);
    }
    const iceMap = new Set();
    for (const ice of icebergs) {
      if (ice && Number.isFinite(Number(ice.price))) iceMap.add(Number(ice.price).toFixed(4));
    }
    const displayAsks = asks.slice().reverse();
    const lastAsk = asks.length ? num(asks[asks.length - 1].cum_usd) : 0;
    const lastBid = bids.length ? num(bids[bids.length - 1].cum_usd) : 0;
    const maxCum = Math.max(lastAsk, lastBid, 1);
    paintRows(askRows, displayAsks, maxCum, wallMap, iceMap);
    paintRows(bidRows, bids, maxCum, wallMap, iceMap);
    setTxt(refs.mid, fmtPrice(ob.mid != null ? ob.mid : s.price));
    const spread = fmtNum(num(ob.spread_bps), 2);
    setTxt(refs.spread, `${spread} bps`);
    setTxt(refs.tagSpread, `点差 ${spread} bps`);
    const imb = num(ob.imbalance_1pct) * 100;
    setTxt(refs.imb, `1% 失衡 ${fmtPct(imb, 2, true)}`);
    refs.imb.className = toneClass(imb, 0);
    const ratio = num(ob.ask_depth_usd) > 0 ? num(ob.bid_depth_usd) / num(ob.ask_depth_usd) : null;
    setTxt(refs.ratio, ratio ? fmtNum(ratio, 2) : '—');
    setTxt(refs.ice, String(icebergs.length));
    setTxt(refs.walls, String(walls.length));
  };
  return { el, update, chartSpecs: [], charts: {} };
}

/* ------------------------------------------------------------------ */
/* 05 flow                                                             */
/* ------------------------------------------------------------------ */

function buildFlowPanel(info) {
  const el = frag(
    shell(
      'flow',
      info,
      `<span class="tag" data-tag="window">CVD 15MIN · 10s</span><span class="tag" data-tag="trades">—</span>`,
      `<div class="kpi-row">
        <div class="kpi"><span class="k">主动买入</span><b class="v mint" data-f="buy">—</b><span class="s" data-f="buy-s">—</span></div>
        <div class="kpi"><span class="k">主动卖出</span><b class="v rose" data-f="sell">—</b><span class="s" data-f="sell-s">—</span></div>
        <div class="kpi"><span class="k">净主动流</span><b class="v" data-f="delta">—</b><span class="s" data-f="ratio">—</span></div>
        <div class="kpi"><span class="k">买卖比</span><b class="v" data-f="bs">—</b><span class="s">买 / 卖</span></div>
      </div>
      <div class="ratio-wrap">
        <div class="ratio-bar"><span class="buy" data-f="bar-buy" style="width:50%"></span><span class="sell" data-f="bar-sell" style="width:50%"></span></div>
        <div class="ratio-legend">
          <span class="mint">买 <b data-f="buy-pct">—</b></span>
          <span class="rose">卖 <b data-f="sell-pct">—</b></span>
        </div>
      </div>
      <div class="chart-box h-140"><canvas></canvas><div class="chart-tip"></div></div>
      <div class="tape-head"><span>大单成交 · LARGE TRADES</span><span>USD</span></div>
      <div class="tape" data-f="tape"><div class="empty empty--sm">暂无大额成交</div></div>
      <div class="pnl-note"><span class="tag">窗口</span><span>主动流统计最近 5 分钟；CVD 按 10 秒桶累计近 15 分钟。</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const refs = {
    buy: q('[data-f="buy"]'),
    sell: q('[data-f="sell"]'),
    delta: q('[data-f="delta"]'),
    ratio: q('[data-f="ratio"]'),
    bs: q('[data-f="bs"]'),
    buyS: q('[data-f="buy-s"]'),
    sellS: q('[data-f="sell-s"]'),
    buyPct: q('[data-f="buy-pct"]'),
    sellPct: q('[data-f="sell-pct"]'),
    barBuy: q('[data-f="bar-buy"]'),
    barSell: q('[data-f="bar-sell"]'),
    tape: q('[data-f="tape"]'),
    trades: q('[data-tag="trades"]'),
  };
  let tapeSig = '';

  const update = (s, snap, now) => {
    const flow = s.flow || {};
    const buy = num(flow.buy_usd);
    const sell = num(flow.sell_usd);
    const delta = num(flow.delta_usd);
    const total = buy + sell || 1;
    setTxt(refs.buy, `$${fmtUsdCompact(buy)}`);
    setTxt(refs.sell, `$${fmtUsdCompact(sell)}`);
    setTxt(refs.buyS, `占主动流 ${fmtPct((buy / total) * 100, 1, false)}`);
    setTxt(refs.sellS, `占主动流 ${fmtPct((sell / total) * 100, 1, false)}`);
    setTxt(refs.delta, fmtUsdCompactSigned(delta));
    refs.delta.className = `v ${toneClass(delta, 0)}`;
    setTxt(refs.ratio, `归一化 ${fmtNum(num(flow.ratio), 3)}`);
    const bs = sell > 0 ? buy / sell : null;
    setTxt(refs.bs, bs ? `${fmtNum(bs, 2)}×` : '—');
    setTxt(refs.buyPct, fmtPct((buy / total) * 100, 1, false));
    setTxt(refs.sellPct, fmtPct((sell / total) * 100, 1, false));
    if (refs.barBuy) refs.barBuy.style.width = `${clamp((buy / total) * 100, 0, 100).toFixed(1)}%`;
    if (refs.barSell) refs.barSell.style.width = `${clamp((sell / total) * 100, 0, 100).toFixed(1)}%`;
    setTxt(refs.trades, `${num(flow.trades)} 笔`);

    const large = Array.isArray(flow.large) ? flow.large : [];
    const sig = `${large.length}:${large.length ? large[large.length - 1].ts : 0}:${large.length ? large[0].ts : 0}`;
    if (sig !== tapeSig) {
      tapeSig = sig;
      if (!large.length) {
        setHTML(refs.tape, `<div class="empty empty--sm"><b>暂无大额成交</b><span>单笔 ≥ 阈值的成交会在此滚动</span></div>`);
      } else {
        const rows = large.slice(-8).reverse();
        setHTML(
          refs.tape,
          rows
            .map((tr) => {
              const t = SIDE_TONE[tr.side] || 'mute';
              return `<div class="tr">
                <span>${relZh(toMs(tr.ts), now)}</span>
                <span class="side ${t}">${SIDE_TEXT[tr.side] || '—'}</span>
                <span class="tp">${fmtPrice(tr.price)}</span>
                <span class="usd">$${fmtUsdCompact(tr.usd)}</span>
              </div>`;
            })
            .join('')
        );
      }
    }
  };
  return {
    el,
    update,
    updateChart(charts, s) {
      charts.cvd.update({ cvd: (s.flow && s.flow.cvd) || [] });
    },
    chartSpecs: [{ kind: 'cvd', selector: '.chart-box' }],
    charts: {},
  };
}

/* ------------------------------------------------------------------ */
/* 06 signals                                                          */
/* ------------------------------------------------------------------ */

const SIGNAL_ORDER = ['book', 'walls', 'liquidations', 'flow', 'vacuum'];

function buildSignalsPanel(info) {
  const el = frag(
    shell(
      'signals',
      info,
      `<span class="tag" data-tag="weights">权重合计 100%</span>`,
      `<div class="sig-list">
        <div class="sig-head"><span>信号 SIGNAL</span><span>方向强度</span><span>权重</span><span>贡献</span></div>
        ${SIGNAL_ORDER.map(
          (key) => `<div class="sig-row" data-sig="${key}">
            <div class="sig-label"><b data-f="label">—</b><span data-f="key">${key}</span></div>
            <div class="sig-track"><span class="sig-fill" data-f="fill" style="width:0%"></span></div>
            <span class="sig-w" data-f="weight">—</span>
            <span class="sig-c" data-f="contrib">—</span>
            <div class="sig-detail" data-f="detail">—</div>
          </div>`
        ).join('')}
      </div>
      <div class="sig-sum">
        <div class="ss-left"><span class="micro">加权合计 SCORE</span><b data-f="score">—</b></div>
        <span class="ss-verdict" data-f="verdict">—</span>
      </div>
      <div class="pnl-note"><span class="tag">模型</span><span>分数 = 各信号 × 权重 求和；清算燃料为模型估算，非交易所实际强平。</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const rows = new Map();
  for (const key of SIGNAL_ORDER) {
    const row = el.querySelector(`[data-sig="${key}"]`);
    rows.set(key, {
      row,
      label: row.querySelector('[data-f="label"]'),
      key: row.querySelector('[data-f="key"]'),
      fill: row.querySelector('[data-f="fill"]'),
      weight: row.querySelector('[data-f="weight"]'),
      contrib: row.querySelector('[data-f="contrib"]'),
      detail: row.querySelector('[data-f="detail"]'),
    });
  }
  const refs = { score: q('[data-f="score"]'), verdict: q('[data-f="verdict"]'), weights: q('[data-tag="weights"]') };

  const update = (s, snap) => {
    const pred = s.prediction || {};
    const signals = Array.isArray(s.signals) ? s.signals : [];
    const byKey = new Map(signals.map((sig) => [sig.key, sig]));
    let weightSum = 0;
    for (const key of SIGNAL_ORDER) {
      const ref = rows.get(key);
      const sig = byKey.get(key);
      if (!sig) {
        ref.row.style.display = 'none';
        continue;
      }
      ref.row.style.display = '';
      const score = clamp(num(sig.score), -1, 1);
      const contr = num(sig.contribution);
      weightSum += num(sig.weight);
      setTxt(ref.label, sig.label || key);
      setTxt(ref.key, key.toUpperCase());
      const w = `${(Math.abs(score) * 50).toFixed(1)}%`;
      ref.fill.style.width = w;
      ref.fill.style.left = score >= 0 ? '50%' : `${(50 - Math.abs(score) * 50).toFixed(1)}%`;
      ref.fill.classList.toggle('pos', score >= 0);
      ref.fill.classList.toggle('neg', score < 0);
      setTxt(ref.weight, `${Math.round(num(sig.weight) * 100)}%`);
      setTxt(ref.contrib, signed(contr, 3));
      ref.contrib.className = `sig-c ${contr > 0 ? 'mint' : contr < 0 ? 'rose' : ''}`;
      setTxt(ref.detail, sig.detail || '—');
    }
    const score = num(pred.score);
    setTxt(refs.score, signed(score, 3));
    refs.score.className = score > 0.0001 ? 'mint' : score < -0.0001 ? 'rose' : '';
    const dir = pred.direction === 'up' || pred.direction === 'down' ? pred.direction : 'neutral';
    setTxt(
      refs.verdict,
      `${DIR_TEXT[dir]} · p(up) ${fmtPct(num(pred.p_up) * 100, 1, false)} · 视界 ${num(pred.horizon_min, 15)}m`
    );
    setTxt(refs.weights, `权重合计 ${Math.round(weightSum * 100)}%`);
  };
  return { el, update, chartSpecs: [], charts: {} };
}

/* ------------------------------------------------------------------ */
/* 07 accuracy                                                         */
/* ------------------------------------------------------------------ */

const RING_R = 49;
const RING_C = 2 * Math.PI * RING_R;

function buildAccuracyPanel(info) {
  const el = frag(
    shell(
      'accuracy',
      info,
      `<span class="tag" data-tag="horizon">视界 15m</span>`,
      `<div class="acc-top">
        <div class="acc-ring">
          <svg viewBox="0 0 116 116" aria-hidden="true">
            <circle class="ring-bg" cx="58" cy="58" r="${RING_R}"/>
            <circle class="ring-val" data-f="ring" cx="58" cy="58" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/>
          </svg>
          <div class="ring-core"><b class="is-empty" data-f="rate">—</b><span>HIT RATE</span></div>
        </div>
        <div class="acc-stats">
          <div class="acc-stat"><span class="k">已结算样本</span><b data-f="samples">—</b><span class="s" data-f="samples-s">—</span></div>
          <div class="acc-stat"><span class="k">命中次数</span><b data-f="hits">—</b><span class="s">正确方向</span></div>
          <div class="acc-stat"><span class="k">BRIER 分数</span><b data-f="brier">—</b><span class="s" data-f="brier-s">越低越好</span></div>
          <div class="acc-stat"><span class="k">待结算</span><b data-f="pending">—</b><span class="s" data-f="logged">—</span></div>
        </div>
      </div>
      <div class="acc-hist">
        <div class="acc-hist-head"><span>最近预测 · RECENT</span><span>结果</span></div>
        <div class="acc-rows" data-f="recent"></div>
      </div>
      <div class="acc-legend"><span>结算窗口 15 分钟</span><span>p(up) 为当时上涨概率</span><span>Brier 0 完美</span></div>`
    )
  );
  const q = (s) => el.querySelector(s);
  const refs = {
    ring: q('[data-f="ring"]'),
    rate: q('[data-f="rate"]'),
    samples: q('[data-f="samples"]'),
    samplesS: q('[data-f="samples-s"]'),
    hits: q('[data-f="hits"]'),
    brier: q('[data-f="brier"]'),
    brierS: q('[data-f="brier-s"]'),
    pending: q('[data-f="pending"]'),
    logged: q('[data-f="logged"]'),
    recent: q('[data-f="recent"]'),
    horizon: q('[data-tag="horizon"]'),
  };
  let recentSig = '';

  const update = (s, snap, now) => {
    const acc = s.accuracy || {};
    const samples = num(acc.samples);
    const hits = num(acc.hits);
    const rate = acc.hit_rate == null ? null : clamp(num(acc.hit_rate), 0, 1);
    setTxt(refs.samples, String(samples));
    setTxt(refs.samplesS, `累计记录 ${num(acc.logged)}`);
    setTxt(refs.hits, String(hits));
    setTxt(refs.pending, String(num(acc.pending)));
    setTxt(refs.logged, '等待窗口结算');
    setTxt(refs.horizon, `视界 ${num(acc.horizon_min, 15)}m`);

    if (rate == null) {
      setTxt(refs.rate, '—');
      refs.rate.className = 'is-empty';
      refs.ring.style.strokeDashoffset = `${RING_C.toFixed(2)}`;
      refs.ring.style.stroke = 'rgba(143,163,190,0.4)';
    } else {
      setTxt(refs.rate, fmtPct(rate * 100, 1, false));
      refs.rate.className = '';
      refs.ring.style.strokeDashoffset = `${(RING_C * (1 - rate)).toFixed(2)}`;
      refs.ring.style.stroke = rate >= 0.5 ? 'var(--mint)' : 'var(--rose)';
    }
    const brier = acc.brier;
    if (brier == null) {
      setTxt(refs.brier, '—');
      refs.brier.className = 'ink-3';
      setTxt(refs.brierS, samples ? '结算中' : '样本不足');
    } else {
      setTxt(refs.brier, fmtNum(brier, 3));
      refs.brier.className = num(brier) < 0.25 ? 'mint' : 'rose';
      setTxt(refs.brierS, num(brier) < 0.25 ? '优于随机' : '弱于随机');
    }

    const recent = Array.isArray(acc.recent) ? acc.recent : [];
    const sig = `${recent.length}:${recent.length ? recent[0].ts : 0}:${recent.length ? recent[recent.length - 1].ts : 0}`;
    if (sig !== recentSig) {
      recentSig = sig;
      if (!recent.length) {
        setHTML(
          refs.recent,
          `<div class="empty empty--sm acc-empty"><b>暂无已结算预测</b><span>15 分钟窗口结算后，命中结果会出现在这里</span></div>`
        );
      } else {
        const rows = recent.slice(-6).reverse();
        setHTML(
          refs.recent,
          rows
            .map((r) => {
              const dir = r.direction === 'up' || r.direction === 'down' ? r.direction : 'neutral';
              const resolved = !!r.resolved;
              const move = r.move_pct == null ? null : num(r.move_pct);
              const pill = !resolved
                ? '<span class="pill wait">待结算</span>'
                : r.correct
                ? '<span class="pill ok">HIT</span>'
                : '<span class="pill bad">MISS</span>';
              return `<div class="acc-row">
                <span class="dir ${dir}">${DIR_TEXT[dir]}</span>
                <span>${fmtPct(num(r.p_up) * 100, 1, false)}</span>
                <span class="mute">${relZh(toMs(r.ts), now)}</span>
                <span class="mv ${move == null ? 'flat' : toneClass(move, 0)}">${move == null ? '—' : fmtPct(move, 2, true)}</span>
                <span class="res">${pill}</span>
              </div>`;
            })
            .join('')
        );
      }
    }
  };
  return { el, update, chartSpecs: [], charts: {} };
}

const PANEL_BUILDERS = {
  depth: buildDepthPanel,
  friction: buildFrictionPanel,
  liqmap: buildLiqPanel,
  ladder: buildLadderPanel,
  flow: buildFlowPanel,
  signals: buildSignalsPanel,
  accuracy: buildAccuracyPanel,
};

const PANEL_HOSTS = {
  depth: 'depth-pair',
  friction: 'friction-pair',
  liqmap: 'liqmap-pair',
  ladder: 'ladder-pair',
  flow: 'flow-pair',
  signals: 'signals-pair',
  accuracy: 'accuracy-pair',
};

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

export class Dashboard {
  constructor(root = document) {
    this.root = root;
    this.mounted = false;
    this.symbolOrder = [];
    this.syms = [];
    this.hero = new Map();
    this.panels = new Map();
    this.filter = 'all';
    this.lastSnap = null;
    this.evSig = '';
    this.evRenderAt = 0;
    this.lastEventTs = 0;
    this.heroMeta = root.getElementById('hero-meta');
    this.evFilters = root.getElementById('ev-filters');
    this.evList = root.getElementById('ev-list');
    this.evMeta = root.getElementById('ev-meta');
    this.bindFilters();
  }

  bindFilters() {
    if (!this.evFilters || this.evFilters.__bound) return;
    this.evFilters.__bound = true;
    this.evFilters.addEventListener('click', (e) => {
      const btn = e.target.closest('.ev-filter');
      if (!btn) return;
      const kind = btn.dataset.kind || 'all';
      this.filter = kind;
      for (const b of this.evFilters.querySelectorAll('.ev-filter')) {
        b.classList.toggle('is-active', b === btn);
      }
      this.evSig = '';
      this.evRenderAt = 0;
      this.renderEvents(this.lastSnap, Date.now());
    });
  }

  mount(snap, meta = {}) {
    if (this.mounted || !snap || !snap.symbols) return;
    const order = Array.isArray(snap.symbol_order) && snap.symbol_order.length
      ? snap.symbol_order
      : Object.keys(snap.symbols);
    this.symbolOrder = order.filter((key) => snap.symbols[key]);
    this.syms = this.symbolOrder.map((key) => {
      const s = snap.symbols[key] || {};
      const display = s.display || key.replace(/USDT$/, '');
      return { key, display };
    });

    const heroGrid = this.root.getElementById('hero-grid');
    if (heroGrid) {
      heroGrid.innerHTML = '';
      for (const info of this.syms) {
        const card = buildHeroCard(info);
        heroGrid.appendChild(card.el);
        this.hero.set(info.key, card);
      }
    }

    for (const kind of PANEL_KINDS) {
      const host = this.root.getElementById(PANEL_HOSTS[kind]);
      if (!host) continue;
      host.innerHTML = '';
      for (const info of this.syms) {
        const panel = PANEL_BUILDERS[kind](info);
        host.appendChild(panel.el);
        this.panels.set(`${info.key}:${kind}`, panel);
      }
    }

    /* charts need real layout, so instantiate after mount + first data */
    for (const info of this.syms) {
      const card = this.hero.get(info.key);
      for (const spec of card.chartSpecs || []) {
        const hostEl = card.el.querySelector(spec.selector);
        if (hostEl) card.charts[spec.kind] = createChart(spec.kind, hostEl);
      }
    }
    for (const panel of this.panels.values()) {
      for (const spec of panel.chartSpecs || []) {
        const hostEl = panel.el.querySelector(spec.selector);
        if (hostEl) panel.charts[spec.kind] = createChart(spec.kind, hostEl);
      }
    }

    this.mounted = true;
    this.render(snap, { now: Date.now(), mock: !!meta.mock });
  }

  render(snap, meta = {}) {
    if (!this.mounted || !snap || !snap.symbols) return;
    this.lastSnap = snap;
    const now = meta.now || Date.now();

    for (const key of this.symbolOrder) {
      const s = snap.symbols[key];
      if (!s) continue;
      const card = this.hero.get(key);
      if (card) {
        card.update(s, now, meta.mock);
        if (card.charts.spark && s.chart && s.chart.candles_1m) card.charts.spark.update(s.chart.candles_1m);
      }
      for (const kind of PANEL_KINDS) {
        const panel = this.panels.get(`${key}:${kind}`);
        if (!panel || !panel.update) continue;
        panel.update(s, snap, now);
        if (panel.updateChart && Object.keys(panel.charts).length) panel.updateChart(panel.charts, s);
      }
    }

    this.renderHeroMeta(snap, meta, now);
    this.renderEvents(snap, now);
  }

  renderHeroMeta(snap, meta, now) {
    if (!this.heroMeta) return;
    const total = this.symbolOrder.length;
    let ready = 0;
    for (const key of this.symbolOrder) if (snap.symbols[key] && snap.symbols[key].ready) ready += 1;
    const sim = meta.mock || snap.mode === 'sim';
    const label = meta.mock ? 'MOCK 静态模拟' : snap.mode === 'sim' ? 'SIM 模拟撮合' : 'LIVE 实盘';
    const html = `<span><i class="mode-dot ${sim ? 'mock' : ''}"></i>${label}</span>
      <span>源 <b>${esc((snap.feed && snap.feed.source) || '—')}</b></span>
      <span>订单簿就绪 <b>${ready}/${total}</b></span>
      <span>快照 <b>${fmtHMS(toMs(snap.ts))}</b> UTC+8</span>
      <span class="hm-uptime">运行 <b>${fmtDurationZh(num(snap.uptime_s))}</b></span>`;
    setHTML(this.heroMeta, html);
  }

  renderEvents(snap, now) {
    if (!this.evList || !snap) return;
    const events = Array.isArray(snap.events) ? snap.events : [];
    const counts = { all: events.length };
    for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
    if (this.evFilters) {
      for (const btn of this.evFilters.querySelectorAll('.ev-filter')) {
        const em = btn.querySelector('em');
        if (em) setTxt(em, String(counts[btn.dataset.kind] || 0));
      }
    }
    const filtered = this.filter === 'all' ? events : events.filter((ev) => ev.kind === this.filter);
    const newest = filtered.length ? toMs(filtered[filtered.length - 1].ts) : 0;
    const sig = `${this.filter}:${events.length}:${newest}:${this.lastEventTs}`;
    const due = now - this.evRenderAt > 4000;
    if (sig === this.evSig && !due) return;
    this.evSig = sig;
    this.evRenderAt = now;

    const rows = filtered.slice(-60).reverse();
    if (this.evMeta) {
      setTxt(
        this.evMeta,
        `共 ${events.length} 条 · 显示 ${rows.length} 条${newest ? ` · 最新 ${relZh(newest, now)}` : ''}`
      );
    }
    if (!rows.length) {
      setHTML(
        this.evList,
        `<div class="empty empty--events"><b>暂无 ${this.filter === 'all' ? '' : esc(KIND_TEXT[this.filter] || '')}事件</b><span>盘口出现冰山、撤单诱骗、大额成交或真实强平时会在此追加</span><span class="micro">EVENT TAPE IDLE</span></div>`
      );
      return;
    }
    const isNewRow = newest > this.lastEventTs;
    this.lastEventTs = newest;
    const html = rows
      .map((ev, i) => {
        const kind = ev.kind || 'whale';
        const t = SIDE_TONE[ev.side] || 'mute';
        const cls = kind === 'iceberg' ? 'iceberg' : kind === 'spoof' ? 'spoof' : kind === 'liquidation' ? 'liquidation' : 'whale';
        return `<div class="ev-row${i === 0 && isNewRow ? ' is-new' : ''}">
          <span class="ev-time">${relZh(toMs(ev.ts), now)}</span>
          <span class="kind ${cls}">${KIND_TEXT[kind] || esc(kind)}</span>
          <span class="ev-sym">${esc(ev.display || ev.symbol || '—')}</span>
          <span class="ev-side ${t}">${SIDE_TEXT[ev.side] || '—'}</span>
          <span class="ev-price"><b>${fmtPrice(ev.price)}</b></span>
          <span class="ev-usd">$${fmtUsdCompact(ev.usd)}</span>
          <span class="ev-note" title="${esc(ev.note || '')}">${esc(ev.note || '')}</span>
        </div>`;
      })
      .join('');
    setHTML(this.evList, html);
  }
}

export { toMs, signed };
