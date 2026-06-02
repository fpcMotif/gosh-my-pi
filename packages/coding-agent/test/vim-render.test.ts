import { describe, expect, it } from "bun:test";
import { buildDetails, computeViewport, renderVimDetails } from "../src/vim/render";
import { comparePositions, maxPosition, minPosition, VimInputError } from "../src/vim/types";
import type { VimToolDetails } from "../src/vim/types";

describe("computeViewport", () => {
	it("moves a preferred viewport upward when the cursor is before its start", () => {
		expect(computeViewport(3, 20, 5, 10)).toEqual({ start: 3, end: 7 });
	});
});

describe("buildDetails", () => {
	it("builds focus and viewport lines without a selection", () => {
		const details = buildDetails({
			file: "src/app.ts",
			mode: "NORMAL",
			cursor: { line: 1, col: 2 },
			totalLines: 2,
			modified: false,
			lines: ["alpha", "beta"],
			viewport: { start: 1, end: 2 },
		});

		expect(details.focus?.line).toBe(1);
		expect(details.viewportLines).toEqual([
			{ line: 1, text: "alpha", isCursor: true, isSelected: false, cursorCol: 1 },
			{ line: 2, text: "beta", isCursor: false, isSelected: false },
		]);
	});
});

describe("renderVimDetails", () => {
	it("omits focus and viewport sections for closed files", () => {
		const details: VimToolDetails = {
			file: "src/app.ts",
			mode: "NORMAL",
			cursor: { line: 1, col: 1 },
			totalLines: 1,
			modified: false,
			viewport: { start: 1, end: 1 },
			closed: true,
			statusMessage: "closed",
		};

		const rendered = renderVimDetails(details);

		expect(rendered).toContain("Status: closed");
		expect(rendered).not.toContain("Focus:");
		expect(rendered).not.toContain("Viewport:");
	});
});

describe("vim position helpers", () => {
	it("compares line before column and returns cloned extrema", () => {
		const early = { line: 1, col: 20 };
		const late = { line: 2, col: 1 };

		expect(comparePositions(early, late)).toBeLessThan(0);
		expect(comparePositions({ line: 1, col: 3 }, { line: 1, col: 1 })).toBe(2);
		expect(minPosition(late, early)).toEqual(early);
		expect(maxPosition(early, late)).toEqual(late);
		expect(minPosition(late, early)).not.toBe(early);
		expect(maxPosition(early, late)).not.toBe(late);
	});

	it("carries token location on VimInputError", () => {
		const error = new VimInputError("bad key", { value: "x", display: "x", sequenceIndex: 3, offset: 4 });

		expect(error.name).toBe("VimInputError");
		expect(error.location).toEqual({ sequenceIndex: 3, offset: 4 });
	});
});
