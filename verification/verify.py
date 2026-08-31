from playwright.sync_api import sync_playwright

def run_cuj(page):
    # Load the dashboard
    page.goto("http://localhost:3847")
    page.wait_for_timeout(2000)

    row_clickable = page.locator("tr.table-row").first
    row_clickable.wait_for(state="visible", timeout=5000)
    row_clickable.click()
    page.wait_for_timeout(1000)

    # Take screenshot of the open modal
    page.screenshot(path="/app/verification/screenshots/verification-modal.png")
    page.wait_for_timeout(500)

    # Click the backdrop to close the modal
    page.mouse.click(10, 10)
    page.wait_for_timeout(1000)

    # Take screenshot of the closed modal
    page.screenshot(path="/app/verification/screenshots/verification-closed.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="/app/verification/videos"
        )
        page = context.new_page()

        # We must intercept API requests so the page renders some data
        page.route("**/api/stats", lambda route: route.fulfill(
            json={
                "overall": {
                    "totalCost": 12.34,
                    "totalTokens": 1000,
                    "totalRequests": 100,
                    "errorCount": 0,
                    "successfulRequests": 100,
                    "failedRequests": 0,
                    "errorRate": 0,
                    "totalInputTokens": 500,
                    "totalOutputTokens": 500,
                    "totalCacheReadTokens": 0,
                    "totalCacheWriteTokens": 0,
                    "cacheRate": 0,
                    "totalPremiumRequests": 0,
                    "avgDuration": 1000,
                    "avgTtft": 200,
                    "avgTokensPerSecond": 50,
                    "firstTimestamp": 1000,
                    "lastTimestamp": 2000
                },
                "byModel": [],
                "byFolder": [],
                "timeSeries": [],
                "costSeries": [],
                "modelSeries": [],
                "modelPerformanceSeries": []
            },
            headers={"Access-Control-Allow-Origin": "*"}
        ))

        # In Playwright, passing dict as json to fulfill doesn't correctly simulate the Content-Type
        # if not set, let's just make it explicit just in case
        page.route("**/api/stats/recent?limit=50", lambda route: route.fulfill(
            json=[
                {
                    "id": 1,
                    "sessionFile": "session_123.json",
                    "entryId": "1",
                    "folder": "test",
                    "api": "test",
                    "stopReason": "test",
                    "timestamp": 1700000000000,
                    "model": "gpt-4-turbo",
                    "provider": "openai",
                    "usage": {
                        "input": 100,
                        "output": 50,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 150,
                        "cost": {
                            "input": 0.001,
                            "output": 0.0015,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "total": 0.0025
                        }
                    },
                    "duration": 2500,
                    "ttft": 500,
                    "errorMessage": None
                }
            ],
            headers={"Access-Control-Allow-Origin": "*"}
        ))

        page.route("**/api/stats/errors?limit=50", lambda route: route.fulfill(json=[], headers={"Access-Control-Allow-Origin": "*"}))

        page.route("**/api/request/*", lambda route: route.fulfill(
            json={
                "id": 1,
                "sessionFile": "session_123.json",
                "entryId": "1",
                "folder": "test",
                "api": "test",
                "stopReason": "test",
                "messages": [],
                "timestamp": 1700000000000,
                "model": "gpt-4-turbo",
                "provider": "openai",
                "usage": {
                    "input": 100,
                    "output": 50,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 150,
                    "cost": {
                        "input": 0.001,
                        "output": 0.0015,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0.0025
                    }
                },
                "duration": 2500,
                "ttft": 500,
                "output": "This is a mocked response.",
                "errorMessage": None
            },
            headers={"Access-Control-Allow-Origin": "*"}
        ))

        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
