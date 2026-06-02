import { describe, expect, it } from "bun:test";
import { getThemeByName } from "../src/modes/theme/theme";
import { formatStyledArtifactReference } from "../src/tools/output-meta";
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

	it("attaches URL source metadata without forcing details when content is empty", () => {
		const result = toolResult<{ meta?: unknown }>().sourceUrl("https://example.test/result").done();

		expect(result.content).toEqual([]);
		expect(result.details?.meta).toMatchObject({
			source: { type: "url", value: "https://example.test/result" },
		});
	});

	it("attaches all limit metadata variants for downstream notice formatting", () => {
		const result = toolResult<{ meta?: unknown }>()
			.limits({ matchLimit: 4, resultLimit: 5, headLimit: 2, columnMax: 120 })
			.done();

		expect(result.details?.meta).toMatchObject({
			limits: {
				matchLimit: { reached: 4, suggestion: 8 },
				resultLimit: { reached: 5, suggestion: 10 },
				headLimit: { reached: 2, suggestion: 4 },
				columnTruncated: { maxColumn: 120 },
			},
		});
	});

	it("formats full-output artifact references through the warning theme channel", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const reference = formatStyledArtifactReference("artifact-1", theme!);

		expect(Bun.stripANSI(reference)).toBe("Read artifact://artifact-1 for full output");
		expect(reference).not.toBe(Bun.stripANSI(reference));
	});
});
