/**
 * Internal AgentSessionEvent → OMP-RPC v1 wire event translation.
 *
 * This module is the wire contract. The exhaustive `switch` in
 * {@link toWireEvent} forces the compiler to flag any new internal
 * variant — failing to handle it is a type error. Internal-only events
 * (the 10 coding-agent session extensions) translate to `null` and are
 * dropped at the {@link rpc-mode} chokepoint.
 *
 * Wire shape changes happen in lockstep with this file. If a pi-agent-core
 * field is renamed, the translator's projection breaks at compile time,
 * forcing an explicit decision: update the wire (additive evolution
 * within v1) or pin the old field name in the projection.
 */

import type {
	AgentEvent,
	AgentErrorKind,
	AgentMessage,
	TransientReason,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	MessageAttribution,
	RedactedThinkingContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../../session/agent-session";
import type {
	BashExecutionMessage,
	CustomMessage,
	HookMessage,
	PythonExecutionMessage,
} from "../../../session/messages";
import type {
	WireAssistantContentBlockV1,
	WireAssistantMessageEventV1,
	WireAssistantMessageV1,
	WireBashExecutionMessageV1,
	WireCustomMessageV1,
	WireErrorKindV1,
	WireEventV1,
	WireHookMessageV1,
	WireImageContentV1,
	WireMessageAttributionV1,
	WireMessageV1,
	WirePythonExecutionMessageV1,
	WireRedactedThinkingContentV1,
	WireStopReasonV1,
	WireTextContentV1,
	WireThinkingContentV1,
	WireToolCallV1,
	WireToolResultMessageV1,
	WireToolResultV1,
	WireTransientReasonV1,
	WireUsageV1,
	WireUserContentBlockV1,
	WireUserMessageV1,
} from "./v1";

/**
 * Translate an internal AgentSessionEvent into a v1 wire event, or null
 * when the event is internal-only and not part of the v1 wire vocabulary.
 *
 * The 10 pi-agent-core AgentEvent variants project onto the wire. The 10
 * coding-agent session extensions (`auto_compaction_*`, `auto_retry_*`,
 * `retry_fallback_*`, `ttsr_triggered`, `todo_*`, `irc_message`) are
 * dropped from the wire — they remain available to in-process subscribers
 * but never reach external consumers.
 */
export function toWireEvent(event: AgentSessionEvent): WireEventV1 | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };

		case "agent_end":
			return {
				type: "agent_end",
				messages: event.messages.map(toWireMessage),
				...(event.errorKind !== undefined && { errorKind: toWireErrorKind(event.errorKind) }),
			};

		case "turn_start":
			return { type: "turn_start" };

		case "turn_end":
			return {
				type: "turn_end",
				message: toWireMessage(event.message),
				toolResults: event.toolResults.map(toWireToolResultMessage),
			};

		case "message_start":
			return { type: "message_start", message: toWireMessage(event.message) };

		case "message_update":
			return {
				type: "message_update",
				message: toWireMessage(event.message),
				assistantMessageEvent: toWireAssistantMessageEvent(event.assistantMessageEvent),
			};

		case "message_end":
			return {
				type: "message_end",
				message: toWireMessage(event.message),
				...(event.errorKind !== undefined && { errorKind: toWireErrorKind(event.errorKind) }),
			};

		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				...(event.intent !== undefined && { intent: event.intent }),
			};

		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: toWireToolResult(event.partialResult),
			};

		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: toWireToolResult(event.result),
				...(event.isError !== undefined && { isError: event.isError }),
			};

		// ============================================================================
		// Internal-only events — not on the v1 wire (decision 1B curated subset).
		// Translator returns null; rpc-mode skips emission.
		// ============================================================================
		case "auto_compaction_start":
		case "auto_compaction_end":
		case "auto_retry_start":
		case "auto_retry_end":
		case "retry_fallback_applied":
		case "retry_fallback_succeeded":
		case "ttsr_triggered":
		case "todo_reminder":
		case "todo_auto_clear":
		case "irc_message":
			return null;

		default: {
			// Exhaustiveness check — every AgentSessionEvent variant must be handled.
			// If a new internal event is added without a translator entry, this assertion
			// fails at compile time.
			const _exhaustive: never = event;
			void _exhaustive;
			return null;
		}
	}
}

// ============================================================================
// Sub-shape projections
// ============================================================================

function toWireAttribution(attribution: MessageAttribution | undefined): WireMessageAttributionV1 | undefined {
	return attribution;
}

function toWireUsage(usage: Usage): WireUsageV1 {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
		...(usage.premiumRequests !== undefined && { premiumRequests: usage.premiumRequests }),
		...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
		...(usage.cttl !== undefined && { cttl: { ...usage.cttl } }),
		...(usage.server !== undefined && { server: { ...usage.server } }),
	};
}

function toWireStopReason(reason: StopReason): WireStopReasonV1 {
	return reason;
}

