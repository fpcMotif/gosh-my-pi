/**
 * OMP-RPC v1 — frozen wire vocabulary.
 *
 * This file is the **type-level contract** between the omp coding-agent
 * server (`omp --mode rpc`) and any consumer (today: `apps/tui-go`).
 * Every event the server emits and every command the host sends MUST
 * conform to one of the unions defined here.
 *
 * Versioning rules:
 * - Within v1, only **additive** evolution is allowed: new optional
 *   fields, new variant types. Existing fields and variants are frozen.
 * - Removal or rename of any existing field/variant requires a major
 *   bump (v2). The translator at `./translate.ts` is the seam — failing
 *   its exhaustiveness check means the wire shape changed.
 * - Unknown event types received by consumers are soft-buffered (preserved
 *   as raw JSON, not crashed on). See the `wire/README.md` spec.
 *
 * Curated subset rationale:
 * - The 10 pi-agent-core `AgentEvent` variants ARE on v1 — Go consumes them.
 * - The 10 coding-agent session extensions (`auto_compaction_*`,
 *   `auto_retry_*`, `retry_fallback_*`, `ttsr_triggered`, `todo_*`,
 *   `irc_message`) are NOT on v1 — Go currently ignores them; they stay
 *   internal to AgentSession's own subscribers and extension hooks. If a
 *   future feature needs one on the wire, additive evolution adds it.
 *
 * Wire types are structurally similar to pi-ai/pi-agent-core types but
 * are declared independently here. A rename or structural change in
 * pi-ai will break the translator's type-checking, forcing an explicit
 * wire-update decision instead of silent leakage.
 */

export const OMP_RPC_SCHEMA_V1 = "omp-rpc/v1" as const;
export type OmpRpcSchemaV1 = typeof OMP_RPC_SCHEMA_V1;

// ============================================================================
// Sub-shapes — content blocks, usage, error kinds
// ============================================================================

