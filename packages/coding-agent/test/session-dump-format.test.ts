import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { formatSessionDumpText } from "../src/session/session-dump-format";
import type { SessionDumpToolInfo } from "../src/session/session-dump-format";

describe("formatSessionDumpText", () => {
	it("formats metadata, tools, and every persisted message role used by dump export", () => {
		const model = fromAny<Model>({ provider: "openai", id: "gpt-5.4" });
		const tools: SessionDumpToolInfo[] = [
			{
				name: "search",
				description: "Search files",
				parameters: {
					type: "object",
					"TypeBox.Kind": "Object",
					properties: {
						query: { type: "string", "TypeBox.Optional": true },
					},
					required: ["query"],
				},
			},
		];
		const messages = fromAny<AgentMessage[]>([
			{ role: "user", content: "plain user text" },
			{
				role: "developer",
				content: [
					{ type: "text", text: "developer text" },
					{ type: "image", data: "abcd", mimeType: "image/png" },
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "assistant text" },
					{ type: "thinking", thinking: "   " },
					{ type: "thinking", thinking: "reasoning text" },
					{
						type: "toolCall",
						id: "tool-1",
						name: "search",
						arguments: { query: "src", limit: 2, [INTENT_FIELD]: "hidden intent" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "search",
				isError: true,
				content: [
					{ type: "text", text: "tool failed" },
					{ type: "image", data: "efgh", mimeType: "image/png" },
				],
			},
			{
				role: "bashExecution",
				command: "bun check",
				output: "check output",
				exitCode: 1,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "print(1)",
				output: "1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
			{
				role: "custom",
				customType: "Custom Notice",
				content: "custom string",
				display: true,
				timestamp: 3,
			},
			{
				role: "hookMessage",
				customType: "Hook Notice",
				content: [
					{ type: "text", text: "hook text" },
					{ type: "image", data: "ijkl", mimeType: "image/png" },
				],
				display: true,
				timestamp: 4,
			},
			{ role: "branchSummary", fromId: "branch-a", summary: "branch summary", timestamp: 5 },
			{ role: "compactionSummary", tokensBefore: 1234, summary: "compact summary", timestamp: 6 },
			{
				role: "fileMention",
				files: [
					{ path: "src/a.ts", content: "const a = 1;" },
					{
						path: "image.png",
						content: "",
						image: { type: "image", data: "mnop", mimeType: "image/png" },
					},
				],
				timestamp: 7,
			},
		]);

		const dump = formatSessionDumpText({
			systemPrompt: "system text",
			model,
			thinkingLevel: "high",
			tools,
			messages,
		});

		expect(dump).toContain("## System Prompt\n\nsystem text");
		expect(dump).toContain("Model: openai/gpt-5.4");
		expect(dump).toContain("Thinking Level: high");
		expect(dump).toContain('<tool name="search">');
		expect(dump).toContain('<parameter name="properties">{"query":{"type":"string"}}</parameter>');
		expect(dump).toContain('<parameter name="required">["query"]</parameter>');
		expect(dump).not.toContain("TypeBox.");
		expect(dump).toContain("## User\n\nplain user text");
		expect(dump).toContain("## Developer\n\ndeveloper text\n[Image]");
		expect(dump).toContain("<thinking>\nreasoning text\n</thinking>");
		expect(dump).not.toContain("hidden intent");
		expect(dump).toContain('<invoke name="search">');
		expect(dump).toContain('<parameter name="query">src</parameter>');
		expect(dump).toContain("### Tool Result: search\n(error)");
		expect(dump).toContain("tool failed");
		expect(dump).toContain("[Image output]");
		expect(dump).toContain("## Bash Execution");
		expect(dump).toContain("Command exited with code 1");
		expect(dump).toContain("## Python Execution");
		expect(dump).toContain("Ran Python:");
		expect(dump).toContain("## Custom Notice\n\ncustom string");
		expect(dump).toContain("## Hook Notice\n\nhook text\n[Image]");
		expect(dump).toContain("## Branch Summary\n\n(from branch: branch-a)");
		expect(dump).toContain("## Compaction Summary\n\n(1234 tokens before compaction)");
		expect(dump).toContain('<file path="src/a.ts">\nconst a = 1;');
		expect(dump).toContain('<file path="image.png">\n[Image attached]');
	});

	it("uses defaults and excludes execution messages marked out of context", () => {
		const messages = fromAny<AgentMessage[]>([
			{
				role: "bashExecution",
				command: "secret",
				output: "hidden bash",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 1,
			},
			{
				role: "pythonExecution",
				code: "secret()",
				output: "hidden python",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tool-2",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "ok" }],
			},
		]);

		const dump = formatSessionDumpText({
			systemPrompt: "",
			model: null,
			thinkingLevel: null,
			messages,
		});

		expect(dump).not.toContain("## System Prompt");
		expect(dump).toContain("Model: (not selected)");
		expect(dump).toContain("Thinking Level: ");
		expect(dump).not.toContain("hidden bash");
		expect(dump).not.toContain("hidden python");
		expect(dump).toContain("### Tool Result: read");
		expect(dump).not.toContain("(error)");
		expect(dump).toContain("```\nok\n```");
	});
});
