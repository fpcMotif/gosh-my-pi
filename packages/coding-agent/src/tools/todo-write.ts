import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";

const SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function toSuperscript(n: number): string {
	return n
		.toString()
		.split("")
		.map(d => SUP_DIGITS[d] ?? d)
		.join("");
}
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-manager";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/**
	 * Append-only list of freeform notes attached by `op: "note"`.
	 * Each element is one note and may itself be multi-line.
	 * Rendered as text only when the task is in_progress; otherwise shown as a
	 * dim marker indicating the task has notes.
	 */
	notes?: string[];
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoWriteToolDetails {
	phases: TodoPhase[];
	storage: "session" | "memory";
}

export type TodoWriteRenderArgs = Static<typeof todoWriteSchema>;

// =============================================================================
// Schema
// =============================================================================

const TodoOp = StringEnum(["init", "start", "done", "rm", "drop", "append", "note"] as const, {
	description: "operation to apply",
});

const InitListEntry = Type.Object({
	phase: Type.String({ description: "phase name (short noun phrase)", examples: ["Foundation", "Auth"] }),
	items: Type.Array(Type.String({ description: "task content (5-10 words)" }), {
		minItems: 1,
		description: "tasks for this phase, in execution order; all start as pending",
	}),
});

const TodoOpEntry = Type.Object({
	op: TodoOp,
	list: Type.Optional(Type.Array(InitListEntry, { description: "phased task list for op=init" })),
	task: Type.Optional(
		Type.String({ description: "task content for start/done/rm/drop/note", examples: ["Run tests"] }),
	),
	phase: Type.Optional(Type.String({ description: "phase name for done/rm/drop/append", examples: ["Auth"] })),
	items: Type.Optional(
		Type.Array(Type.String({ description: "task content (5-10 words)" }), {
			minItems: 1,
			description: "tasks to append to `phase` for op=append",
		}),
	),
	text: Type.Optional(Type.String({ description: "note text for op=note (appended with newline)" })),
});

const todoWriteSchema = Type.Object(
	{
		ops: Type.Array(TodoOpEntry, {
			minItems: 1,
			description: "ordered todo operations",
		}),
	},
	{ description: "Apply ordered todo operations" },
);

type TodoWriteParams = Static<typeof todoWriteSchema>;
type TodoOpEntryValue = TodoWriteParams["ops"][number];

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	const out: TodoItem = { content: task.content, status: task.status };
	if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
	return out;
}

