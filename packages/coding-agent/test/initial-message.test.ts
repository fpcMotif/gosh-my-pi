import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Args } from "../src/cli/args";
import { buildInitialMessage } from "../src/cli/initial-message";

function createArgs(messages: string[]): Args {
	return {
		messages,
		fileArgs: [],
		unknownFlags: new Map(),
	};
}

describe("buildInitialMessage", () => {
	it("combines stdin, file text, and the first CLI message", () => {
		const parsed = createArgs(["first", "second"]);
		const images: ImageContent[] = [{ type: "image", data: "abc123", mimeType: "image/png" }];

		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin",
			fileText: "file-",
			fileImages: images,
		});

		expect(result.initialMessage).toBe("stdin\nfile-first");
		expect(result.initialImages).toEqual(images);
		expect(parsed.messages).toEqual(["second"]);
	});

	it("leaves plain CLI messages untouched when there is no initial file or stdin input", () => {
		const parsed = createArgs(["first", "second"]);

		const result = buildInitialMessage({ parsed });

		expect(result.initialMessage).toBeUndefined();
		expect(result.initialImages).toBeUndefined();
		expect(parsed.messages).toEqual(["first", "second"]);
	});

	it("uses stdin directly when no file text or CLI message is merged", () => {
		const parsed = createArgs([]);

		const result = buildInitialMessage({ parsed, stdinContent: "stdin only" });

		expect(result.initialMessage).toBe("stdin only");
		expect(result.initialImages).toBeUndefined();
	});

	it("uses file text directly when stdin is absent", () => {
		const parsed = createArgs([]);

		const result = buildInitialMessage({ parsed, fileText: "file only" });

		expect(result.initialMessage).toBe("file only");
		expect(result.initialImages).toBeUndefined();
	});

	it("creates an empty text part when only image attachments seed the initial turn", () => {
		const parsed = createArgs([]);
		const images: ImageContent[] = [{ type: "image", data: "abc123", mimeType: "image/png" }];

		const result = buildInitialMessage({ parsed, fileImages: images });

		expect(result.initialMessage).toBe("");
		expect(result.initialImages).toEqual(images);
	});
});
