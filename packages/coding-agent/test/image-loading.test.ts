import { describe, expect, it } from "bun:test";
import { ImageInputTooLargeError } from "../src/utils/image-loading";

describe("ImageInputTooLargeError", () => {
	it("reports byte counts and the configured limit", () => {
		const error = new ImageInputTooLargeError(4096, 1024);

		expect(error.name).toBe("ImageInputTooLargeError");
		expect(error.bytes).toBe(4096);
		expect(error.maxBytes).toBe(1024);
		expect(error.message).toContain("exceeds");
	});
});
