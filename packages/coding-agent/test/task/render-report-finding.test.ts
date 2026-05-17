import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "../../src/task/render";
import type { AgentProgress, SingleResult, TaskToolDetails } from "../../src/task/types";

async function loadTheme() {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme should be available");
	return theme;
}

function renderText(component: { render(width: number): string[] }, width = 160): string {
	return sanitizeText(Bun.stripANSI(component.render(width).join("\n")));
}

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Implement branch",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1234,
		tokens: 0,
		...overrides,
	};
}

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "0-Worker",
		agent: "worker",
		agentSource: "bundled",
		status: "running",
		task: "Implement branch",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		...overrides,
	};
}

function finding(priority: "P0" | "P1" | "P2" | "P3", title: string, line = 12) {
	return {
		title,
		body: `${title} body`,
		priority,
		confidence: 0.9,
		file_path: `src/${title.toLowerCase().replaceAll(" ", "-")}.ts`,
		line_start: line,
		line_end: line + 1,
	};
}

describe("taskToolRenderer report_finding safety", () => {
	it("renders progress without crashing when report_finding payload is malformed", async () => {
		const uiTheme = await loadTheme();

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 42,
			progress: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					status: "running",
					task: "Review patch",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					tokens: 0,
					durationMs: 42,
					extractedToolData: {
						report_finding: [{}],
					},
				},
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		expect(() => rendered.render(120)).not.toThrow();
	});

	it("renders abort reason inline for aborted subagent results", async () => {
		const uiTheme = await loadTheme();

		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				{
					index: 0,
					id: "1-Reviewer",
					agent: "reviewer",
					agentSource: "bundled",
					task: "Review patch",
					exitCode: 1,
					output: "",
					stderr: "",
					truncated: false,
					durationMs: 42,
					tokens: 0,
					aborted: true,
					abortReason: "blocked by permissions",
				},
			],
			totalDurationMs: 42,
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details,
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("blocked by permissions");
	});

	it("renders call previews with shared context, task count, and isolation state", async () => {
		const uiTheme = await loadTheme();

		const rendered = taskToolRenderer.renderCall(
			{
				agent: "worker",
				context: "Repo: packages/coding-agent\nGoal:\tcover renderer",
				tasks: [
					{ id: "One", description: "first", assignment: "Do first" },
					{ id: "Two", description: "second", assignment: "Do second" },
				],
				isolated: true,
			},
			{},
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("Task");
		expect(text).toContain("Context");
		expect(text).toContain("Repo: packages/coding-agent");
		expect(text).toContain("Goal:   cover renderer");
		expect(text).toContain("Tasks: 2 agents");
		expect(text).toContain("Isolated: true");
	});

	it("renders streaming progress states with tools, task details, output, findings, and review verdicts", async () => {
		const uiTheme = await loadTheme();
		const oldToolStart = Date.now() - 8000;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 9000,
			results: [],
			progress: [
				progress({
					index: 0,
					id: "0-Planner",
					status: "pending",
					task: "Plan renderer test",
					description: "Plan render",
				}),
				progress({
					index: 1,
					id: "1-Worker",
					status: "running",
					task: "Run renderer test",
					assignment: "Line one\nLine two",
					currentTool: "bash",
					currentToolArgs: "bun test\tfile",
					currentToolStartMs: oldToolStart,
					recentOutput: ["alpha\tbeta", JSON.stringify({ ok: true })],
					toolCount: 2,
					tokens: 1200,
					extractedToolData: {
						report_finding: [
							finding("P2", "[P2] visible progress finding"),
							finding("P1", "[P1] higher progress finding"),
						],
					},
				}),
				progress({
					index: 2,
					id: "2-Reviewer",
					status: "completed",
					task: "Review renderer test",
					description: "Review render",
					toolCount: 4,
					tokens: 99,
					extractedToolData: {
						yield: [
							{
								data: {
									overall_correctness: "incorrect",
									explanation: "Patch misses a branch.\nSecond line.",
									confidence: 0.72,
								},
							},
						],
						report_finding: [finding("P0", "[P0] missing branch")],
					},
				}),
				progress({
					index: 3,
					id: "3-Blocked",
					status: "aborted",
					task: "Blocked task",
					description: "Blocked render",
				}),
				progress({
					index: 4,
					id: "4-Failed",
					status: "failed",
					task: "Failed task",
					description: "Failed render",
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: true, spinnerFrame: 1 },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("Plan render");
		expect(text).toContain("Line one");
		expect(text).toContain("bash: bun test   file");
		expect(text).toContain("2 tools");
		expect(text).toContain("1.2K tokens");
		expect(text).toContain("Output");
		expect(text).toContain("alpha   beta");
		expect(text).toContain("visible progress finding");
		expect(text).toContain("Patch is incorrect");
		expect(text).toContain("72% confidence");
		expect(text).toContain("missing branch");
		expect(text).toContain("Blocked render");
		expect(text).toContain("Failed render");
	});

	it("renders final result statuses, warnings, JSON output, branch and patch metadata, and aggregate totals", async () => {
		const uiTheme = await loadTheme();
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 5321,
			results: [
				result({
					index: 0,
					id: "0-Review.1-Worker",
					description: "Warned worker",
					assignment: "Target\nChange\tone",
					output:
						'SYSTEM WARNING: Subagent exited without calling yield tool before stop\n{"status":"kept","count":2}',
					durationMs: 1111,
					tokens: 333,
					patchPath: "/tmp/worker.patch",
				}),
				result({
					index: 1,
					id: "1-Branch",
					description: "Branch worker",
					branchName: "task/branch-worker",
					durationMs: 2222,
				}),
				result({
					index: 2,
					id: "2-Merge",
					description: "Merge worker",
					error: "merge conflict in src/task/render.ts",
					durationMs: 3333,
				}),
				result({
					index: 3,
					id: "3-Fail",
					description: "Failed worker",
					exitCode: 2,
					output: JSON.stringify({ error: "bad payload", path: "src/task/render.ts" }),
					error: "process exited 2",
					truncated: true,
					durationMs: 4444,
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Task summary\nApplied patches: /tmp/worker.patch" }],
				details,
			},
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("0.1 Review>Worker: Warned worker");
		expect(text).toContain("Task");
		expect(text).toContain("Change   one");
		expect(text).toContain("SYSTEM WARNING: Subagent exited without calling yield tool");
		expect(text).toContain('status: "kept"');
		expect(text).toContain("Patch: /tmp/worker.patch");
		expect(text).toContain("Branch: task/branch-worker");
		expect(text).toContain("merge failed");
		expect(text).toContain("merge conflict in src/task/render.ts");
		expect(text).toContain("[truncated]");
		expect(text).toContain("process exited 2");
		expect(text).toContain("Total:");
		expect(text).toContain("2 succeeded");
		expect(text).toContain("1 merge failed");
		expect(text).toContain("1 failed");
		expect(text).toContain("Applied patches: /tmp/worker.patch");
	});

	it("renders final review verdicts and incomplete review findings", async () => {
		const uiTheme = await loadTheme();
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 1000,
			results: [
				result({
					index: 0,
					id: "0-Reviewer",
					description: "Reviewer",
					extractedToolData: {
						yield: [
							{
								data: {
									overall_correctness: "correct",
									explanation: "All checked. Details follow.",
									confidence: 0.91,
								},
							},
						],
						report_finding: [finding("P3", "[P3] cosmetic issue")],
					},
				}),
				result({
					index: 1,
					id: "1-Incomplete",
					description: "Incomplete reviewer",
					extractedToolData: {
						report_finding: [
							finding("P2", "[P2] missing yield issue"),
							finding("P1", "[P1] sorted earlier issue"),
						],
					},
				}),
				result({
					index: 2,
					id: "2-BadYield",
					description: "Bad yield reviewer",
					extractedToolData: {
						yield: [{ data: { note: "not a review verdict" } }],
						report_finding: [finding("P0", "[P0] malformed verdict issue")],
					},
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("Patch is correct");
		expect(text).toContain("91% confidence");
		expect(text).toContain("All checked.");
		expect(text).toContain("cosmetic issue");
		expect(text).toContain("Review incomplete (yield not called)");
		expect(text).toContain("sorted earlier issue");
		expect(text).toContain("Review verdict missing expected fields");
		expect(text).toContain("malformed verdict issue");
	});

	it("renders fallback text when structured details are missing or empty", async () => {
		const uiTheme = await loadTheme();
		const withoutDetails = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "plain fallback text" }] },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const emptyDetails = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [] },
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		expect(renderText(withoutDetails)).toContain("plain fallback text");
		expect(renderText(emptyDetails)).toContain("No results");
	});

	it("renders expanded JSON output trees with arrays, empty containers, nesting, and truncation", async () => {
		const uiTheme = await loadTheme();
		const nestedOutput = [
			{
				name: "root",
				emptyArray: [],
				emptyObject: {},
				values: [null, true, false, 3, "text"],
				nested: {
					level1: {
						level2: {
							level3: {
								level4: {
									level5: {
										level6: "deep",
									},
								},
							},
						},
					},
				},
			},
			...Array.from({ length: 30 }, (_, index) => ({ index })),
		];
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 2000,
			results: [
				result({
					output: JSON.stringify(nestedOutput),
					durationMs: 2000,
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered, 180);
		expect(text).toContain("Output");
		expect(text).toContain("[0]");
		expect(text).toContain("emptyArray");
		expect(text).toContain("[]");
		expect(text).toContain("emptyObject");
		expect(text).toContain("{}");
		expect(text).toContain("values");
		expect(text).toContain("null");
		expect(text).toContain("true");
		expect(text).toContain("level4");
		expect(text).toContain("index: 2");
	});

	it("renders collapsed JSON and raw output previews without flooding the TUI", async () => {
		const uiTheme = await loadTheme();
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 2000,
			results: [
				result({
					index: 0,
					id: "0-CollapsedObject",
					output: JSON.stringify({
						empty: "",
						multi: "first\nsecond",
						items: [1, 2],
						object: { nested: true },
						long: "x".repeat(120),
					}),
				}),
				result({
					index: 1,
					id: "1-CollapsedArray",
					output: JSON.stringify([{ first: true }, { second: true }]),
				}),
				result({
					index: 2,
					id: "2-Raw",
					output: ["line one", "line two", "line three", "line four", "line five"].join("\n"),
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered, 180);
		expect(text).toContain('Output: empty=""');
		expect(text).toContain('multi="first');
		expect(text).toContain("(2 lines)");
		expect(text).toContain("items=[2 items]");
		expect(text).toContain("Output: [2 items] {1 keys}");
		expect(text).toContain("line one");
		expect(text).toContain("2 more lines");
	});

	it("renders idle progress recent tools and collapsed finding overflow", async () => {
		const uiTheme = await loadTheme();
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 3000,
			results: [],
			progress: [
				progress({
					status: "running",
					task: "Wait between tools",
					recentTools: [
						{ tool: "edit", args: "patched\tfile", endMs: Date.now() - 200 },
						{ tool: "read", args: "read file", endMs: Date.now() - 400 },
					],
					extractedToolData: {
						report_finding: [
							finding("P3", "[P3] fourth finding", 40),
							finding("P2", "[P2] third finding", 30),
							finding("P1", "[P1] second finding", 20),
							finding("P0", "[P0] first finding", 10),
						],
					},
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("edit: patched   file");
		expect(text.indexOf("first finding")).toBeLessThan(text.indexOf("second finding"));
		expect(text).toContain("1 more finding");
	});

	it("renders nested task subprocess results after the parent task output", async () => {
		const uiTheme = await loadTheme();
		const nested: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 500,
			results: [
				result({
					index: 0,
					id: "0-Nested",
					description: "Nested worker",
					output: "nested output",
					durationMs: 500,
				}),
			],
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 1000,
			results: [
				result({
					index: 0,
					id: "0-Parent",
					description: "Parent worker",
					output: "parent output",
					extractedToolData: {
						task: [nested],
					},
				}),
			],
		};

		const rendered = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		const text = renderText(rendered);
		expect(text).toContain("Parent worker");
		expect(text).toContain("parent output");
		expect(text).toContain("Nested worker");
		expect(text).toContain("nested output");
	});
});
