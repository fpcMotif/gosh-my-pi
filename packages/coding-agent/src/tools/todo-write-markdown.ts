/**
 * Markdown round-trip helpers for todo phases.
 *
 * Extracted from todo-write.ts to keep that file under the max-lines threshold.
 */
import type { TodoItem, TodoPhase, TodoStatus } from "./todo-write";
import { normalizeInProgressTask } from "./todo-write";

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

function appendNotesMarkdown(out: string[], notes: string[]): void {
	for (let j = 0; j < notes.length; j++) {
		if (j > 0) out.push("  >");
		for (const noteLine of notes[j].split("\n")) {
			out.push(noteLine === "" ? "  >" : `  > ${noteLine}`);
		}
	}
}

function appendTaskMarkdown(out: string[], task: TodoItem): void {
	out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
	if (task.notes && task.notes.length > 0) {
		appendNotesMarkdown(out, task.notes);
	}
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			appendTaskMarkdown(out, task);
		}
	}
	return `${out.join("\n")}\n`;
}

interface MarkdownParseState {
	phases: TodoPhase[];
	errors: string[];
	currentPhase: TodoPhase | undefined;
	currentTask: TodoItem | undefined;
	noteBuf: string[];
}

function flushNote(state: MarkdownParseState): void {
	if (!state.currentTask || state.noteBuf.length === 0) {
		state.noteBuf = [];
		return;
	}
	while (state.noteBuf.length > 0 && state.noteBuf[state.noteBuf.length - 1] === "") {
		state.noteBuf.pop();
	}
	if (state.noteBuf.length === 0) return;
	const joined = state.noteBuf.join("\n");
	state.currentTask.notes = state.currentTask.notes ? [...state.currentTask.notes, joined] : [joined];
	state.noteBuf = [];
}

function consumeNoteLine(state: MarkdownParseState, raw: string): boolean {
	const noteMatch = /^\s*>\s?(.*)$/.exec(raw);
	if (!noteMatch || !state.currentTask) return false;
	const noteLine = noteMatch[1];
	if (noteLine === "") {
		flushNote(state);
	} else {
		state.noteBuf.push(noteLine);
	}
	return true;
}

function consumeHeadingLine(state: MarkdownParseState, trimmed: string): boolean {
	const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
	if (!headingMatch) return false;
	flushNote(state);
	state.currentTask = undefined;
	state.currentPhase = { name: headingMatch[1].trim(), tasks: [] };
	state.phases.push(state.currentPhase);
	return true;
}

function consumeTaskLine(state: MarkdownParseState, trimmed: string, lineNum: number): boolean {
	const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
	if (!taskMatch) return false;
	flushNote(state);
	if (!state.currentPhase) {
		state.currentPhase = { name: "Todos", tasks: [] };
		state.phases.push(state.currentPhase);
	}
	const marker = taskMatch[1];
	const status = MARKER_TO_STATUS[marker];
	if (!status) {
		state.errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
		state.currentTask = undefined;
		return true;
	}
	state.currentTask = { content: taskMatch[2].trim(), status };
	state.currentPhase.tasks.push(state.currentTask);
	return true;
}

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const state: MarkdownParseState = {
		phases: [],
		errors: [],
		currentPhase: undefined,
		currentTask: undefined,
		noteBuf: [],
	};

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];
		if (consumeNoteLine(state, raw)) continue;

		const trimmed = raw.trim();
		if (!trimmed) continue;
		if (consumeHeadingLine(state, trimmed)) continue;
		if (consumeTaskLine(state, trimmed, lineNum)) continue;

		flushNote(state);
		state.currentTask = undefined;
		state.errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}
	flushNote(state);

	normalizeInProgressTask(state.phases);
	return { phases: state.phases, errors: state.errors };
}
