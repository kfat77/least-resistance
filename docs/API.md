# MIN-RESISTANCE 数据接口与前端契约

后端：`http://127.0.0.1:8765`。前端是纯静态文件，位于 `web/`，不依赖构建步骤或外部 CDN。
核心思想只有一条：**价格沿阻力最小的方向移动**。网页上所有信息都服务于这个判断。

## 1. 接口

| 路径 | 说明 |
| --- | --- |
| `GET /` | 页面（`web/index.html`） |
| `GET /api/snapshot` | 完整快照 JSON，结构与 WS 首帧一致 |
| `GET /ws` | WebSocket，服务端约每 900ms 推送一帧完整快照（客户端只收不发） |
| `GET /api/health` | 连接/数据源健康状态 |
| `GET /mock/snapshot.json` | 静态 mock 快照，供无后端时开发/截图 |

WS 是纯推送：每帧就是完整的 snapshot 对象，不做增量。断线自动重连即可。
开发时可在 URL 加 `?mock=1` 直接读取 `/mock/snapshot.json`（由前端实现）。

## 1.1 静态版（GitHub Pages）

在线站点没有 HTTP 服务端：`web/js/engine-worker.js` 在 Web Worker 里用 Pyodide
加载 `py/server/*.py`，浏览器直连币安公共行情；`web/js/app-client.js` 消费同一份
snapshot 结构并交给现有 Dashboard 渲染。相比后端快照，静态版多两个顶层字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `market` | `futures` / `spot` | 实际使用的数据源；期货接口不可达时自动回退现货 |
| `market_label` | `USDⓈ-M PERP` / `现货 SPOT` | 用于页面诚实标注 |

`feed.source` 相应为 `binance-usdm` 或 `binance-spot`；现货回退时
`feed.note` 说明回退原因，`mark_price` / `index_price` / `funding_rate` /
`open_interest` 为 `null`，真实强平为 0，清算带只有模型估算。

## 2. 顶层快照

```json
{
  "ts": 1794038569071,
  "mode": "live",              // live | sim
  "base_mode": "live",
  "version": "1.0.0",
  "uptime_s": 182.4,
  "feed": { ... },
  "symbol_order": ["BTCUSDT", "ETHUSDT"],
  "symbols": { "BTCUSDT": { ... }, "ETHUSDT": { ... } },
  "events": [ ... ],
  "model": {
    "name": "least-resistance",
    "horizon_min": 15,
    "weights": { "book": 0.3, "walls": 0.24, "liquidations": 0.22, "flow": 0.14, "vacuum": 0.1 },
    "wall_mode": "barrier",
    "wall_mode_alt": "magnet",
    "wall_modes": ["barrier", "magnet"],
    "ab_started": 1794173466069,
    "disclaimer": "仅供研究，不构成投资建议"
  }
}
```

`wall_mode` 是当前展示模式；`wall_mode_alt` 是并行记账的影子模式。`ab_started`
（毫秒）是本次 A/B 的实验起点，只有该时间之后的样本计入 `accuracy_ab` 与
`accuracy_alt_ab`，历史账本不参与对照。

`feed`：`{state, source, last_msg_ts, last_msg_age_s, error, spot, symbols: {SYM: {connected, book_ready, reconnects, resyncs, messages, last_msg_age_s, stale}}}`。
`feed.spot` 是现货成交镜像流的状态（`connecting` / `live` / `reconnecting: ...`），仅 live 模式存在。

## 3. 单币种对象

价格单位 USDT；所有 `_usd` 字段是美元名义金额；`_pct` 是百分数（`0.7` 表示 +0.7%），
`dist_pct` 是相对中间价的百分比（`0.12` 表示 +0.12%）。时间戳毫秒。

```json
{
  "symbol": "BTCUSDT", "display": "BTC", "ready": true,
  "price": 76092.2, "mid": 76092.15,
  "change_24h_pct": 0.701, "high_24h": 76350.9, "low_24h": 74810.8,
  "quote_volume_24h": 9112177251.18,
  "mark_price": 76080.1, "index_price": 76129.38,
  "funding_rate": 0.000013, "next_funding_ts": 1794067200000,
  "open_interest": 95656.015, "book_resyncs": 0, "updated_ts": 1794038569071
}
```

### 3.1 `orderbook`