function toWireTransientReason(reason: TransientReason): WireTransientReasonV1 {
	return reason;
}

function toWireErrorKind(kind: AgentErrorKind): WireErrorKindV1 {
	switch (kind.kind) {
		case "context_overflow":
			return kind.usedTokens !== undefined
				? { kind: "context_overflow", usedTokens: kind.usedTokens }
				: { kind: "context_overflow" };
		case "usage_limit":
			return { kind: "usage_limit", retryAfterMs: kind.retryAfterMs };
		case "transient":
			return {
				kind: "transient",
				...(kind.retryAfterMs !== undefined && { retryAfterMs: kind.retryAfterMs }),
				...(kind.reason !== undefined && { reason: toWireTransientReason(kind.reason) }),
			};
		case "fatal":
			return { kind: "fatal" };
	}
}

function toWireText(c: TextContent): WireTextContentV1 {
	return {
		type: "text",
		text: c.text,
		...(c.textSignature !== undefined && { textSignature: c.textSignature }),
	};
}

function toWireThinking(c: ThinkingContent): WireThinkingContentV1 {
	return {
		type: "thinking",
		thinking: c.thinking,
		...(c.thinkingSignature !== undefined && { thinkingSignature: c.thinkingSignature }),
		...(c.itemId !== undefined && { itemId: c.itemId }),
	};
}

function toWireRedactedThinking(c: RedactedThinkingContent): WireRedactedThinkingContentV1 {
	return { type: "redactedThinking", data: c.data };
}

function toWireImage(c: ImageContent): WireImageContentV1 {
	return { type: "image", data: c.data, mimeType: c.mimeType };
}

function toWireToolCall(c: ToolCall): WireToolCallV1 {
	return {
		type: "toolCall",
		id: c.id,
		name: c.name,
		arguments: c.arguments,
		...(c.thoughtSignature !== undefined && { thoughtSignature: c.thoughtSignature }),
		...(c.intent !== undefined && { intent: c.intent }),
		...(c.customWireName !== undefined && { customWireName: c.customWireName }),
	};
}

function toWireAssistantContent(
	c: TextContent | ThinkingContent | RedactedThinkingContent | ToolCall,
): WireAssistantContentBlockV1 {
	switch (c.type) {
		case "text":
			return toWireText(c);
		case "thinking":
			return toWireThinking(c);
		case "redactedThinking":
			return toWireRedactedThinking(c);
		case "toolCall":
			return toWireToolCall(c);
	}
}

function toWireUserContent(c: TextContent | ImageContent): WireUserContentBlockV1 {
	switch (c.type) {
		case "text":
			return toWireText(c);
		case "image":
			return toWireImage(c);
	}
}

function toWireUserContentList(content: string | (TextContent | ImageContent)[]): string | WireUserContentBlockV1[] {
	return typeof content === "string" ? content : content.map(toWireUserContent);
}

function toWireUserMessage(msg: UserMessage): WireUserMessageV1 {
	return {
		role: "user",
		content: toWireUserContentList(msg.content),
		...(msg.synthetic !== undefined && { synthetic: msg.synthetic }),
		...(msg.attribution !== undefined && { attribution: toWireAttribution(msg.attribution) }),
		timestamp: msg.timestamp,
	};
}

function toWireAssistantMessage(msg: AssistantMessage): WireAssistantMessageV1 {
	return {
		role: "assistant",
		content: msg.content.map(toWireAssistantContent),
		api: msg.api,
		provider: msg.provider,
		model: msg.model,
		...(msg.responseId !== undefined && { responseId: msg.responseId }),
		usage: toWireUsage(msg.usage),
		stopReason: toWireStopReason(msg.stopReason),
		...(msg.errorMessage !== undefined && { errorMessage: msg.errorMessage }),
		timestamp: msg.timestamp,
		...(msg.duration !== undefined && { duration: msg.duration }),
		...(msg.ttft !== undefined && { ttft: msg.ttft }),
	};
}

function toWireToolResultMessage(msg: ToolResultMessage): WireToolResultMessageV1 {
	return {
		role: "toolResult",
		toolCallId: msg.toolCallId,
		toolName: msg.toolName,
		content: msg.content.map(toWireUserContent),
		...(msg.details !== undefined && { details: msg.details }),
		isError: msg.isError,
		...(msg.attribution !== undefined && { attribution: toWireAttribution(msg.attribution) }),
		...(msg.prunedAt !== undefined && { prunedAt: msg.prunedAt }),
		timestamp: msg.timestamp,
	};
}

function toWireBashExecutionMessage(msg: BashExecutionMessage): WireBashExecutionMessageV1 {
	return {
		role: "bashExecution",
		command: msg.command,
		output: msg.output,
		exitCode: msg.exitCode,
		cancelled: msg.cancelled,
		truncated: msg.truncated,
		timestamp: msg.timestamp,
		...(msg.excludeFromContext !== undefined && { excludeFromContext: msg.excludeFromContext }),
	};
}

