import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext, TodoItem, TodoPhase } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager, type CustomEntry, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo-write";

type TodoEditEntry = CustomEntry<{ phases: TodoPhase[] }>;

function todoEditEntries(entries: SessionEntry[]): TodoEditEntry[] {
	return entries.filter(
		(entry): entry is TodoEditEntry => entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE,
	);
}

function textFromMessage(message: unknown): string {
	if (message === null || message === undefined || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (part === null || part === undefined || typeof part !== "object") return "";
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function createHarness(initialPhases: TodoPhase[] = []) {
	let phases = initialPhases;
	const sessionManager = SessionManager.inMemory("/tmp/todo-test");
	const setText = vi.fn((_text: string) => {});
	const showStatus = vi.fn((_message: string, _options?: { dim?: boolean }) => {});
	const showError = vi.fn((_message: string) => {});
	const showWarning = vi.fn((_message: string) => {});
	const setTodos = vi.fn((_todos: TodoItem[] | TodoPhase[]) => {});
	const getTodoPhases = vi.fn(() => phases);
	const setTodoPhases = vi.fn((next: TodoPhase[]) => {
		phases = next;
	});
	const appendedMessages: AgentMessage[] = [];
	const appendMessage = vi.fn((message: AgentMessage) => {
		appendedMessages.push(message);
	});

	const ctx = {} as InteractiveModeContext;
	Object.assign(ctx, {
		agent: { appendMessage } as unknown as InteractiveModeContext["agent"],
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		session: { getTodoPhases, setTodoPhases } as unknown as InteractiveModeContext["session"],
		sessionManager,
		setTodos,
		showError,
		showStatus,
		showWarning,
	});
	const controller = new TodoCommandController(ctx);
	ctx.handleTodoCommand = args => controller.handleTodoCommand(args);

	const runtime: BuiltinSlashCommandRuntime = {
		ctx,
		handleBackgroundCommand: () => {},
	};

	return {
		appendMessage,
		appendedMessages,
		currentPhases: () => phases,
		runtime,
		sessionManager,
		setText,
		setTodoPhases,
		setTodos,
		showError,
		showStatus,
		showWarning,
	};
}

describe("/todo slash command", () => {
	it("dispatches append through the slash registry and persists a user todo edit", async () => {
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand('/todo append Planning "write tests"', harness.runtime);

		const expectedPhases: TodoPhase[] = [
			{
				name: "Planning",
				tasks: [{ content: "Write tests", status: "pending" }],
			},
		];
		expect(handled).toBe(true);
		expect(harness.currentPhases()).toEqual(expectedPhases);
		expect(harness.setTodoPhases).toHaveBeenCalledWith(expectedPhases);
		expect(harness.setTodos).toHaveBeenCalledWith(expectedPhases);
		expect(harness.setText).toHaveBeenCalledWith("");

		const edits = todoEditEntries(harness.sessionManager.getBranch());
		expect(edits).toHaveLength(1);
		expect(edits[0].data?.phases).toEqual(expectedPhases);

		expect(harness.appendMessage).toHaveBeenCalledTimes(1);
		const reminderText = textFromMessage(harness.appendedMessages[0]);
		expect(reminderText).toContain("The user manually modified the todo list (/todo append → Planning).");
		expect(reminderText).toContain("# Planning");
		expect(reminderText).toContain("- [ ] Write tests");
	});

	it("marks a quoted fuzzy task complete while keeping it visible in the user-facing list", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand('/todo append Planning "write tests"', harness.runtime);

		const handled = await executeBuiltinSlashCommand('/todo done "write"', harness.runtime);

		expect(handled).toBe(true);
		expect(harness.currentPhases()[0]?.tasks[0]).toEqual({ content: "Write tests", status: "completed" });

		harness.showStatus.mockClear();
		await executeBuiltinSlashCommand("/todo", harness.runtime);

		expect(harness.showStatus).toHaveBeenCalledWith("# Planning\n- [x] Write tests");
	});

	it("reports ambiguous fuzzy task matches without mutating todo state", async () => {
		const initialPhases: TodoPhase[] = [
			{
				name: "Planning",
				tasks: [
					{ content: "Write tests", status: "pending" },
					{ content: "Write docs", status: "in_progress" },
				],
			},
		];
		const harness = createHarness(initialPhases);

		const handled = await executeBuiltinSlashCommand("/todo done write", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).toHaveBeenCalledWith('No task or phase matched "write".');
		expect(harness.currentPhases()).toEqual(initialPhases);
		expect(harness.setTodoPhases).not.toHaveBeenCalled();
		expect(harness.setTodos).not.toHaveBeenCalled();
		expect(todoEditEntries(harness.sessionManager.getBranch())).toHaveLength(0);
		expect(harness.appendMessage).not.toHaveBeenCalled();
	});
});
