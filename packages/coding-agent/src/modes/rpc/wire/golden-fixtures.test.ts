import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentSessionEvent } from "../../../session/agent-session";
import { toWireEvent } from "./translate";
import type { WireEventV1 } from "./v1";

// ============================================================================
// Cross-language golden wire fixtures (gap G23).
//
// Each fixture under __fixtures__/wire-v1/ is the exact wire JSON a real
// backend emits for one representative variant. This suite builds the internal
// AgentSessionEvent for each and asserts toWireEvent(...) deep-equals the
// fixture. The Go decode-parity suite (apps/tui-go/internal/workspace/
// wire_golden_test.go) consumes the SAME files. If a wire field is renamed in
// translate.ts / v1.ts, this side fails; if a Go struct tag drifts, that side
// fails. Together they pin TS<->Go wire agreement that the independent per-side
// suites cannot.
// ============================================================================

const FIXTURES_DIR = path.join(import.meta.dir, "__fixtures__", "wire-v1");

async function loadFixture(name: string): Promise<unknown> {
	return await Bun.file(path.join(FIXTURES_DIR, name)).json();
}

const usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(opts: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage,
		stopReason: "stop",
		timestamp: 1_717_200_000_001,
		...opts,
	};
}

// Each entry pairs a fixture file with the internal event that must project
// onto it. The deep-equal is the contract: toWireEvent output === fixture bytes.
const cases: Array<{ fixture: string; event: AgentSessionEvent }> = [
	{
		fixture: "agent_start.json",
		event: { type: "agent_start" },
	},
	{
		fixture: "agent_end.json",
		event: {
			type: "agent_end",
			messages: [
				{ role: "user", content: "hello", timestamp: 1_717_200_000_000 } as AgentMessage,
				assistantMessage({ content: [{ type: "text", text: "Hello back" }] }) as AgentMessage,
			],
		},
	},
	{
		fixture: "agent_end.error_kind.json",
		event: {
			type: "agent_end",
			messages: [
				assistantMessage({
					content: [{ type: "text", text: "partial" }],
					stopReason: "error",
					errorMessage: "usage limit",
				}) as AgentMessage,
			],
			errorKind: { kind: "usage_limit", retryAfterMs: 30_000 },
		},
	},
	{
		fixture: "turn_end.json",
		event: {
			type: "turn_end",
			message: assistantMessage({ content: [{ type: "text", text: "done" }] }),
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "call-bash-1",
					toolName: "bash",
					content: [{ type: "text", text: "/tmp/project" }],
					isError: false,
					timestamp: 1_717_200_000_002,
				},
			],
		},
	},
	{
		fixture: "message_start.json",
		event: {
			type: "message_start",
			message: assistantMessage({
				content: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: usage.cost },
			}) as AgentMessage,
		},
	},
	{
		// A user message_start carrying the client correlationId. Pins that
		// toWireUserMessage emits correlationId so the Go bridge can reconcile the
		// echoed message with its optimistic local copy by id (gmp correlation).
		fixture: "message_start.user_correlation.json",
		event: {
			type: "message_start",
			message: {
				role: "user",
				content: "hello",
				attribution: "user",
				correlationId: "client-msg-7f3a2b1c",
				timestamp: 1_717_200_000_000,
			} as AgentMessage,
		},
	},
	{
		fixture: "message_update.text_delta.json",
		event: (() => {
			const partial = assistantMessage();
			return {
				type: "message_update",
				message: partial as AgentMessage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial },
			};
		})(),
	},
	{
		fixture: "message_update.toolcall_end.json",
		event: (() => {
			const partial = assistantMessage({
				content: [{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls -la" } }],
				stopReason: "toolUse",
			});
			return {
				type: "message_update",
				message: partial as AgentMessage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls -la" } },
					partial,
				},
			};
		})(),
	},
	{
		fixture: "message_end.error_kind.json",
		event: {
			type: "message_end",
			message: assistantMessage({
				content: [{ type: "text", text: "partial" }],
				stopReason: "error",
				errorMessage: "context full",
			}) as AgentMessage,
			errorKind: { kind: "context_overflow", usedTokens: 250_000 },
		},
	},
	{
		fixture: "tool_execution_start.json",
		event: {
			type: "tool_execution_start",
			toolCallId: "call-bash-1",
			toolName: "bash",
			args: { command: "ls -la" },
			intent: "list files",
		},
	},
	{
		fixture: "tool_execution_update.json",
		event: {
			type: "tool_execution_update",
			toolCallId: "call-read-1",
			toolName: "read",
			args: { path: "src/value.ts" },
			partialResult: {
				content: [{ type: "text", text: "1|const value = 1;" }],
				details: { kind: "file", displayContent: { text: "const value = 1;", startLine: 1 } },
			},
		},
	},
	{
		fixture: "tool_execution_end.edit_diff.json",
		event: {
			type: "tool_execution_end",
			toolCallId: "call-edit-1",
			toolName: "apply_patch",
			result: {
				content: [{ type: "text", text: "Updated src/x.ts" }],
				details: { diff: " 1|first line\n-2|old line\n+2|new line\n 3|third line", op: "update" },
			},
			isError: false,
		},
	},
];

describe("OMP-RPC v1 golden fixtures — TS encode parity", () => {
	for (const { fixture, event } of cases) {
		test(`${fixture}: toWireEvent output matches the checked-in wire bytes`, async () => {
			const expected = await loadFixture(fixture);
			const wire: WireEventV1 | null = toWireEvent(event);
			expect(wire).toEqual(expected as WireEventV1);
		});
	}

	test("ready.json is the v1 handshake the Go client expects", async () => {
		// The ready frame is not produced by toWireEvent (it is emitted directly
		// by rpc-mode at startup). Pin its bytes so the Go ReadyFrame decode and
		// ExpectedSchema constant stay in lockstep.
		expect(await loadFixture("ready.json")).toEqual({ type: "ready", schema: "omp-rpc/v1" });
	});
});

// ============================================================================
// Ordering fixture — one full ordered prompt cycle as JSONL.
// ============================================================================

describe("OMP-RPC v1 golden fixtures — ordering", () => {
	test("ordering.sequence.jsonl is the expected ordered prompt cycle", async () => {
		const text = await Bun.file(path.join(FIXTURES_DIR, "ordering.sequence.jsonl")).text();
		const frames = Bun.JSONL.parse(text) as WireEventV1[];
		const order = frames.map(f => f.type);
		expect(order).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"tool_execution_start",
			"tool_execution_end",
			"turn_end",
			"agent_end",
		]);
		// Each line must be a structurally valid v1 frame (has a string `type`).
		for (const frame of frames) {
			expect(typeof frame.type).toBe("string");
		}
	});
});
