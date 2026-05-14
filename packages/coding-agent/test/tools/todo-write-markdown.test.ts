import { describe, expect, it } from "bun:test";
import { markdownToPhases, phasesToMarkdown } from "../../src/tools/todo-write-markdown";
import type { TodoPhase } from "../../src/tools/todo-write";

describe("todo-write markdown helpers", () => {
	it("renders empty and phased todo lists with status markers and note blocks", () => {
		expect(phasesToMarkdown([])).toBe("# Todos\n");

		const phases: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "Plan work", status: "pending" },
					{
						content: "Implement work",
						status: "in_progress",
						notes: ["first note\ncontinued", "second note"],
					},
				],
			},
			{
				name: "Verify",
				tasks: [
					{ content: "Run tests", status: "completed" },
					{ content: "Drop stale path", status: "abandoned" },
				],
			},
		];

		expect(phasesToMarkdown(phases)).toBe(
			[
				"# Build",
				"- [ ] Plan work",
				"- [/] Implement work",
				"  > first note",
				"  > continued",
				"  >",
				"  > second note",
				"",
				"# Verify",
				"- [x] Run tests",
				"- [-] Drop stale path",
				"",
			].join("\n"),
		);
	});

	it("parses headings, compatible status markers, grouped notes, and default phases", () => {
		const parsed = markdownToPhases(
			[
				"- [ ] implicit pending",
				"# Explicit",
				"- [X] done item",
				"  > note line 1",
				"  > note line 2",
				"  >",
				"  > second note",
				"- [>] active item",
				"- [~] abandoned item",
			].join("\n"),
		);

		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual([
			{
				name: "Todos",
				tasks: [{ content: "implicit pending", status: "pending" }],
			},
			{
				name: "Explicit",
				tasks: [
					{
						content: "done item",
						status: "completed",
						notes: ["note line 1\nnote line 2", "second note"],
					},
					{ content: "active item", status: "in_progress" },
					{ content: "abandoned item", status: "abandoned" },
				],
			},
		]);
	});

	it("reports unknown markers and unrecognized syntax without dropping later valid tasks", () => {
		const parsed = markdownToPhases(
			[
				"# Broken",
				"- [?] mystery",
				"plain text",
				"- [x] valid",
			].join("\n"),
		);

		expect(parsed.errors).toEqual([
			'Line 2: unknown status marker "[?]" (use [ ], [x], [/], [-])',
			'Line 3: unrecognized syntax "plain text"',
		]);
		expect(parsed.phases).toEqual([
			{
				name: "Broken",
				tasks: [{ content: "valid", status: "completed" }],
			},
		]);
	});

	it("normalizes multiple in-progress parsed tasks so only the first remains active", () => {
		const parsed = markdownToPhases(
			[
				"# Work",
				"- [/] first active",
				"- [/] second active",
				"- [ ] pending",
			].join("\n"),
		);

		expect(parsed.errors).toEqual([]);
		expect(parsed.phases[0].tasks).toEqual([
			{ content: "first active", status: "in_progress" },
			{ content: "second active", status: "pending" },
			{ content: "pending", status: "pending" },
		]);
	});
});
