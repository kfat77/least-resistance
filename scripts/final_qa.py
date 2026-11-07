"""Final acceptance: live + mock screenshots and structural checks."""

from __future__ import annotations

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765/"


def audit(page, url: str, label: str) -> list[str]:
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(6000)
    overflow = page.evaluate(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth"
    )
    charts = page.locator("canvas").count()
    rows = page.locator("#ladder-pair .lrow").count()
    panels = page.locator("section.panel").count()
    print(
        f"{label}: errors={errors[:3]} overflow={overflow} "
        f"charts={charts} ladder_rows={rows} panels={panels}"
    )
    return errors


with sync_playwright() as pw:
    browser = pw.chromium.launch()

    desktop = browser.new_page(viewport={"width": 1600, "height": 1000})
    audit(desktop, BASE, "live-desktop")
    desktop.screenshot(path="screenshots/final-desktop.png")
    desktop.screenshot(path="screenshots/final-desktop-full.png", full_page=True)

    mobile = browser.new_page(viewport={"width": 430, "height": 932})
    audit(mobile, BASE, "live-mobile")
    mobile.screenshot(path="screenshots/final-mobile.png")

    mock = browser.new_page(viewport={"width": 1600, "height": 1000})
    audit(mock, BASE + "?mock=1", "mock-desktop")
    mock.screenshot(path="screenshots/final-mock-desktop.png")

    browser.close()
