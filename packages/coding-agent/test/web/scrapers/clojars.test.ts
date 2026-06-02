import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleClojars } from "../../../src/web/scrapers/clojars";

function jsonResponse(payload: unknown): Response {
	const response = new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
	Object.defineProperty(response, "url", { value: "https://clojars.org/api/artifacts/com.example/demo" });
	return response;
}

describe("handleClojars", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores non-Clojars URLs and malformed artifact paths", async () => {
		expect(await handleClojars("https://example.com/com.example/demo", 20)).toBeNull();
		expect(await handleClojars("https://clojars.org/", 20)).toBeNull();
		expect(await handleClojars("https://clojars.org/a/b/c", 20)).toBeNull();
		expect(await handleClojars("not a url", 20)).toBeNull();
	});

	it("renders grouped Clojars artifact metadata and dependencies from the API", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				group_name: "com.example",
				jar_name: "demo",
				latest_version: "1.2.3",
				description: "Demo artifact",
				downloads: 12345,
				homepage: "https://example.test/demo",
				licenses: [
					" EPL-2.0 ",
					{ name: "MIT", url: "https://opensource.org/license/mit" },
					{ url: "https://license.example.test/custom" },
					{ name: "Apache-2.0" },
				],
				dependencies: [
					"org.clojure/clojure",
					["org.slf4j/slf4j-api", "2.0.13"],
					["name-only"],
					{ artifact: "cheshire", version: "5.13.0" },
					{ jar_name: "tools.logging" },
				],
			}),
		);

		const result = await handleClojars("https://clojars.org/com.example/demo", 20);

		expect(fetchSpy.mock.calls).toHaveLength(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://clojars.org/api/artifacts/com.example/demo");
		expect(result?.method).toBe("clojars");
		expect(result?.url).toBe("https://clojars.org/com.example/demo");
		expect(result?.finalUrl).toBe("https://clojars.org/com.example/demo");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes).toEqual(["Fetched via Clojars API"]);
		expect(result?.truncated).toBe(false);
		expect(result?.content).toContain("# com.example/demo");
		expect(result?.content).toContain("Demo artifact");
		expect(result?.content).toContain("**Group:** com.example");
		expect(result?.content).toContain("**Artifact:** demo");
		expect(result?.content).toContain("**Latest:** 1.2.3");
		expect(result?.content).toContain("**Downloads:** 12K");
		expect(result?.content).toContain("**Homepage:** https://example.test/demo");
		expect(result?.content).toContain("EPL-2.0");
		expect(result?.content).toContain("MIT (https://opensource.org/license/mit)");
		expect(result?.content).toContain("https://license.example.test/custom");
		expect(result?.content).toContain("Apache-2.0");
		expect(result?.content).toContain("## Dependencies");
		expect(result?.content).toContain("- org.clojure/clojure");
		expect(result?.content).toContain("- org.slf4j/slf4j-api: 2.0.13");
		expect(result?.content).toContain("- name-only");
		expect(result?.content).toContain("- cheshire: 5.13.0");
		expect(result?.content).toContain("- tools.logging");
		expect(Number.isNaN(Date.parse(result?.fetchedAt ?? ""))).toBe(false);
	});

	it("uses the first API item and falls back to URL-derived names for single-segment artifacts", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse([
				{
					version: "0.1.0",
					summary: "Array payload",
					deps: {
						alpha: "1.0.0",
						beta: "",
					},
				},
			]),
		);

		const result = await handleClojars("https://www.clojars.org/demo", 20);

		expect(result?.content).toContain("# demo");
		expect(result?.content).toContain("Array payload");
		expect(result?.content).toContain("**Artifact:** demo");
		expect(result?.content).toContain("**Latest:** 0.1.0");
		expect(result?.content).toContain("- alpha: 1.0.0");
		expect(result?.content).toContain("- beta");
	});

	it("returns null for failed, empty, malformed, or non-object API payloads", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(new Response("not found", { status: 404 }))
			.mockResolvedValueOnce(jsonResponse(null))
			.mockResolvedValueOnce(
				new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
			)
			.mockResolvedValueOnce(jsonResponse("not an object"));

		expect(await handleClojars("https://clojars.org/demo", 20)).toBeNull();
		expect(await handleClojars("https://clojars.org/demo", 20)).toBeNull();
		expect(await handleClojars("https://clojars.org/demo", 20)).toBeNull();
		expect(await handleClojars("https://clojars.org/demo", 20)).toBeNull();
	});
});
