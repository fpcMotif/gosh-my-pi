import { describe, expect, it } from "bun:test";
import { toolResult } from "../src/tools/tool-result";

describe("toolResult", () => {
	it("attaches truncation text, internal source, and diagnostic metadata", () => {
		const result = toolResult<{ op?: string; meta?: unknown }>({ op: "read" })
			.text("preview")
			.truncationFromText("line 1\nline 2\nline 3", { maxLines: 2 })
			.sourceInternal("agent://output/1")
			.diagnostics("1 warning", ["warn"])
			.done();

		expect(result.content).toEqual([{ type: "text", text: "preview" }]);
		expect(result.details?.op).toBe("read");
		expect(result.details?.meta).toMatchObject({
			source: { type: "internal", value: "agent://output/1" },
			diagnostics: { summary: "1 warning", messages: ["warn"] },
		});
	});
});
