import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleFirefoxAddons } from "../../../src/web/scrapers/firefox-addons";

function jsonResponse(payload: unknown, status = 200): Response {
	const response = new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
	Object.defineProperty(response, "url", { value: "https://addons.mozilla.org/api/v5/addons/addon/demo/" });
	return response;
}

describe("handleFirefoxAddons", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ignores non-AMO URLs and paths without an addon slug", async () => {
		expect(await handleFirefoxAddons("https://example.com/firefox/addon/demo/", 20)).toBeNull();
		expect(await handleFirefoxAddons("https://addons.mozilla.org/firefox/", 20)).toBeNull();
		expect(await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/", 20)).toBeNull();
		expect(await handleFirefoxAddons("not a url", 20)).toBeNull();
	});

	it("renders localized metadata, linked license, deduped categories, and permission overflow", async () => {
		const permissions = Array.from({ length: 43 }, (_, index) => `permission-${index + 1}`);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				name: { fr: "Extension Demo", en: "Demo Extension" },
				summary: { fr: "Résumé court", en: "Short summary" },
				description: { fr: "<p>Texte <strong>riche</strong>.</p>" },
				default_locale: "fr",
				authors: [{ name: " Alice " }, { name: null }, { name: "Bob" }],
				average_daily_users: 12345,
				ratings: { average: 4.567, count: 9876 },
				current_version: {
					version: "2.3.4",
					license: {
						name: { fr: "Licence Libre", en: "Free License" },
						url: "https://license.example.test/free",
					},
					file: {
						permissions: [...permissions.slice(0, 30), "tabs"],
						host_permissions: ["https://example.com/*", "tabs"],
						optional_permissions: permissions.slice(30, 40),
						optional_host_permissions: permissions.slice(40),
					},
				},
				categories: {
					firefox: ["privacy", "security"],
					android: ["security", "productivity"],
				},
				homepage: { url: { fr: "https://example.test/fr" } },
				url: "https://addons.mozilla.org/fr/firefox/addon/demo/",
			}),
		);

		const result = await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/demo/", 20);

		expect(result?.method).toBe("firefox-addons");
		expect(result?.finalUrl).toBe("https://addons.mozilla.org/fr/firefox/addon/demo/");
		expect(result?.notes).toEqual(["Fetched via Firefox Add-ons API"]);
		expect(result?.content).toContain("# Extension Demo");
		expect(result?.content).toContain("Résumé court");
		expect(result?.content).toContain("**Authors:** Alice, Bob");
		expect(result?.content).toContain("**Rating:** 4.57");
		expect(result?.content).toContain("reviews");
		expect(result?.content).toContain("**Users:** 12K");
		expect(result?.content).toContain("**Version:** 2.3.4");
		expect(result?.content).toContain("**Categories:** privacy, security, productivity");
		expect(result?.content).toContain("**License:** [Licence Libre](https://license.example.test/free)");
		expect(result?.content).toContain("**Homepage:** https://example.test/fr");
		expect(result?.content).toContain("## Description");
		expect(result?.content).toContain("Texte **riche**.");
		expect(result?.content).toContain("## Permissions (44)");
		expect(result?.content).toContain("- permission-1");
		expect(result?.content).toContain("- tabs");
		expect(result?.content).toContain("*...and 4 more*");
		expect(Number.isNaN(Date.parse(result?.fetchedAt ?? ""))).toBe(false);
	});

	it("falls back through optional metadata sources and renders license variants", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(
				jsonResponse({
					weekly_downloads: 2345,
					current_version: {
						license: { slug: "mpl-2.0" },
					},
					categories: ["tools", ""],
					homepage: { outgoing: { en: "https://outgoing.example.test" } },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					name: "URL License",
					current_version: {
						license: { url: "https://license.example.test/url-only" },
					},
				}),
			);

		const fallback = await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/fallback/", 20);
		const urlOnlyLicense = await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/url-license/", 20);

		expect(fallback?.content).toContain("# fallback");
		expect(fallback?.content).toContain("**Users:** 2.3K");
		expect(fallback?.content).toContain("**Categories:** tools");
		expect(fallback?.content).toContain("**License:** mpl-2.0");
		expect(fallback?.content).toContain("**Homepage:** https://outgoing.example.test");
		expect(urlOnlyLicense?.content).toContain("# URL License");
		expect(urlOnlyLicense?.content).toContain("**License:** https://license.example.test/url-only");
		expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual([
			"https://addons.mozilla.org/api/v5/addons/addon/fallback/",
			"https://addons.mozilla.org/api/v5/addons/addon/url-license/",
		]);
	});

	it("returns null for failed, empty, or malformed API payloads", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
			.mockResolvedValueOnce(jsonResponse(null))
			.mockResolvedValueOnce(jsonResponse("not json"));

		expect(await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/demo/", 20)).toBeNull();
		expect(await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/demo/", 20)).toBeNull();
		expect(await handleFirefoxAddons("https://addons.mozilla.org/firefox/addon/demo/", 20)).toBeNull();
	});
});
