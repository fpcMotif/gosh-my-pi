import { describe, expect, it } from "bun:test";
import { readToolPresenter } from "@oh-my-pi/pi-coding-agent/tools/read";

describe("readToolPresenter presentation", () => {
	it("exposes neutral code presentation data for non-url read results", () => {
		const presentation = readToolPresenter.presentResult(
			{
				content: [{ type: "text", text: "1|const value = 1;" }],
				details: {
					kind: "file",
					displayContent: { text: "const value = 1;", startLine: 1 },
				},
			},
			{ expanded: true, isPartial: false },
			{ path: "src/value.ts" },
		);

		expect(presentation?.type).toBe("code");
		if (presentation?.type !== "code") return;
		expect(presentation.code.title).toBe("Read src/value.ts");
		expect(presentation.code.language).toBe("typescript");
		expect(presentation.code.code).toBe("const value = 1;");
		expect(presentation.code.status).toBe("complete");
	});
});
