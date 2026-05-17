import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls/router";
import type { InternalResource, InternalUrl } from "../src/internal-urls/types";

describe("InternalUrlRouter", () => {
	it("reports registered protocols when resolving an unsupported scheme", async () => {
		const router = new InternalUrlRouter();
		router.register({
			scheme: "agent",
			resolve: async (url: InternalUrl): Promise<InternalResource> => ({
				url: url.href,
				content: "ok",
				contentType: "text/plain",
			}),
		});

		expect(router.canHandle("agent://output/1")).toBe(true);
		expect(router.canHandle("memory://summary")).toBe(false);
		await expect(router.resolve("memory://summary")).rejects.toThrow("Supported: agent://");
	});
});