function toWirePythonExecutionMessage(msg: PythonExecutionMessage): WirePythonExecutionMessageV1 {
	return {
		role: "pythonExecution",
		code: msg.code,
		output: msg.output,
		exitCode: msg.exitCode,
		cancelled: msg.cancelled,
		truncated: msg.truncated,
		timestamp: msg.timestamp,
		...(msg.excludeFromContext !== undefined && { excludeFromContext: msg.excludeFromContext }),
	};
}

function toWireCustomMessage(msg: CustomMessage): WireCustomMessageV1 {
	return {
		role: "custom",
		customType: msg.customType,
		content: toWireUserContentList(msg.content),
		display: msg.display,
		...(msg.details !== undefined && { details: msg.details }),
		...(msg.attribution !== undefined && { attribution: toWireAttribution(msg.attribution) }),
		timestamp: msg.timestamp,
	};
}

function toWireHookMessage(msg: HookMessage): WireHookMessageV1 {
	return {
		role: "hookMessage",
		customType: msg.customType,
		content: toWireUserContentList(msg.content),
		display: msg.display,
		...(msg.details !== undefined && { details: msg.details }),
		...(msg.attribution !== undefined && { attribution: toWireAttribution(msg.attribution) }),
		timestamp: msg.timestamp,
	};
}

function toWireMessage(msg: AgentMessage): WireMessageV1 {
	switch (msg.role) {
		case "user":
			return toWireUserMessage(msg);
		case "developer":
			return {
				role: "developer",
				content: toWireUserContentList(msg.content),
				...(msg.attribution !== undefined && { attribution: toWireAttribution(msg.attribution) }),
				timestamp: msg.timestamp,
			};
		case "assistant":
			return toWireAssistantMessage(msg);
		case "toolResult":
			return toWireToolResultMessage(msg);
		case "bashExecution":
			return toWireBashExecutionMessage(msg);
		case "pythonExecution":
			return toWirePythonExecutionMessage(msg);
		case "custom":
			return toWireCustomMessage(msg);
		case "hookMessage":
			return toWireHookMessage(msg);
		default: {
			// Fallback for any custom AgentMessage role added via declaration merging
			// that we haven't projected. Stringify the role as a best-effort to avoid
			// losing the message entirely; this should be rare since CustomAgentMessages
			// is currently bashExecution/pythonExecution/custom/hookMessage only.
			const fallback: WireCustomMessageV1 = {
				role: "custom",
				customType: (msg as { role: string }).role,
				content: JSON.stringify(msg),
				display: false,
				timestamp: (msg as { timestamp?: number }).timestamp ?? Date.now(),
			};
			return fallback;
		}
	}
}

function toWireToolResult(result: { content: (TextContent | ImageContent)[]; details?: unknown }): WireToolResultV1 {
	return {
		content: result.content.map(toWireUserContent),
		...(result.details !== undefined && { details: result.details }),
	};
}

function toWireAssistantMessageEvent(ev: AssistantMessageEvent): WireAssistantMessageEventV1 {
	switch (ev.type) {
		case "start":
			return { type: "start", partial: toWireAssistantMessage(ev.partial) };
		case "text_start":
			return { type: "text_start", contentIndex: ev.contentIndex, partial: toWireAssistantMessage(ev.partial) };
		case "text_delta":
			return {
				type: "text_delta",
				contentIndex: ev.contentIndex,
				delta: ev.delta,
				partial: toWireAssistantMessage(ev.partial),
			};
		case "text_end":
			return {
				type: "text_end",
				contentIndex: ev.contentIndex,
				content: ev.content,
				partial: toWireAssistantMessage(ev.partial),
			};
		case "thinking_start":
			return { type: "thinking_start", contentIndex: ev.contentIndex, partial: toWireAssistantMessage(ev.partial) };
		case "thinking_delta":
			return {
				type: "thinking_delta",
				contentIndex: ev.contentIndex,
				delta: ev.delta,
				partial: toWireAssistantMessage(ev.partial),
			};
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex: ev.contentIndex,
				content: ev.content,
				partial: toWireAssistantMessage(ev.partial),
			};
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex: ev.contentIndex, partial: toWireAssistantMessage(ev.partial) };
		case "toolcall_delta":
			return {
				type: "toolcall_delta",
				contentIndex: ev.contentIndex,
				delta: ev.delta,
				partial: toWireAssistantMessage(ev.partial),
			};
		case "toolcall_end":
			return {
				type: "toolcall_end",
				contentIndex: ev.contentIndex,
				toolCall: toWireToolCall(ev.toolCall),
				partial: toWireAssistantMessage(ev.partial),
			};
		case "done":
			return {
				type: "done",
				reason: ev.reason,
				message: toWireAssistantMessage(ev.message),
			};
		case "error":
			return {
				type: "error",
				reason: ev.reason,
				error: toWireAssistantMessage(ev.error),
			};
	}
}
