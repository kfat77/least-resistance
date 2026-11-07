"""Prediction ledger: log direction calls and score them against the tape.

Every logged call is a falsifiable record.  Once the horizon elapses the entry
is resolved against the first observed price after expiry; directional hit rate
and the Brier score are computed from those resolved rows only.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from . import config


class PredictionLedger:
    def __init__(self, symbol: str, path: Path, horizon_min: int = config.PREDICTION_HORIZON_MIN) -> None:
        self.symbol = symbol
        self.path = path
        self.horizon_min = horizon_min
        self.entries: list[dict] = []
        self.last_log_ts = 0.0
        self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, list):
            return
        now = time.time()
        for item in raw:
            if not isinstance(item, dict) or "ts" not in item:
                continue
            item.setdefault("resolved", False)
            item.setdefault("direction", "neutral")
            item.setdefault("score", 0.0)
            item.setdefault("p_up", 0.5)
            item.setdefault("confidence", 0.5)
            item.setdefault("price", 0.0)
            item.setdefault("eval_at", float(item["ts"]) + self.horizon_min * 60.0)
            item.setdefault("eval_price", None)
            item.setdefault("move_pct", None)
            item.setdefault("correct", None)
            self.entries.append(item)
        self.entries.sort(key=lambda e: e["ts"])
        self.entries = self.entries[-config.PREDICTION_LEDGER_LIMIT :]
        if self.entries:
            self.last_log_ts = float(self.entries[-1]["ts"])

    def save(self) -> None:
        payload = self.entries[-config.PREDICTION_LEDGER_LIMIT :]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass

    # -- lifecycle ---------------------------------------------------------
    def maybe_log(self, now: float, price: float, prediction: dict) -> bool:
        if price <= 0:
            return False
        if now - self.last_log_ts < config.PREDICTION_INTERVAL_S:
            return False
        entry = {
            "ts": now,
            "eval_at": now + self.horizon_min * 60.0,
            "price": price,
            "direction": prediction["direction"],
            "p_up": prediction["p_up"],
            "score": prediction["score"],
            "confidence": prediction["confidence"],
            "resolved": False,
            "eval_price": None,
            "move_pct": None,
            "correct": None,
        }
        self.entries.append(entry)
        self.entries = self.entries[-config.PREDICTION_LEDGER_LIMIT :]
        self.last_log_ts = now
        self.save()
        return True

    def resolve_due(self, now: float, price: float) -> list[dict]:
        if price <= 0:
            return []
        resolved = []
        changed = False
        for entry in self.entries:
            if entry.get("resolved") or entry["eval_at"] > now:
                continue
            entry["resolved"] = True
            entry["eval_price"] = price
            entry["move_pct"] = (price - entry["price"]) / entry["price"] * 100.0
            direction = entry.get("direction")
            if direction == "up":
                entry["correct"] = price > entry["price"]
            elif direction == "down":
                entry["correct"] = price < entry["price"]
            else:
                entry["correct"] = None
            entry["resolved_ts"] = now
            resolved.append(entry)
            changed = True
        if changed:
            self.save()
        return resolved

    # -- reads -------------------------------------------------------------
    def stats(self) -> dict:
        resolved = [e for e in self.entries if e.get("resolved")]
        directional = [e for e in resolved if e.get("correct") is not None]
        hits = sum(1 for e in directional if e["correct"])
        brier_terms = [
            (float(e["p_up"]) - (1.0 if float(e.get("move_pct") or 0.0) > 0 else 0.0)) ** 2
            for e in resolved
        ]
        recent = []
        for entry in resolved[-12:][::-1]:
            recent.append(
                {
                    "ts": int(entry["ts"] * 1000),
                    "direction": entry["direction"],
                    "correct": entry["correct"],
                    "move_pct": round(float(entry["move_pct"]), 3),
                }
            )
        return {
            "samples": len(directional),
            "hits": hits,
            "hit_rate": hits / len(directional) if directional else None,
            "brier": sum(brier_terms) / len(brier_terms) if brier_terms else None,
            "pending": sum(1 for e in self.entries if not e.get("resolved")),
            "logged": len(self.entries),
            "horizon_min": self.horizon_min,
            "recent": recent,
        }
