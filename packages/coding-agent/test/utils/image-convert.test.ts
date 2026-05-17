import { describe, expect, it } from "bun:test";
import { convertToPng } from "../../src/utils/image-convert";

describe("convertToPng", () => {
	it("keeps PNG images unchanged", async () => {
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP////8J+wP9o9FJCgAAAABJRU5ErkJggg==";

		await expect(convertToPng(png, "image/png")).resolves.toEqual({
			data: png,
			mimeType: "image/png",
		});
	});

	it("returns null when the source image cannot be decoded", async () => {
		await expect(convertToPng("not-image-data", "image/jpeg")).resolves.toBeNull();
	});
});
