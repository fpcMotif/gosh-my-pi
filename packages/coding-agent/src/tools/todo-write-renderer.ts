/**
 * TUI renderer for the todo-write tool, extracted to keep todo-write.ts under
 * the max-lines threshold.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";
import type { TodoItem, TodoPhase, TodoWriteToolDetails } from "./todo-write";
import { formatPhaseDisplayName } from "./todo-write";

type TodoWriteRenderArgs = {
	ops?: Array<{
		op?: string;
		task?: string;
		phase?: string;
		items?: string[];
	}>;
};

const SUP_DIGITS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
};

function toSuperscript(n: number): string {
	return n
		.toString()
		.split("")
		.map(d => SUP_DIGITS[d] ?? d)
		.join("");
}

function noteMarker(count: number, uiTheme: Theme): string {
	if (count <= 0) return "";
	return uiTheme.fg("dim", chalk.italic(` ⁺${toSuperscript(count)}`));
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
			const title = uiTheme.fg("dim", chalk.italic(`§ notes — ${task.content}`));
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
	const parts = [entry.op ?? "update"];
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
