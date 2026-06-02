import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolAbortError } from "../../../src/tools/tool-errors";
import {
	MAX_OUTPUT_CHARS,
	buildResult,
	decodeHtmlEntities,
	finalizeOutput,
	formatIsoDate,
	formatMediaDuration,
	getLocalizedText,
	htmlToBasicMarkdown,
	loadPage,
	looksLikeHtml,
} from "../../../src/web/scrapers/types";

function responseWithUrl(content: string | null, init: ResponseInit, url: string): Response {
	const body =
		content === null
			? null
			: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(content));
						controller.close();
					},
				});
	const response = new Response(body, init);
	Object.defineProperty(response, "url", { value: url });
	return response;
}

describe("web scraper shared helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("normalizes repeated blank lines and reports truncation when output exceeds the cap", () => {
		const short = finalizeOutput("  alpha\n\n\n\nbeta  ");
		expect(short).toEqual({ content: "alpha\n\nbeta", truncated: false });

		const long = finalizeOutput("x".repeat(MAX_OUTPUT_CHARS + 10));
		expect(long.content).toHaveLength(MAX_OUTPUT_CHARS);
		expect(long.truncated).toBe(true);
	});

	it("builds render results with defaults while preserving fetch metadata", () => {
		const result = buildResult("  # Package\n\nBody  ", {
			url: "https://example.test/pkg",
			finalUrl: "https://cdn.example.test/pkg",
			method: "registry",
			fetchedAt: "2026-05-17T00:00:00.000Z",
			notes: ["from API"],
		});

		expect(result).toEqual({
			url: "https://example.test/pkg",
			finalUrl: "https://cdn.example.test/pkg",
			contentType: "text/markdown",
			method: "registry",
			content: "# Package\n\nBody",
			fetchedAt: "2026-05-17T00:00:00.000Z",
			truncated: false,
			notes: ["from API"],
		});
	});

	it("converts HTML to markdown after stripping script and style tags", () => {
		const markdown = htmlToBasicMarkdown(`
			<html>
				<head><style>.hidden { display: none; }</style><script>alert("x")</script></head>
				<body>
					<h2>API. Docs</h2>
					<p>Hello <strong>world</strong> and <del>old</del>.</p>
					<ol start="3"><li>third</li><li>fourth</li></ol>
				</body>
			</html>
		`);

		expect(markdown).toContain("## API. Docs");
		expect(markdown).toContain("Hello **world** and ~~old~~.");
		expect(markdown).toContain("3. third");
		expect(markdown).toContain("4. fourth");
		expect(markdown).not.toContain("alert");
		expect(markdown).not.toContain("display: none");
	});

	it("formats dates, entities, media durations, localized text, and HTML detection", () => {
		expect(formatIsoDate("2026-05-17T10:11:12Z")).toBe("2026-05-17");
		expect(formatIsoDate(0)).toBe("1970-01-01");
		expect(formatIsoDate("not a date")).toBe("");

		expect(decodeHtmlEntities("&lt;a href=&quot;/x&#x2F;y&quot;&gt;Tom&amp;Jerry&#39;s&nbsp;link&lt;/a&gt;")).toBe(
			'<a href="/x/y">Tom&Jerry\'s link</a>',
		);

		expect(formatMediaDuration(59)).toBe("0:59");
		expect(formatMediaDuration(65)).toBe("1:05");
		expect(formatMediaDuration(3661)).toBe("1:01:01");

		expect(getLocalizedText("plain")).toBe("plain");
		expect(getLocalizedText({ fr: "Bonjour", en: "Hello" })).toBe("Hello");
		expect(getLocalizedText({ fr: "Bonjour", de: "Hallo" }, "de")).toBe("Hallo");
		expect(getLocalizedText({ fr: "Bonjour" })).toBe("Bonjour");
		expect(getLocalizedText(null)).toBeUndefined();

		expect(looksLikeHtml("  <!doctype html>")).toBe(true);
		expect(looksLikeHtml("<body>content</body>")).toBe(true);
		expect(looksLikeHtml("# markdown")).toBe(false);
	});

	it("throws the scraper abort error when called with an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(loadPage("https://example.test", { signal: controller.signal })).rejects.toThrow(ToolAbortError);
	});

	it("retries bot-blocked responses with the next user agent before returning successful content", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				responseWithUrl(
					"<html>Cloudflare challenge</html>",
					{ status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
					"https://example.test/blocked",
				),
			)
			.mockResolvedValueOnce(
				responseWithUrl(
					"success body",
					{ status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
					"https://example.test/final",
				),
			);

		const result = await loadPage("https://example.test", {
			timeout: 20,
			headers: { Accept: "application/json" },
			method: "POST",
			body: "payload",
		});

		expect(result).toEqual({
			content: "success body",
			contentType: "text/plain",
			finalUrl: "https://example.test/final",
			ok: true,
			status: 200,
		});
		expect(fetchSpy.mock.calls).toHaveLength(2);
		expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "payload" });
	});

	it("returns partial content once the configured byte limit is exceeded", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			responseWithUrl(
				"oversized",
				{ status: 200, headers: { "content-type": "text/plain" } },
				"https://example.test/large",
			),
		);

		const result = await loadPage("https://example.test/large", { maxBytes: 4 });

		expect(result).toEqual({
			content: "oversized",
			contentType: "text/plain",
			finalUrl: "https://example.test/large",
			ok: true,
			status: 200,
		});
	});

	it("maps bodyless and thrown fetch responses to failed load results", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockResolvedValueOnce(
			responseWithUrl(
				null,
				{ status: 204, headers: { "content-type": "text/plain" } },
				"https://example.test/empty",
			),
		);

		expect(await loadPage("https://example.test/empty")).toEqual({
			content: "",
			contentType: "text/plain",
			finalUrl: "https://example.test/empty",
			ok: false,
			status: 204,
		});

		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

		expect(await loadPage("https://example.test/down")).toEqual({
			content: "",
			contentType: "",
			finalUrl: "https://example.test/down",
			ok: false,
		});
	});
});
