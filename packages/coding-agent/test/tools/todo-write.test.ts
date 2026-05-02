import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	type ToolSession,
	TodoWriteTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", task: "status" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", { ops: [{ op: "done", task: "diagnostics" }] });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (!completedSummary || completedSummary.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

describe("TodoWriteTool ops operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "third" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "A", items: ["a1", "a2"] },
						{ phase: "B", items: ["b1"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "b1" }] });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Work",
					items: ["Second"],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Cleanup",
					items: ["Remove dead code"],
				},
			],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "Work", items: ["First", "Second"] },
						{ phase: "Later", items: ["Third"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", phase: "Work" }] });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "rm" }] });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "drop", phase: "Work" }] });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});
});

function todoResultEntry(id: string, parentId: string | null, phases: TodoPhase[]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-04-30T00:00:0${id}.000Z`,
		message: {
			role: "toolResult",
			toolName: "todo_write",
			isError: false,
			details: { phases },
		} as unknown as SessionMessageEntry["message"],
	};
}

function userTodoEditEntry(id: string, parentId: string | null, phases: TodoPhase[]): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: `2026-04-30T00:00:0${id}.000Z`,
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { phases },
	};
}

describe("getLatestTodoPhasesFromEntries", () => {
	it("prefers later user todo edits over earlier tool results and clones notes", () => {
		const toolPhases: TodoPhase[] = [
			{
				name: "Tool State",
				tasks: [{ content: "Old task", status: "completed", notes: ["old note"] }],
			},
		];
		const userPhases: TodoPhase[] = [
			{
				name: "User State",
				tasks: [{ content: "Write tests", status: "in_progress", notes: ["first note\nsecond line"] }],
			},
		];
		const entries: SessionEntry[] = [todoResultEntry("1", null, toolPhases), userTodoEditEntry("2", "1", userPhases)];

		const latest = getLatestTodoPhasesFromEntries(entries);

		expect(latest).toEqual(userPhases);
		expect(latest[0]).not.toBe(userPhases[0]);
		expect(latest[0]?.tasks[0]).not.toBe(userPhases[0]?.tasks[0]);
		expect(latest[0]?.tasks[0]?.notes).not.toBe(userPhases[0]?.tasks[0]?.notes);

		latest[0]!.name = "Mutated";
		latest[0]!.tasks[0]!.content = "Mutated task";
		latest[0]!.tasks[0]!.notes?.push("mutated note");

		expect(userPhases).toEqual([
			{
				name: "User State",
				tasks: [{ content: "Write tests", status: "in_progress", notes: ["first note\nsecond line"] }],
			},
		]);
		expect(getLatestTodoPhasesFromEntries(entries)).toEqual(userPhases);
	});
});
