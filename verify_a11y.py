from playwright.sync_api import sync_playwright
import os

def run_cuj(page):
    page.goto("http://localhost:3847")
    page.wait_for_timeout(2000)

    # Click the Models tab
    page.get_by_role("tab", name="models").click()
    page.wait_for_timeout(1000)

    # Take screenshot of the Models tab (which contains our tab list and models table)
    os.makedirs("/home/jules/verification/screenshots", exist_ok=True)
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        os.makedirs("/home/jules/verification/videos", exist_ok=True)
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos",
            viewport={'width': 1280, 'height': 800}
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
