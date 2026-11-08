"""Assemble the static GitHub Pages build.

The static site runs the same Python analytics in the browser with Pyodide, so
the build copies the shell (HTML/CSS/JS) from ``web/``, the analytics sources
from ``server/`` and the Pyodide runtime into ``_site/``.

Usage:
    python scripts/build_site.py                    # uses .cache/pyodide
    python scripts/build_site.py --download         # fetches Pyodide from CDN
    python scripts/build_site.py --out _site        # custom output directory
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SERVER = ROOT / "server"
CACHE = ROOT / ".cache" / "pyodide"

PYODIDE_VERSION = "0.27.2"
PYODIDE_CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
PYODIDE_FILES = (
    "pyodide.js",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)
PY_FILES = ("config.py", "book.py", "analytics.py", "predictor.py", "hub.py")
TREE_DIRS = ("css", "js", "assets", "mock")


def fetch(url: str, dest: Path, attempts: int = 4) -> None:
    """Download ``url`` to ``dest`` with a few retries."""
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, dest.open("wb") as out:
                shutil.copyfileobj(response, out)
            return
        except Exception as exc:  # noqa: BLE001 - retry any transient network failure
            if attempt == attempts:
                raise SystemExit(f"download failed: {url}: {exc}") from exc
            print(f"  retry {attempt}/{attempts} for {url}: {exc}")
            time.sleep(1.5 * attempt)


def copy_pyodide(target: Path, download: bool) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for name in PYODIDE_FILES:
        cached = CACHE / name
        if cached.exists() and not download:
            shutil.copy2(cached, target / name)
            continue
        if cached.exists():
            shutil.copy2(cached, target / name)
            continue
        print(f"  fetching pyodide/{name}")
        fetch(PYODIDE_CDN + name, target / name)
    (target / "ATTRIBUTION.md").write_text(
        f"Pyodide {PYODIDE_VERSION} — https://pyodide.org (MPL-2.0)\n"
        f"Runtime files fetched from {PYODIDE_CDN}\n",
        encoding="utf-8",
    )


def build(out: Path, download: bool) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for name in TREE_DIRS:
        shutil.copytree(WEB / name, out / name)

    index = (WEB / "index.html").read_text(encoding="utf-8")
    if "./js/app.js" not in index:
        raise SystemExit("web/index.html no longer references ./js/app.js")
    index = index.replace("./js/app.js", "./js/app-client.js")
    (out / "index.html").write_text(index, encoding="utf-8")

    py_target = out / "py" / "server"
    py_target.mkdir(parents=True)
    (py_target / "__init__.py").write_text("", encoding="utf-8")
    for name in PY_FILES:
        shutil.copy2(SERVER / name, py_target / name)

    copy_pyodide(out / "vendor" / "pyodide", download)
    (out / ".nojekyll").write_text("", encoding="utf-8")

    files = [p for p in out.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    print(f"built {out} — {len(files)} files, {total / 1024 / 1024:.1f} MiB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="_site", help="output directory (default: _site)")
    parser.add_argument("--download", action="store_true", help="always fetch Pyodide from CDN")
    args = parser.parse_args()
    target = Path(args.out)
    if not target.is_absolute():
        target = ROOT / target
    build(target, args.download)


if __name__ == "__main__":
    sys.exit(main())
