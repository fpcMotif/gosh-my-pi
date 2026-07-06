import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { RequestCorrelator } from "@oh-my-pi/pi-coding-agent/modes/rpc/request-correlator";
import {
	buildToolApprovalParams,
	createToolApprovalHook,
	GATED_TOOL_NAMES,
	mapApprovalResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-tool-approval";
import { ToolApprovalMethod } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { WireFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/v1";

interface CapturedFrame {
	type: string;
	[key: string]: unknown;
}

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

function setup() {
	const correlator = new RequestCorrelator();
	const frames: CapturedFrame[] = [];
	const hook = createToolApprovalHook({
		correlator,
		output: (frame: WireFrame) => {
			frames.push(frame as CapturedFrame);
		},
		timeoutMs: 200,
	});
	return { correlator, frames, hook };
}

describe("createToolApprovalHook", () => {
	it("auto-approves a non-gated tool without emitting a request", async () => {
		const { frames, hook } = setup();
		const decision = await hook(makeToolCall("read", { path: "/etc/hosts" }));
		expect(decision).toEqual({ approved: true });
		expect(frames).toHaveLength(0);
	});

	it("emits a correlated tool.request_approval for a gated tool", async () => {
		const { correlator, frames, hook } = setup();
		const promise = hook(makeToolCall("bash", { command: "rm -rf /tmp/x", cwd: "/repo" }));

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "extension_ui_request",
			method: ToolApprovalMethod.RequestApproval,
			toolCallId: "call-bash",
			toolName: "bash",
			params: { command: "rm -rf /tmp/x", workingDir: "/repo" },
		});
		expect(typeof frames[0].id).toBe("string");

		// Resolve so the awaiting hook settles and the correlator is drained.
		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			confirmed: true,
		});
		await promise;
	});

	it("resolves { approved: true } from a confirm response", async () => {
		const { correlator, frames, hook } = setup();
		const promise = hook(makeToolCall("write", { path: "a.txt", content: "x" }));
		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			confirmed: true,
		});
		expect(await promise).toEqual({ approved: true });
	});

	it("resolves { approved: false } from a deny (confirmed:false) response", async () => {
		const { correlator, frames, hook } = setup();
		const promise = hook(makeToolCall("edit", { file_path: "a.ts" }));
		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			confirmed: false,
		});
		expect(await promise).toEqual({ approved: false });
	});

	it("denies on a cancelled (dismissed) response", async () => {
		const { correlator, frames, hook } = setup();
		const promise = hook(makeToolCall("apply_patch", {}));
		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			cancelled: true,
		});
		const decision = await promise;
		expect(decision.approved).toBe(false);
	});

	it("honors a custom isGated policy", async () => {
		const correlator = new RequestCorrelator();
		const frames: CapturedFrame[] = [];
		const hook = createToolApprovalHook({
			correlator,
			output: f => frames.push(f as CapturedFrame),
			isGated: name => name === "read",
		});
		// "read" is now gated → emits; "bash" is not → auto-approves.
		void hook(makeToolCall("read"));
		expect(frames).toHaveLength(1);
		expect(await hook(makeToolCall("bash", { command: "ls" }))).toEqual({ approved: true });
		expect(frames).toHaveLength(1);
	});

	it("fails closed: a gated tool is DENIED when the host never replies and the dialog times out (ADR 0007)", async () => {
		const correlator = new RequestCorrelator();
		const frames: CapturedFrame[] = [];
		const hook = createToolApprovalHook({
			correlator,
			output: f => frames.push(f as CapturedFrame),
			timeoutMs: 25,
		});
		// No correlator.resolve(...) — the host never answers. The hook must
		// drive the real timeout path (register → defaultValue undefined →
		// mapApprovalResponse) and deny, never silently approve a destructive tool.
		const decision = await hook(makeToolCall("bash", { command: "rm -rf /" }));
		expect(decision.approved).toBe(false);
		// The request was emitted, then settled by timeout and cleaned up.
		expect(frames).toHaveLength(1);
		expect(correlator.pendingCount).toBe(0);
	});
});

describe("buildToolApprovalParams", () => {
	it("maps edit-style args into filePath + old/new content", () => {
		const params = buildToolApprovalParams(
			makeToolCall("edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
		);
		expect(params).toEqual({ filePath: "src/a.ts", oldContent: "a", newContent: "b" });
	});

	it("carries the tool-call intent as the description", () => {
		const tc = makeToolCall("bash", { command: "ls" });
		tc.intent = "list files";
		const params = buildToolApprovalParams(tc);
		expect(params.description).toBe("list files");
	});
});

describe("mapApprovalResponse", () => {
	it("denies on undefined (timeout/abort)", () => {
		expect(mapApprovalResponse(undefined).approved).toBe(false);
	});

	it("approves on a non-empty value", () => {
		expect(mapApprovalResponse({ type: "extension_ui_response", id: "1", value: "allow" })).toEqual({
			approved: true,
		});
	});
});

describe("GATED_TOOL_NAMES", () => {
	it("gates exactly the four destructive built-ins (ADR 0007)", () => {
		expect([...GATED_TOOL_NAMES].sort()).toEqual(["apply_patch", "bash", "edit", "write"]);
	});
});