export function cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			if (data && Array.isArray(data.phases)) {
				return cloneTodoPhases(data.phases as TodoPhase[]);
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError === true) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return cloneTodoPhases(details.phases as TodoPhase[]);
	}

	return [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (content === null || content === undefined || content === "") {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
		errors.push(`Task "${content}" not found${hint}`);
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (name === null || name === undefined || name === "") {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task !== null && entry.task !== undefined && entry.task !== "") {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase !== null && entry.phase !== undefined && entry.phase !== "") {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.list) {
		errors.push("Missing list for init operation");
		return [];
	}
	return entry.list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.phase === null || entry.phase === undefined || entry.phase === "") {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		if (findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			continue;
		}
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task !== null && entry.task !== undefined && entry.task !== "") {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase !== null && entry.phase !== undefined && entry.phase !== "") {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function startTask(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const hit = resolveTaskOrError(phases, entry.task, errors);
	if (!hit) return phases;
	for (const phase of phases) {
		for (const candidate of phase.tasks) {
			if (candidate.status === "in_progress" && candidate !== hit.task) {
				candidate.status = "pending";
			}
		}
	}
	hit.task.status = "in_progress";
	return phases;
}

function setTaskStatusForOp(
	phases: TodoPhase[],
	entry: TodoOpEntryValue,
	errors: string[],
	status: TodoItem["status"],
): TodoPhase[] {
	for (const task of getTaskTargets(phases, entry, errors)) {
		task.status = status;
	}
	return phases;
}

function appendNote(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const hit = resolveTaskOrError(phases, entry.task, errors);
	if (!hit) return phases;
	const text = (entry.text ?? "").replace(/\s+$/u, "");
	if (!text) {
		errors.push("Missing text for note operation");
		return phases;
	}
	hit.task.notes = hit.task.notes ? [...hit.task.notes, text] : [text];
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start":
			return startTask(phases, entry, errors);
		case "done":
			return setTaskStatusForOp(phases, entry, errors, "completed");
		case "drop":
			return setTaskStatusForOp(phases, entry, errors, "abandoned");
		case "rm":
			return removeTasks(phases, entry, errors);
		case "note":
			return appendNote(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
	}
}

function applyParams(phases: TodoPhase[], params: TodoWriteParams): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = phases;
	for (const entry of params.ops) {
		next = applyEntry(next, entry, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo_write`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoWriteParams["ops"],
): { phases: TodoPhase[]; errors: string[] } {
	return applyParams(cloneTodoPhases(currentPhases), { ops });
}

// =============================================================================
// Markdown round-trip
// =============================================================================

export { markdownToPhases, phasesToMarkdown } from "./todo-write-markdown";

function statusSymbol(status: TodoItem["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "→";
		case "abandoned":
			return "✗";
		default:
			return "○";
	}
}

function appendInProgressNotes(lines: string[], notes: string[]): void {
	for (let j = 0; j < notes.length; j++) {
		if (j > 0) lines.push("        ---");
		for (const noteLine of notes[j].split("\n")) {
			lines.push(`        ${noteLine}`);
		}
	}
}

function appendTaskSummary(lines: string[], task: TodoItem): void {
	const noteCount = task.notes?.length ?? 0;
	const noteMarker = noteCount > 0 ? ` (+${noteCount} note${noteCount === 1 ? "" : "s"})` : "";
	lines.push(`    ${statusSymbol(task.status)} ${task.content}${noteMarker}`);
	if (task.status === "in_progress" && task.notes && task.notes.length > 0) {
		appendInProgressNotes(lines, task.notes);
	}
}

function buildRemainingTasks(phases: TodoPhase[]): Array<TodoItem & { phase: string }> {
	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	return remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));
}

function appendRemainingTasksSummary(lines: string[], remainingTasks: Array<TodoItem & { phase: string }>): void {
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
		return;
	}
	lines.push(`Remaining items (${remainingTasks.length}):`);
	for (const task of remainingTasks) {
		lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
	}
}

function formatSummary(phases: TodoPhase[], errors: string[]): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingTasks = buildRemainingTasks(phases);
	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	appendRemainingTasksSummary(lines, remainingTasks);
	lines.push(
		`Phase ${currentIdx + 1}/${phases.length} "${current.name}" — ${done}/${current.tasks.length} tasks complete`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			appendTaskSummary(lines, task);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	readonly description: string;
	readonly parameters = todoWriteSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly intent = "omit" as const;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoWriteDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoWriteParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const previousPhases = cloneTodoPhases(this.session.getTodoPhases?.() ?? []);
		const { phases: updated, errors } = applyParams(previousPhases, params);
		this.session.setTodoPhases?.(updated);
		const storage =
			this.session.getSessionFile() !== undefined && this.session.getSessionFile() !== "" ? "session" : "memory";

		return {
			content: [{ type: "text", text: formatSummary(updated, errors) }],
			details: { phases: updated, storage },
		};
	}
}

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Display-only phase header: `I. Foundation`. State and prompts never see this. */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}

function noteMarker(count: number, uiTheme: Theme): string {
	if (count <= 0) return "";
	return uiTheme.fg("dim", chalk.italic(` \u207a${toSuperscript(count)}`));
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string): string {
	const checkbox = uiTheme.checkbox;
	const marker = noteMarker(item.notes?.length ?? 0, uiTheme);
	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(item.content)}`) + marker;
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(item.content)}`) + marker;
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
	}
}

function renderNoteAttachments(phases: TodoPhase[], uiTheme: Theme): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "in_progress" || !task.notes || task.notes.length === 0) continue;
			const bar = uiTheme.fg("dim", uiTheme.tree.vertical);
			const title = uiTheme.fg("dim", chalk.italic(`\u00a7 notes \u2014 ${task.content}`));
			lines.push("");
			lines.push(`  ${title}`);
			for (let j = 0; j < task.notes.length; j++) {
				if (j > 0) lines.push(`  ${bar}`);
				for (const noteLine of task.notes[j].split("\n")) {
					lines.push(`  ${bar} ${uiTheme.fg("dim", noteLine)}`);
				}
			}
		}
	}
	return lines;
}

function nonEmptyString(value: string | undefined | null): string | undefined {
	return value !== null && value !== undefined && value !== "" ? value : undefined;
}

function formatItemCount(count: number | undefined): string | undefined {
	if (count === undefined || count === 0) return undefined;
	return `${count} item${count === 1 ? "" : "s"}`;
}

function formatTodoOpEntry(entry: NonNullable<TodoWriteRenderArgs["ops"]>[number]): string {
	const parts: string[] = [entry.op ?? "update"];
	const task = nonEmptyString(entry.task);
	if (task !== undefined) parts.push(task);
	const phase = nonEmptyString(entry.phase);
	if (phase !== undefined) parts.push(phase);
	const items = formatItemCount(entry.items?.length);
	if (items !== undefined) parts.push(items);
	return parts.join(" ");
}

export const todoWriteToolRenderer = {
	renderCall(args: TodoWriteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const ops = args?.ops?.map(formatTodoOpEntry) ?? ["update"];
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: ops }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{ icon: "success", title: "Todo Write", meta: [`${allTasks.length} tasks`] },
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = result.content?.find(content => content.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const lines: string[] = [header];
		for (let p = 0; p < phases.length; p++) {
			const phase = phases[p];
			if (phases.length > 1) {
				lines.push(uiTheme.fg("accent", chalk.bold(`  ${formatPhaseDisplayName(phase.name, p + 1)}`)));
			}
			const treeLines = renderTreeList(
				{
					items: phase.tasks,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "todo",
					renderItem: todo => formatTodoLine(todo, uiTheme, ""),
				},
				uiTheme,
			);
			for (const line of treeLines) {
				lines.push(`  ${line}`);
			}
		}
		lines.push(...renderNoteAttachments(phases, uiTheme));
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
};
