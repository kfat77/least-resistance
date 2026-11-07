"""Refresh web/mock/snapshot.json from a running backend.

The mock snapshot is what ?mock=1 replays when the backend is unavailable, so it
must stay structurally identical to /api/snapshot.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765/api/snapshot")
    parser.add_argument("--out", default=str(ROOT / "web" / "mock" / "snapshot.json"))
    args = parser.parse_args()
    snapshot = fetch(args.url)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    events = len(snapshot.get("events") or [])
    symbols = " ".join(
        f"{symbol}:{data['flow']['trades']}t"
        for symbol, data in snapshot.get("symbols", {}).items()
    )
    print(f"wrote {out} ({out.stat().st_size} bytes, {events} events, {symbols})")


if __name__ == "__main__":
    main()
