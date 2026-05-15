import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestCodexResponseWithRetry } from "@oh-my-pi/pi-ai/providers/openai-codex/fetch-retry";

const originalFetch = global.fetch;

afterEach(() => {
	vi.restoreAllMocks();
	global.fetch = originalFetch;
});

describe("Codex fetch retry", () => {
	it("retries retryable status codes before returning success", async () => {
		const fetchMock = vi.fn(async () => {
			if (fetchMock.mock.calls.length === 1) {
				return new Response("temporary overload", {
					status: 429,
					headers: { "retry-after": "0", "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const response = await requestCodexResponseWithRetry(
			"https://chatgpt.com/backend-api/codex/responses",
			{},
			undefined,
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry usage-limit 429 responses and returns the original response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					error: {
						code: "rate_limit_exceeded",
						message: "Your usage limit was exceeded",
					},
				}),
				{
					status: 429,
					headers: {
						"retry-after": "0",
						"content-type": "application/json",
					},
				},
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const response = await requestCodexResponseWithRetry(
			"https://chatgpt.com/backend-api/codex/responses",
			{},
			undefined,
		);

		expect(response.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels retry loops when caller signal aborts", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response("transient", {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const abortController = new AbortController();
		const request = requestCodexResponseWithRetry(
			"https://chatgpt.com/backend-api/codex/responses",
			{},
			abortController.signal,
		);

		await Bun.sleep(5);
		abortController.abort();

		await expect(request).rejects.toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