```json
{
  "mid": 76092.15, "spread_bps": 0.0131,
  "imbalance_1pct": -0.0617,
  "bid_depth_usd": 99680000, "ask_depth_usd": 97960000,
  "bands": [
    {"dist_pct": 0.25, "bid_usd": 52556996.0, "ask_usd": 58146225.6, "imbalance": -0.0505}
  ],
  "ladder": {
    "bids": [{"price": 76092.2, "qty": 6.292, "usd": 478772.1, "cum_usd": 478772.1, "dist_pct": -0.0001}],
    "asks": [ ... ]
  },
  "profile": [{"price": 76092.0, "bid_usd": 120000.0, "ask_usd": 0.0}],
  "walls": [
    {"side": "bid", "price": 76065.1, "qty": 16.635, "usd": 1265342.9,
     "dist_pct": -0.0357, "age_s": 47.4, "refills": 4, "absorbed_usd": 0.0, "kind": "iceberg"}
  ],
  "nearest_bid": {"price": 76065.1, "usd": 1265342.9, "dist_pct": -0.0357},
  "nearest_ask": {"price": 76133.9, "usd": 1322750.4, "dist_pct": 0.0547},
  "icebergs": [
    {"side": "bid", "price": 76083.8, "qty": 0.536, "displayed_usd": 40780.9,
     "absorbed_usd": 267586.7, "hidden_usd": 226805.8, "refills": 7,
     "age_s": 43.0, "dist_pct": -0.0111, "ratio": 6.56}
  ]
}
```

- `bands`：按距离档位（0.25%/0.5%/1%/2%/3%）累计的买卖挂单美元。
- `bid_depth_usd` / `ask_depth_usd`：最外层 ±3% 窗口的累计深度；档位是嵌套的，
  不要把这几个 `bands` 相加。
- `ladder`：贴近盘口的 28 档，`cum_usd` 从盘口向外累计；**画订单簿梯图用这个**。
- `profile`：−3%~+3% 的 96 个价格箱，买卖挂单堆积（上下挂单堆积量）。`price` 是箱中心。
- `walls`：显著挂单墙（阈值随币种，最多每边 5 个），`kind` = `iceberg` | `resting` | `spoof`。
- `icebergs`：冰山单预测：`displayed_usd` 当前可见、`absorbed_usd` 已吸收、`hidden_usd` 推测隐藏量。

### 3.2 `liquidations`

```json
{
  "window_h": 24, "total_long_usd": 0, "total_short_usd": 0, "count": 0,
  "recent": [{"ts": 1794038558000, "side": "long", "price": 75800.0, "qty": 3.2, "usd": 242560.0}],
  "map": [{"price": 75800.0, "long_usd": 0, "short_usd": 0}],
  "clusters": [{"price": 75800.0, "long_usd": 0, "short_usd": 0, "label": "多头清算簇"}],
  "estimated": [{"price": 76000.0, "long_usd": 128000000.0, "short_usd": 0.0}],
  "estimated_note": "由 24h 成交量分布 × 杠杆结构反推的估算值，非交易所持仓数据"
}
```

- `total_*` / `recent` / `map` / `clusters`：交易所真实强平（WS `forceOrder`，可能为空）。
- `estimated`：按价格区间的**多空清算量估算**（96 档，覆盖当前价附近 ±4%）；heatmap 用它。
- UI 必须区分“实际强平”与“模型估算”，不要把估算标成实际。

### 3.3 `flow`

```json
{
  "buy_usd": 4245791.1, "sell_usd": 4841054.3, "delta_usd": -595263.2,
  "ratio": -0.0655, "trades": 1001, "window_s": 300,
  "cvd": [[1794037670000, 0.0], [1794038560000, -595263.2]],
  "large": [{"ts": 1794038506466, "side": "sell", "price": 76078.1, "qty": 11.58, "usd": 880984.4}]
}
```

`ratio` ∈ [−1,1] 主动买卖净额占比；`cvd` 是 10 秒桶累计成交差（USD），前端画折线。

### 3.4 `friction` 与 `signals`

`friction`：24 个点，`dist_pct` 距离（%），`up_usd`/`down_usd` 为从中间价累计吃单到该距离所需美元——**阻力曲线**。

```json
[{"dist_pct": 0.125, "up_usd": 36558162.8, "down_usd": 26280628.6}]
```

`signals`：5 个分量，`score` ∈ [−1,1]，正数表示该维度支持上行（阻力更小）。
`prediction.score` 是加权和；`direction` = `up|down|neutral`（阈值 ±0.07）。
`book` 读 ±1% 静态深度；`walls` 读墙/冰山在近 2 分钟被主动成交吸收的方向；
`vacuum` 读 1.5–3% 外侧密度——三者使用不同证据与价格区间，不重复计分。

```json
{"key": "walls", "label": "墙/冰山吸收", "score": 0.0821, "weight": 0.24,
 "contribution": 0.0197, "detail": "近 2 分钟买侧吸收 $1.32M / 卖侧吸收 $1.10M（墙与冰山，含回补加成）"}
```

### 3.5 `prediction`

```json
{
  "direction": "up", "p_up": 0.5923, "score": 0.1556, "confidence": 0.5923,
  "horizon_min": 15,
  "target_price": 2248.82, "invalidation_price": 2245.13,
  "levels": [
    {"price": 2248.82, "kind": "wall", "label": "卖墙", "usd": 1000000.0, "dist_pct": 0.093},
    {"price": 2248.98, "kind": "liq", "label": "空头清算簇", "usd": 5980000000.0, "dist_pct": 0.1}
  ],
  "narrative": "价格上方阻力更薄：...",
  "updated_ts": 1794038569071
}
```

