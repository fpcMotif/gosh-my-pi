import { beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import { TreeSelectorComponent } from "../../../src/modes/components/tree-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "../../../src/session/session-manager";

function entry(id: string, parentId: string | null, value: Omit<SessionEntry, "id" | "parentId" | "timestamp">) {
	return fromAny<SessionEntry>({
		id,
		parentId,
		timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
		...value,
	});
}

function node(entryValue: SessionEntry, children: SessionTreeNode[] = [], label?: string): SessionTreeNode {
	return { entry: entryValue, children, label };
}

function render(component: TreeSelectorComponent, width = 140): string {
	return sanitizeText(Bun.stripANSI(component.render(width).join("\n")));
}

function buildTree(): SessionTreeNode[] {
	const toolCalls = entry("assistant-tools", "root", {
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "read-call",
					name: "read",
					arguments: { path: "src/read.ts", offset: 2, limit: 3 },
				},
				{ type: "toolCall", id: "write-call", name: "write", arguments: { path: "src/write.ts" } },
				{ type: "toolCall", id: "edit-call", name: "edit", arguments: { file_path: "src/edit.ts" } },
				{
					type: "toolCall",
					id: "bash-call",
					name: "bash",
					arguments: { command: "bun test test/example.test.ts --filter long command text" },
				},
				{ type: "toolCall", id: "search-call", name: "search", arguments: { pattern: "TODO", path: "src" } },
				{ type: "toolCall", id: "find-call", name: "find", arguments: { pattern: "*.ts", path: "src" } },
				{ type: "toolCall", id: "ls-call", name: "ls", arguments: { path: "packages" } },
				{
					type: "toolCall",
					id: "custom-call",
					name: "custom_tool",
					arguments: { alpha: "beta", long: "x".repeat(80) },
				},
			],
		},
	});

	const toolResult = (id: string, toolCallId: string, toolName: string) =>
		node(
			entry(id, "assistant-tools", {
				type: "message",
				message: {
					role: "toolResult",
					toolCallId,
					toolName,
					content: [{ type: "text", text: `${toolName} result` }],
				},
			}),
		);

	return [
		node(
			entry("root", null, {
				type: "message",
				message: { role: "user", content: "First\trequest" },
			}),
			[
				node(toolCalls, [
					toolResult("read-result", "read-call", "read"),
					toolResult("write-result", "write-call", "write"),
					toolResult("edit-result", "edit-call", "edit"),
					toolResult("bash-result", "bash-call", "bash"),
					toolResult("search-result", "search-call", "search"),
					toolResult("find-result", "find-call", "find"),
					toolResult("ls-result", "ls-call", "ls"),
					toolResult("custom-result", "custom-call", "custom_tool"),
				]),
				node(
					entry("assistant-text", "root", {
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "Done\nwith details" },
								{ type: "image", image: "ignored" },
							],
						},
					}),
				),
				node(
					entry("assistant-aborted", "root", {
						type: "message",
						message: { role: "assistant", stopReason: "aborted", content: [] },
					}),
				),
				node(
					entry("assistant-error", "root", {
						type: "message",
						message: { role: "assistant", errorMessage: "failed\tbadly", content: [] },
					}),
				),
				node(
					entry("bash-entry", "root", {
						type: "message",
						message: { role: "bashExecution", command: "git status\nshort" },
					}),
				),
				node(
					entry("custom-message", "root", {
						type: "custom_message",
						customType: "notice",
						content: [{ type: "text", text: "custom body" }],
						display: true,
					}),
				),
				node(
					entry("compaction", "root", {
						type: "compaction",
						summary: "compact summary",
						firstKeptEntryId: "root",
						tokensBefore: 12_345,
					}),
				),
				node(
					entry("branch", "root", {
						type: "branch_summary",
						fromId: "root",
						summary: "branch summary text",
					}),
				),
				node(entry("model", "root", { type: "model_change", model: "openai/gpt-test", role: "default" })),
				node(entry("thinking", "root", { type: "thinking_level_change", thinkingLevel: "high" })),
				node(entry("custom", "root", { type: "custom", customType: "marker", data: { ok: true } })),
				node(
					entry("label", "root", { type: "label", targetId: "assistant-text", label: "bookmark" }),
					[],
					"bookmark",
				),
			],
		),
		node(
			entry("second-root", null, {
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Second root" }] },
			}),
		),
	];
}

describe("TreeSelectorComponent", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders session entries, formats tool results, filters, searches, labels, and selects", () => {
		const selected: string[] = [];
		const onCancel = vi.fn();
		const onLabelChange = vi.fn();
		const selector = new TreeSelectorComponent(
			buildTree(),
			"read-result",
			24,
			id => selected.push(id),
			onCancel,
			onLabelChange,
		);

		const initial = render(selector);
		expect(initial).toContain("Session Tree");
		expect(initial).toContain("user: First request");
		expect(initial).toContain("[read: src/read.ts:2-4]");
		expect(initial).toContain("[write: src/write.ts]");
		expect(initial).toContain("[edit: src/edit.ts]");
		expect(initial).toContain("[bash: bun test test/example.test.ts --filter long comman...");
		expect(initial).toContain("[search: /TODO/ in src]");
		expect(initial).toContain("[find: *.ts in src]");
		expect(initial).toContain("[ls: packages]");
		expect(initial).toContain("[custom_tool:");

		selector.handleInput("\r");
		expect(selected).toEqual(["read-result"]);

		selector.handleInput("branch");
		expect(render(selector)).toContain("Search: branch");
		expect(render(selector)).toContain("[branch summary]: branch summary text");
		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("zzzz");
		expect(render(selector)).toContain("No entries found");
		selector.handleInput("\x1b");

		selector.handleInput("\x1ba");
		const allEntries = render(selector);
		expect(allEntries).toContain("[model: openai/gpt-test]");
		expect(allEntries).toContain("[thinking: high]");
		expect(allEntries).toContain("[custom: marker]");
		expect(allEntries).toContain("[label: bookmark]");
		expect(allEntries).toContain("[all]");

		selector.handleInput("\x1bu");
		const userOnly = render(selector);
		expect(userOnly).toContain("user: First request");
		expect(userOnly).toContain("[user]");
		expect(userOnly).not.toContain("[read: src/read.ts:2-4]");

		selector.handleInput("\x1bl");
		expect(render(selector)).toContain("[labeled]");

		selector.handleInput("L");
		expect(render(selector)).toContain("Label (empty to remove):");
		selector.handleInput("new label");
		selector.handleInput("\r");
		expect(onLabelChange).toHaveBeenCalledWith("label", "new labelbookmark");
		expect(render(selector)).toContain("[new labelbookmark]");

		selector.handleInput("\x1b[A");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1bd");
		expect(render(selector)).not.toContain("[labeled]");

		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("renders empty trees and auto-cancels after the empty-state delay", async () => {
		const onCancel = vi.fn();
		const selector = new TreeSelectorComponent([], null, 10, vi.fn(), onCancel);

		expect(render(selector)).toContain("No entries found");
		await Bun.sleep(130);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
