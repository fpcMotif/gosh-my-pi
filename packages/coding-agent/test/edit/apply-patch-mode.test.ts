import { describe, expect, it } from "bun:test";
import { ApplyPatchError } from "../../src/edit/diff";
import { formatApplyCodexPatchSummary } from "../../src/edit/apply-patch";
import { expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "../../src/edit/modes/apply-patch";

describe("expandApplyPatchToEntries", () => {
	it("maps an empty apply-patch envelope to the edit-mode no-op error", () => {
		expect(() =>
			expandApplyPatchToEntries({
				input: ["*** Begin Patch", "*** End Patch"].join("\n"),
			}),
		).toThrow(ApplyPatchError);
		expect(() =>
			expandApplyPatchToEntries({
				input: ["*** Begin Patch", "*** End Patch"].join("\n"),
			}),
		).toThrow("No files were modified.");
	});

	it("lowers complete and streaming envelopes to single-file edit entries", () => {
		expect(
			expandApplyPatchToEntries({
				input: ["*** Begin Patch", "*** Add File: notes.txt", "+hello", "*** End Patch"].join("\n"),
			}),
		).toEqual([{ path: "notes.txt", op: "create", diff: "hello\n" }]);

		expect(
			expandApplyPatchToPreviewEntries({
				input: ["*** Begin Patch", "*** Update File: notes.txt"].join("\n"),
			}),
		).toEqual([{ path: "notes.txt", op: "update", diff: "" }]);
	});
});

describe("formatApplyCodexPatchSummary", () => {
	it("reports added, modified, and deleted files in summary order", () => {
		expect(
			formatApplyCodexPatchSummary({
				added: ["new.txt"],
				modified: ["changed.txt"],
				deleted: ["old.txt"],
			}),
		).toBe(["Success. Updated the following files:", "A new.txt", "M changed.txt", "D old.txt"].join("\n"));
	});
});