`neutral` 时 `target_price`/`invalidation_price` 可能为 `null`，`levels` 可能为空；
`levels.kind` ∈ `wall | liq`，是价格要去磁吸/失效的位置。

### 3.6 `accuracy` 与 `chart`

```json
"accuracy": {"samples": 12, "hits": 7, "hit_rate": 0.5833, "brier": 0.241,
             "pending": 2, "logged": 14, "horizon_min": 15, "wall_mode": "barrier",
             "recent": [{"ts": 1794038000000, "direction": "up", "p_up": 0.59, "resolved": true, "correct": true, "move_pct": 0.12}]},
"accuracy_alt": {"samples": 3, "hits": 1, "hit_rate": 0.3333, "brier": 0.28,
                 "pending": 1, "logged": 4, "horizon_min": 15, "wall_mode": "magnet", "recent": [...]},
"accuracy_ab": {"...": "same fields, active mode, only samples logged since model.ab_started"},
"accuracy_alt_ab": {"...": "same fields, shadow mode, only samples since model.ab_started"}
```

`accuracy` 是当前展示模式的完整账本；`accuracy_alt` 是影子模式的完整账本。
`accuracy_ab` / `accuracy_alt_ab` 只统计 `model.ab_started` 之后的样本，用于
公平 A/B。两部分字段结构相同；比较脚本读取 `_ab` 版本。

`chart.candles_1m` / `candles_15m`：`[ts, open, high, low, close, volume]`（volume 是币量）。
`chart.estimated_liq`：同 `liquidations.estimated`，画 K 线叠加热力用。

## 4. 事件流 `events`

数组，最新在前或后由后端插入顺序决定（当前为“旧→新”追加，deque 上限 80）。

```json
{"ts": 1794038558308, "kind": "iceberg", "symbol": "ETHUSDT", "display": "ETH",
 "side": "ask", "price": 2246.75, "usd": 106406.1, "note": "卖侧冰山：已吸收 $106K，回补 9 次"}
```

`kind` ∈ `iceberg`（冰山回补）| `spoof`（挂单墙快速撤单）| `whale`（大额主动成交）| `liquidation`（真实强平）。
`side` ∈ `bid|ask|long|short|buy|sell`，按 kind 解释。

## 5. 前端开发约定

- 只允许修改 `web/**`；不要动 `server/`、`run.py`、`docs/`、`tests/`。
- 无 CDN、无 npm、无构建：原生 ES module + Canvas/SVG + CSS。字体用系统栈。
- 视觉方向：专业交易终端，深黑（#05070b 附近）、薄荷绿（上行/最小阻力）、玫红（下行/阻力）、青色（清算热力）、琥珀（预警）。中文为主文案，英文仅作 `MICRO LABEL` 小字。数字用等宽字体（`ui-monospace, "SF Mono", "Cascadia Mono", monospace`）。
- 必须响应式：1600px 桌面双币并排，≤900px 单列，390px 宽可读。
- 图表全部自绘 Canvas（高分屏 `devicePixelRatio`），悬停 tooltip、入场动画、数字滚动可适度实现。
- 断线自动重连，显示数据延迟/连接状态；`?mock=1` 时读 `/mock/snapshot.json` 并模拟推送。
- 深色页面 + `prefers-reduced-motion` 时关闭动画。

## 6. 页面结构（建议，按“最小阻力”这一中心组织）

1. 顶栏：品牌 MIN·RESISTANCE / 最小阻力、LIVE 状态、UTC+8 时钟、数据源、延迟。
2. 双币主卡：价格、24h 涨跌、标记价格/资金费率/持仓量；**方向罗盘**（上方阻力 vs 下方阻力，指针偏向阻力小的一侧）；预测方向、置信度、目标价、失效价、15 分钟窗口。
3. 阻力剖面：订单簿深度直方图（左买右卖）+ 清算热力 + 冰山/墙体标记，共用一个价格轴。
4. 摩擦曲线：向上/向下累计吃单美元 vs 距离，两条曲线交叉处即“最小阻力方向”。
5. 清算地图：价格 × 多空清算量热力条，标出最近簇。
6. 订单簿梯：28 档，累计深度条、墙体高亮、冰山图标、spoof 闪烁。
7. 主动流：CVD 折线、买卖比、大单 tape。
8. 信号拆解：5 个分量占比与贡献，解释最终 score。
9. 预测准确率：命中率、样本数、Brier、最近预测记录。
10. 事件流：冰山/撤单/大单/强平预警。
11. 页脚：方法一句话、数据延迟、免责声明。

任何面板没有数据时都要有优雅空态，不允许空白或报错。
