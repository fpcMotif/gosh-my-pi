import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleW3c } from "../../../src/web/scrapers/w3c";

function responseWithUrl(payload: unknown, url: string, status = 200): Response {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	const response = new Response(body, {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
	Object.defineProperty(response, "url", { value: url });
	return response;
}

describe("handleW3c", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores non-W3C URLs and paths without a spec shortname", async () => {
		expect(await handleW3c("https://example.com/TR/fetch/", 20)).toBeNull();
		expect(await handleW3c("https://www.w3.org/", 20)).toBeNull();
		expect(await handleW3c("https://www.w3.org/TR/2024/", 20)).toBeNull();
		expect(await handleW3c("https://www.w3.org/TR/2024/css-color/", 20)).toBeNull();
		expect(await handleW3c("https://www.w3.org/not-tr/fetch/", 20)).toBeNull();
		expect(await handleW3c("not a url", 20)).toBeNull();
	});

	it("renders latest spec metadata, normalized status, abstract markdown, and editors", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				responseWithUrl(
					{
						title: "Fetch Standard",
						shortname: "fetch",
						description: "<p>Defines <strong>fetching</strong> resources.</p>",
						shortlink: "https://www.w3.org/TR/fetch/",
						_links: {
							"version-history": { href: "https://www.w3.org/standards/history/fetch/" },
						},
					},
					"https://api.w3.org/specifications/fetch",
				),
			)
			.mockResolvedValueOnce(
				responseWithUrl(
					{
						uri: "https://www.w3.org/TR/2026/REC-fetch-20260517/",
						status: "W3C Recommendation",
						_links: {
							editors: { href: "https://api.w3.org/specifications/fetch/editors" },
						},
					},
					"https://api.w3.org/specifications/fetch/versions/latest",
				),
			)
			.mockResolvedValueOnce(
				responseWithUrl(
					{
						_links: {
							editors: [{ title: "Anne Editor" }, { title: "" }, { title: "Pat Reviewer" }],
						},
					},
					"https://api.w3.org/specifications/fetch/editors",
				),
			);

		const result = await handleW3c("https://www.w3.org/TR/fetch/", 20);

		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
			"https://api.w3.org/specifications/fetch",
			"https://api.w3.org/specifications/fetch/versions/latest",
			"https://api.w3.org/specifications/fetch/editors",
		]);
		expect(result?.method).toBe("w3c-api");
		expect(result?.url).toBe("https://www.w3.org/TR/fetch/");
		expect(result?.finalUrl).toBe("https://www.w3.org/TR/2026/REC-fetch-20260517/");
		expect(result?.notes).toEqual(["Fetched via W3C API"]);
		expect(result?.content).toContain("# Fetch Standard");
		expect(result?.content).toContain("## Abstract");
		expect(result?.content).toContain("Defines **fetching** resources.");
		expect(result?.content).toContain("**Shortname:** fetch");
		expect(result?.content).toContain("**Status:** REC (W3C Recommendation)");
		expect(result?.content).toContain("**Editors:** Anne Editor, Pat Reviewer");
		expect(result?.content).toContain("**Latest Version:** https://www.w3.org/TR/2026/REC-fetch-20260517/");
		expect(result?.content).toContain("**History:** https://www.w3.org/standards/history/fetch/");
		expect(Number.isNaN(Date.parse(result?.fetchedAt ?? ""))).toBe(false);
	});

	it("extracts dated TR shortnames and renders custom status labels without editors", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				responseWithUrl(
					{
						abstract: "<p>Draft abstract.</p>",
						_links: {},
					},
					"https://api.w3.org/specifications/css-color",
				),
			)
			.mockResolvedValueOnce(
				responseWithUrl(
					{
						shortlink: "https://www.w3.org/TR/css-color/",
						status: "Group Note",
						_links: {
							editors: { href: "https://api.w3.org/specifications/css-color/editors" },
						},
					},
					"https://api.w3.org/specifications/css-color/versions/latest",
				),
			)
			.mockResolvedValueOnce(responseWithUrl("not json", "https://api.w3.org/specifications/css-color/editors"));

		const result = await handleW3c("https://www.w3.org/TR/2024/WD-css-color-20240101/", 20);

		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.w3.org/specifications/css-color");
		expect(result?.content).toContain("# css-color");
		expect(result?.content).toContain("Draft abstract.");
		expect(result?.content).toContain("**Shortname:** css-color");
		expect(result?.content).toContain("**Status:** Group Note");
		expect(result?.content).not.toContain("**Editors:**");
		expect(result?.finalUrl).toBe("https://www.w3.org/TR/css-color/");
	});

	it("returns null when required API calls fail or return malformed JSON", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(responseWithUrl({}, "https://api.w3.org/specifications/fetch", 500))
			.mockResolvedValueOnce(responseWithUrl({}, "https://api.w3.org/specifications/fetch/versions/latest"))
			.mockResolvedValueOnce(responseWithUrl("not json", "https://api.w3.org/specifications/fetch"))
			.mockResolvedValueOnce(responseWithUrl({}, "https://api.w3.org/specifications/fetch/versions/latest"));

		expect(await handleW3c("https://www.w3.org/TR/fetch/", 20)).toBeNull();
		expect(await handleW3c("https://www.w3.org/TR/fetch/", 20)).toBeNull();
	});
});