export interface WireTextContentV1 {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface WireThinkingContentV1 {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	itemId?: string;
}

export interface WireRedactedThinkingContentV1 {
	type: "redactedThinking";
	data: string;
}

export interface WireImageContentV1 {
	type: "image";
	data: string;
	mimeType: string;
}

export interface WireToolCallV1 {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
	intent?: string;
	customWireName?: string;
}

export type WireAssistantContentBlockV1 =
	| WireTextContentV1
	| WireThinkingContentV1
	| WireRedactedThinkingContentV1
	| WireToolCallV1;

export type WireUserContentBlockV1 = WireTextContentV1 | WireImageContentV1;

export interface WireUsageV1 {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests?: number;
	reasoningTokens?: number;
	cttl?: { ephemeral5m?: number; ephemeral1h?: number };
	server?: { webSearch?: number; webFetch?: number };
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type WireStopReasonV1 = "stop" | "length" | "toolUse" | "error" | "aborted";

export type WireMessageAttributionV1 = "user" | "agent";

export type WireTransientReasonV1 = "envelope" | "transport" | "rate_limit" | "model_capacity" | "server_error";

export type WireErrorKindV1 =
	| { kind: "context_overflow"; usedTokens?: number }
	| { kind: "usage_limit"; retryAfterMs: number }
	| { kind: "transient"; retryAfterMs?: number; reason?: WireTransientReasonV1 }
	| { kind: "fatal" };

// ============================================================================
// Messages — discriminated union by `role`
// ============================================================================

export interface WireUserMessageV1 {
	role: "user";
	content: string | WireUserContentBlockV1[];
	synthetic?: boolean;
	attribution?: WireMessageAttributionV1;
	timestamp: number;
}

export interface WireDeveloperMessageV1 {
	role: "developer";
	content: string | WireUserContentBlockV1[];
	attribution?: WireMessageAttributionV1;
	timestamp: number;
}

export interface WireAssistantMessageV1 {
	role: "assistant";
	content: WireAssistantContentBlockV1[];
	api: string;
	provider: string;
	model: string;
	responseId?: string;
	usage: WireUsageV1;
	stopReason: WireStopReasonV1;
	errorMessage?: string;
	timestamp: number;
	duration?: number;
	ttft?: number;
}

export interface WireToolResultMessageV1 {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: WireUserContentBlockV1[];
	details?: unknown;
	isError: boolean;
	attribution?: WireMessageAttributionV1;
	prunedAt?: number;
	timestamp: number;
}

export interface WireBashExecutionMessageV1 {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface WirePythonExecutionMessageV1 {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface WireCustomMessageV1 {
	role: "custom";
	customType: string;
	content: string | WireUserContentBlockV1[];
	display: boolean;
	details?: unknown;
	attribution?: WireMessageAttributionV1;
	timestamp: number;
}

export interface WireHookMessageV1 {
	role: "hookMessage";
	customType: string;
	content: string | WireUserContentBlockV1[];
	display: boolean;
	details?: unknown;
	attribution?: WireMessageAttributionV1;
	timestamp: number;
}

export type WireMessageV1 =
	| WireUserMessageV1
	| WireDeveloperMessageV1
	| WireAssistantMessageV1
	| WireToolResultMessageV1
	| WireBashExecutionMessageV1
	| WirePythonExecutionMessageV1
	| WireCustomMessageV1
	| WireHookMessageV1;

// ============================================================================
// Tool result (used in tool_execution_* events)
// ============================================================================

export interface WireToolResultV1 {
	content: WireUserContentBlockV1[];
	details?: unknown;
}

// ============================================================================
// Streaming sub-events (inside message_update)
// ============================================================================

export type WireAssistantMessageEventV1 =
	| { type: "start"; partial: WireAssistantMessageV1 }
	| { type: "text_start"; contentIndex: number; partial: WireAssistantMessageV1 }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: WireAssistantMessageV1 }
	| { type: "text_end"; contentIndex: number; content: string; partial: WireAssistantMessageV1 }
	| { type: "thinking_start"; contentIndex: number; partial: WireAssistantMessageV1 }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: WireAssistantMessageV1 }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: WireAssistantMessageV1 }
	| { type: "toolcall_start"; contentIndex: number; partial: WireAssistantMessageV1 }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: WireAssistantMessageV1 }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: WireToolCallV1;
			partial: WireAssistantMessageV1;
	  }
	| {
			type: "done";
			reason: Extract<WireStopReasonV1, "stop" | "length" | "toolUse">;
			message: WireAssistantMessageV1;
	  }
	| {
			type: "error";
			reason: Extract<WireStopReasonV1, "aborted" | "error">;
			error: WireAssistantMessageV1;
	  };

// ============================================================================
// Events — the 10 v1-curated AgentEvent variants
// ============================================================================

export type WireEventV1 =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: WireMessageV1[]; errorKind?: WireErrorKindV1 }
	| { type: "turn_start" }
	| { type: "turn_end"; message: WireMessageV1; toolResults: WireToolResultMessageV1[] }
	| { type: "message_start"; message: WireMessageV1 }
	| {
			type: "message_update";
			message: WireMessageV1;
			assistantMessageEvent: WireAssistantMessageEventV1;
	  }
	| { type: "message_end"; message: WireMessageV1; errorKind?: WireErrorKindV1 }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			intent?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: WireToolResultV1;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: WireToolResultV1;
			isError?: boolean;
	  };

export type WireEventTypeV1 = WireEventV1["type"];

// ============================================================================
// Outbound frame envelope (server → host)
// ============================================================================

export interface WireReadyFrameV1 {
	type: "ready";
	schema: OmpRpcSchemaV1;
}

/**
 * Diagnostic frame emitted when an extension hook throws unexpectedly.
 * Hosts MAY surface this in a UI; it's safe to ignore.
 */
export interface WireExtensionErrorFrameV1 {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

/**
 * The full set of frames the server may emit on stdout. Commands and
 * responses use the existing `RpcCommand` / `RpcResponse` shapes (decision
 * 5C — documented as v1 by reference). Extension-UI requests and host-tool
 * requests retain their distinct frame names per decision 8 (interpretation B).
 */
export type WireFrame =
	| WireReadyFrameV1
	| WireEventV1
	| WireExtensionErrorFrameV1
	| { type: "response"; [key: string]: unknown }
	| { type: "extension_ui_request"; [key: string]: unknown }
	| { type: "host_tool_call"; [key: string]: unknown }
	| { type: "host_tool_cancel"; [key: string]: unknown };
