import { Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { RequestCorrelator } from "./request-correlator";
import {
	type RpcExtensionUIResponse,
	ToolApprovalMethod,
	type ToolApprovalParams,
	type ToolApprovalRequestPayload,
} from "./rpc-types";
import type { WireFrame } from "./wire/v1";

/**
 * Destructive built-in tools gated behind the host approval round-trip
 * (ADR 0007). Every other tool auto-approves with no wire traffic.
 */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "edit", "apply_patch", "write"]);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

/**
 * Build the small per-tool summary carried on a `tool.request_approval`
 * request. Pulls the common argument keys defensively so it stays decoupled
 * from each tool's exact schema; the Go side renders these into the existing
 * `dialog.Permissions` per-tool Params (bash command, file path + diff).
 */
export function buildToolApprovalParams(toolCall: ToolCall): ToolApprovalParams {
	const args = toolCall.arguments ?? {};
	const params: ToolApprovalParams = {};
	const command = firstString(args, ["command"]);
	if (command !== undefined) params.command = command;
	const workingDir = firstString(args, ["working_dir", "cwd"]);
	if (workingDir !== undefined) params.workingDir = workingDir;
	const filePath = firstString(args, ["file_path", "path", "abs_path"]);
	if (filePath !== undefined) params.filePath = filePath;
	const oldContent = firstString(args, ["old_content", "old_string"]);
	if (oldContent !== undefined) params.oldContent = oldContent;
	const newContent = firstString(args, ["new_content", "new_string", "content"]);
	if (newContent !== undefined) params.newContent = newContent;
	if (typeof toolCall.intent === "string" && toolCall.intent !== "") params.description = toolCall.intent;
	return params;
}

/**
 * Map a host `extension_ui_response` to an approval decision. Gate-by-default:
 * an undefined response (timeout/abort), an explicit cancel, or `confirmed:
 * false` denies; a `confirmed: true` or a non-empty `value` approves. Mirrors
 * ADR 0007's "cancelled or timed-out dialog denies rather than silently
 * allowing".
 */
export function mapApprovalResponse(response: RpcExtensionUIResponse | undefined): ToolApprovalDecision {
	if (response === undefined) return { approved: false, reason: "approval dialog dismissed" };
	if ("cancelled" in response && response.cancelled === true) {
		return { approved: false, reason: "denied by user" };
	}
	if ("confirmed" in response) return { approved: response.confirmed };
	if ("value" in response && typeof response.value === "string" && response.value !== "") {
		return { approved: true };
	}
	return { approved: false, reason: "denied by user" };
}

export interface ToolApprovalHookOptions {
	correlator: RequestCorrelator;
	output: (frame: WireFrame) => void;
	/** Override the gate policy (defaults to {@link GATED_TOOL_NAMES}). */
	isGated?: (toolName: string) => boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Build the host tool-approval hook for `omp --mode rpc` (ADR 0007, G11
 * part 2). Returned function is attached via `agent.setToolApprovalHook`.
 *
 * - Non-gated tools resolve `{ approved: true }` immediately with no wire
 *   traffic (the common path adds no latency).
 * - Gated tools emit a correlated `tool.request_approval` extension_ui_request
 *   and await the matching `extension_ui_response` via the shared
 *   `RequestCorrelator` — the same emit-and-await pattern as the auth.* flow
 *   in `RpcOAuthController`.
 *
 * Extracted as a free function so the gate policy + round-trip is unit
 * testable without an `AgentSession`, mirroring `emitDetachedPromptFailure`.
 */
export function createToolApprovalHook(
	opts: ToolApprovalHookOptions,
): (toolCall: ToolCall) => Promise<ToolApprovalDecision> {
	const isGated = opts.isGated ?? (name => GATED_TOOL_NAMES.has(name));
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return async (toolCall: ToolCall): Promise<ToolApprovalDecision> => {
		if (!isGated(toolCall.name)) return { approved: true };

		const { id, promise } = opts.correlator.register<RpcExtensionUIResponse | undefined>({
			id: Snowflake.next() as string,
			signal: opts.signal,
			timeoutMs,
			defaultValue: undefined,
		});
		// Type-lock the emit against the wire variant (DC7 / ADR 0007): a field
		// drift in RpcExtensionUIRequest's tool.request_approval shape now fails
		// to compile here instead of leaking a malformed frame onto the wire.
		const payload: ToolApprovalRequestPayload = {
			method: ToolApprovalMethod.RequestApproval,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			params: buildToolApprovalParams(toolCall),
		};
		opts.output({ type: "extension_ui_request", id, ...payload });
		return mapApprovalResponse(await promise);
	};
}
