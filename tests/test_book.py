"""Order-book maintenance: snapshots, diffs, gaps, refills, aggregation."""

import time

import pytest

from server.book import OrderBook, ResyncRequired


def _book() -> tuple[OrderBook, float]:
    book = OrderBook("BTCUSDT", refill_window_s=3.5)
    now = time.time()
    book.apply_snapshot(
        {
            "lastUpdateId": 100,
            "bids": [["100.0", "2.0"], ["99.5", "1.0"]],
            "asks": [["100.5", "1.5"], ["101.0", "3.0"]],
        },
        now,
    )
    return book, now


def test_snapshot_builds_sorted_book_and_mid() -> None:
    book, _ = _book()
    assert book.ready
    assert book.last_update_id == 100
    assert book.best_bid() == (100.0, 2.0)
    assert book.best_ask() == (100.5, 1.5)
    assert book.mid() == pytest.approx(100.25)
    assert book.spread_bps() == pytest.approx((100.5 - 100.0) / 100.25 * 10_000)
    assert book.top("bid", 2)[0] == (100.0, 2.0)


def test_diff_updates_quantities_and_removes_zero_levels() -> None:
    book, now = _book()
    book.apply_diff(
        {"U": 101, "u": 101, "pu": 100, "b": [["100.0", "3.5"]], "a": [["100.5", "0"]]},
        now + 0.1,
    )
    assert book.bids[100.0] == 3.5
    assert 100.5 not in book.asks
    assert book.last_update_id == 101
    assert book.spread_bps() > 0


def test_stale_diff_is_ignored() -> None:
    book, now = _book()
    book.apply_diff({"U": 90, "u": 100, "pu": 89, "b": [["100.0", "9.0"]]}, now)
    assert book.bids[100.0] == 2.0
    assert book.last_update_id == 100


def test_sequence_gap_requires_resync() -> None:
    book, now = _book()
    with pytest.raises(ResyncRequired):
        book.apply_diff({"U": 105, "u": 106, "pu": 103, "b": []}, now)


def test_diff_before_snapshot_requires_resync() -> None:
    book = OrderBook("ETHUSDT")
    with pytest.raises(ResyncRequired):
        book.apply_diff({"U": 1, "u": 1, "pu": 0, "b": []})


def test_refill_detection_counts_quick_replenishment() -> None:
    book, now = _book()
    # Eat most of the ask at 100.5, then refill it within the window.
    book.apply_diff({"U": 101, "u": 101, "pu": 100, "a": [["100.5", "0.4"]]}, now + 0.5)
    assert book.meta[("ask", 100.5)].refills == 0
    book.apply_diff({"U": 102, "u": 102, "pu": 101, "a": [["100.5", "0.7"]]}, now + 1.0)
    meta = book.meta[("ask", 100.5)]
    assert meta.refills == 1
    assert meta.max_qty == 1.5


def test_slow_refill_is_not_counted() -> None:
    book, now = _book()
    book.apply_diff({"U": 101, "u": 101, "pu": 100, "a": [["100.5", "0.4"]]}, now)
    book.apply_diff({"U": 102, "u": 102, "pu": 101, "a": [["100.5", "0.7"]]}, now + 30.0)
    assert book.meta[("ask", 100.5)].refills == 0


def test_notional_and_profile_aggregate_within_span() -> None:
    book, _ = _book()
    assert book.notional_within("bid", 0.01) == pytest.approx(299.5)
    assert book.notional_within("ask", 0.01) == pytest.approx(453.75)
    profile = book.profile(bins=10, span=0.02)
    assert len(profile) == 10
    lows = [row[0] for row in profile]
    assert lows == sorted(lows)
    assert sum(row[1] for row in profile) == pytest.approx(299.5)
    assert sum(row[2] for row in profile) == pytest.approx(453.75)


def test_cleanup_drops_far_away_metadata() -> None:
    book, now = _book()
    book.cleanup_meta(now + 10, book.mid())
    assert ("bid", 100.0) in book.meta
    book.cleanup_meta(now + 10, 200.0)
    assert book.meta == {}
