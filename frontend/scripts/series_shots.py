"""Screenshot the Series tab (wave 6 release-watch UI) at phone + desktop sizes.

Run: uvx --with playwright python scripts/series_shots.py
Requires a Vite dev server with the series mock on http://127.0.0.1:5192.
"""

import os
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5192/"
OUT = os.environ.get("SHOT_DIR", os.environ.get("KIROCREW_SCRATCH", ".")) + "/series-shots"
os.makedirs(OUT, exist_ok=True)


def goto_series(page):
    page.goto(BASE, wait_until="networkidle")
    # Navigate to the Series tab via the nav button.
    page.get_by_role("button", name="Series").first.click()
    page.wait_for_selector(".series-card", timeout=10000)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # Phone 390x844.
        phone = browser.new_context(viewport={"width": 390, "height": 844})
        pg = phone.new_page()
        goto_series(pg)
        pg.screenshot(path=f"{OUT}/series-390-collapsed.png", full_page=True)
        # Expand the first Details toggle.
        toggles = pg.get_by_role("button", name="Details")
        if toggles.count():
            toggles.first.click()
            pg.wait_for_timeout(300)
            pg.screenshot(path=f"{OUT}/series-390-expanded.png", full_page=True)
        phone.close()

        # Desktop 1280x800.
        desk = browser.new_context(viewport={"width": 1280, "height": 800})
        pg2 = desk.new_page()
        goto_series(pg2)
        pg2.screenshot(path=f"{OUT}/series-1280-collapsed.png", full_page=True)
        toggles2 = pg2.get_by_role("button", name="Details")
        if toggles2.count():
            toggles2.first.click()
            pg2.wait_for_timeout(300)
            pg2.screenshot(path=f"{OUT}/series-1280-expanded.png", full_page=True)
        desk.close()

        browser.close()
    print(f"wrote shots to {OUT}")


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
