"""Prediction ledger: interval logging, resolution, persistence, scoring."""

import json

import pytest

from server import config
from server.predictor import PredictionLedger


def _prediction(direction: str = "up", p_up: float = 0.7, score: float = 0.3) -> dict:
    return {
        "direction": direction,
        "p_up": p_up,
        "score": score,
        "confidence": 0.4,
        "narrative": "test",
    }


def _ledger(tmp_path, horizon_min: int = 15) -> PredictionLedger:
    return PredictionLedger("BTCUSDT", tmp_path / "predictions_BTCUSDT.json", horizon_min)


def test_logging_respects_interval(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    assert ledger.maybe_log(1_000.0, 100.0, _prediction()) is True
    assert ledger.maybe_log(1_010.0, 100.0, _prediction()) is False
    assert ledger.maybe_log(
        1_000.0 + config.PREDICTION_INTERVAL_S, 100.0, _prediction()
    ) is True
    stats = ledger.stats()
    assert stats["logged"] == 2
    assert stats["pending"] == 2
    assert stats["samples"] == 0


def test_maybe_log_ignores_missing_price(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    assert ledger.maybe_log(1_000.0, 0.0, _prediction()) is False
    assert ledger.entries == []


def test_resolution_scores_direction_and_brier(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    ledger.maybe_log(1_000.0, 100.0, _prediction("up", p_up=0.7))
    resolved = ledger.resolve_due(1_000.0 + 15 * 60 + 1, 101.0)
    assert len(resolved) == 1
    assert resolved[0]["correct"] is True
    assert resolved[0]["move_pct"] == pytest.approx(1.0)
    stats = ledger.stats()
    assert stats["samples"] == 1
    assert stats["hits"] == 1
    assert stats["hit_rate"] == 1.0
    assert stats["brier"] == pytest.approx((0.7 - 1.0) ** 2)
    assert stats["pending"] == 0


def test_wrong_direction_is_recorded(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    ledger.maybe_log(1_000.0, 100.0, _prediction("up", p_up=0.8))
    ledger.resolve_due(1_000.0 + 15 * 60 + 1, 99.0)
    stats = ledger.stats()
    assert stats["samples"] == 1
    assert stats["hits"] == 0
    assert stats["hit_rate"] == 0.0
    assert stats["brier"] == pytest.approx((0.8 - 0.0) ** 2)


def test_neutral_calls_are_not_directional_samples(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    ledger.maybe_log(1_000.0, 100.0, _prediction("neutral", p_up=0.5, score=0.0))
    resolved = ledger.resolve_due(1_000.0 + 15 * 60 + 1, 101.0)
    assert resolved[0]["correct"] is None
    stats = ledger.stats()
    assert stats["samples"] == 0
    assert stats["pending"] == 0
    assert stats["brier"] is not None


def test_entries_survive_reload(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    ledger.maybe_log(1_000.0, 100.0, _prediction())
    reloaded = _ledger(tmp_path)
    assert reloaded.stats()["logged"] == 1
    persisted = json.loads((tmp_path / "predictions_BTCUSDT.json").read_text())
    assert persisted[0]["price"] == 100.0


def test_resolution_waits_for_horizon(tmp_path) -> None:
    ledger = _ledger(tmp_path)
    ledger.maybe_log(1_000.0, 100.0, _prediction())
    assert ledger.resolve_due(1_000.0 + 60, 101.0) == []
    assert ledger.stats()["pending"] == 1
