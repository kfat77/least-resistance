"""Compare the WALL_MODE=barrier|magnet A/B ledgers from a running server.

Both modes are logged in parallel on the same tape; the active mode drives the
displayed prediction and the shadow mode only writes its own prediction ledger.
A mode can only be called "better" once both sides have enough resolved samples.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

MIN_WINDOWS = 20
MIN_BRIER_GAIN = 0.02


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=8) as response:
        return json.load(response)


def _resolved(stats: dict) -> int:
    """Resolved windows: Brier is computed over these, including neutral forecasts."""
    return max(0, int(stats.get("logged") or 0) - int(stats.get("pending") or 0))


def _fmt(stats: dict) -> str:
    samples = stats.get("samples") or 0
    rate = stats.get("hit_rate")
    brier = stats.get("brier")
    rate_text = f"{rate * 100:.1f}%" if rate is not None else "—"
    brier_text = f"{brier:.4f}" if brier is not None else "—"
    return (
        f"{stats.get('wall_mode', '?'):7s} windows={_resolved(stats):3d} "
        f"dir_samples={samples:3d} hit_rate={rate_text:>6s} "
        f"brier={brier_text:>7s} pending={stats.get('pending', 0):2d}"
    )


def decide(active: dict, shadow: dict, min_windows: int = MIN_WINDOWS) -> str:
    a_windows = _resolved(active)
    s_windows = _resolved(shadow)
    if a_windows < min_windows or s_windows < min_windows:
        return (
            f"样本不足（{active.get('wall_mode')} {a_windows}/{min_windows}, "
            f"{shadow.get('wall_mode')} {s_windows}/{min_windows}），暂不切换默认值"
        )
    a_brier = active.get("brier")
    s_brier = shadow.get("brier")
    if a_brier is None or s_brier is None:
        return "Brier 缺失，暂不切换"
    winner, loser = (active, shadow) if a_brier < s_brier else (shadow, active)
    delta = abs(a_brier - s_brier)
    if delta < MIN_BRIER_GAIN:
        return (
            f"Brier 差距仅 {delta:.4f} < {MIN_BRIER_GAIN:.2f}，"
            "不足以证明优势，保留 barrier"
        )
    w_rate, l_rate = winner.get("hit_rate"), loser.get("hit_rate")
    if w_rate is not None and l_rate is not None and w_rate < l_rate:
        return f"Brier 更低但赢家命中率更差（{w_rate:.1%} vs {l_rate:.1%}），保留 barrier"
    return (
        f"采用 {winner.get('wall_mode')} 为默认值：Brier {winner.get('brier'):.4f} vs "
        f"{loser.get('brier'):.4f}（差 {delta:.4f}），"
        f"命中率 {w_rate if w_rate is None else f'{w_rate:.1%}'} vs "
        f"{l_rate if l_rate is None else f'{l_rate:.1%}'}"
    )


def _pool(rows: list[dict]) -> dict:
    """Pool per-symbol stats: hit rate over all directional samples, Brier weighted by resolved rows."""
    resolved = sum(max(0, int(r.get("logged", 0)) - int(r.get("pending", 0))) for r in rows)
    samples = sum(int(r.get("samples") or 0) for r in rows)
    hits = sum(int(r.get("hits") or 0) for r in rows)
    briers = [
        (float(r["brier"]), max(0, int(r.get("logged", 0)) - int(r.get("pending", 0))))
        for r in rows
        if r.get("brier") is not None
    ]
    brier = (
        sum(value * weight for value, weight in briers) / sum(weight for _, weight in briers)
        if briers and sum(weight for _, weight in briers) > 0
        else None
    )
    return {
        "wall_mode": "+".join(sorted({str(r.get("wall_mode", "?")) for r in rows})),
        "samples": samples,
        "hits": hits,
        "hit_rate": hits / samples if samples else None,
        "brier": brier,
        "pending": sum(int(r.get("pending") or 0) for r in rows),
        "logged": sum(int(r.get("logged") or 0) for r in rows),
        "resolved": resolved,
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765/api/snapshot")
    parser.add_argument("--json", action="store_true", help="emit raw machine-readable rows")
    parser.add_argument(
        "--min-windows",
        type=int,
        default=MIN_WINDOWS,
        help="resolved prediction windows required on each side before deciding",
    )
    args = parser.parse_args()

    snapshot = fetch(args.url)
    model = snapshot.get("model", {})
    print(f"active={model.get('wall_mode')} shadow={model.get('wall_mode_alt')}")
    rows = []
    active_rows = []
    shadow_rows = []
    for symbol in snapshot.get("symbol_order", []):
        data = snapshot["symbols"][symbol]
        active = data.get("accuracy_ab") or data.get("accuracy") or {}
        shadow = data.get("accuracy_alt_ab") or data.get("accuracy_alt") or {}
        active_rows.append(active)
        shadow_rows.append(shadow)
        if args.json:
            rows.append({"symbol": symbol, "active": active, "shadow": shadow})
            continue
        print(f"\n{symbol}")
        print("  " + _fmt(active))
        print("  " + _fmt(shadow))
        print("  " + decide(active, shadow, args.min_windows))
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    pooled_active = _pool(active_rows)
    pooled_shadow = _pool(shadow_rows)
    print("\nPOOLED（两个币合计）")
    print("  " + _fmt(pooled_active))
    print("  " + _fmt(pooled_shadow))
    print("  " + decide(pooled_active, pooled_shadow, args.min_windows * 2))


if __name__ == "__main__":
    main()
