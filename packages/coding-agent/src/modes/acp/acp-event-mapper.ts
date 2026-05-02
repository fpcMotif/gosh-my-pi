import type { SessionNotification, SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { TodoStatus } from "../../tools/todo-write";
import {
	type CommandContainer,
	extractStringProperty,
	extractToolCallContent,
	extractToolLocations,
	isAssistantMessage,
	isNonEmptyString,
	type PathContainer,
	type PatternContainer,
	type QueryContainer,
} from "./acp-content-helpers";

interface AcpEventMapperOptions {
	getMessageId?: (message: unknown) => string | undefined;
}

const TOOL_KIND_MAP: Record<string, ToolKind> = {
	read: "read",
	write: "edit",
	edit: "edit",
	delete: "delete",
	move: "move",
	bash: "execute",
	python: "execute",
	search: "search",
	find: "search",
	ast_grep: "search",
	web_search: "fetch",
	todo_write: "think",
};

export function mapToolKind(toolName: string): ToolKind {
	return TOOL_KIND_MAP[toolName] ?? "other";
}

export function mapAgentSessionEventToAcpSessionUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	switch (event.type) {
		case "message_update":
			return mapAssistantMessageUpdate(event, sessionId, options);
		case "tool_execution_start": {
			const update: SessionUpdate = {
				sessionUpdate: "tool_call",
				toolCallId: event.toolCallId,
				title: buildToolTitle(event.toolName, event.args, event.intent),
				kind: mapToolKind(event.toolName),
				status: "pending",
				rawInput: event.args,
			};
			const locations = extractToolLocations(event.args);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			const content = extractToolCallContent(event.partialResult);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			if (content.length > 0) {
				update.content = content;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const content = extractToolCallContent(event.result);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError === true ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (content.length > 0) {
				update.content = content;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "todo_reminder": {
			const entries = event.todos.map(todo => ({
				content: todo.content,
				priority: "medium" as const,
				status: mapTodoStatus(todo.status),
			}));
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries })];
		}
		case "todo_auto_clear":
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries: [] })];
		default:
			return [];
	}
}

function mapAssistantMessageUpdate(
	event: Extract<AgentSessionEvent, { type: "message_update" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}

	let sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
	let text: string;
	switch (event.assistantMessageEvent.type) {
		case "text_delta":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.delta;
			break;
		case "thinking_delta":
			sessionUpdate = "agent_thought_chunk";
			text = event.assistantMessageEvent.delta;
			break;
		case "error":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.error.errorMessage ?? "Unknown error";
			break;
		default:
			return [];
	}
	if (text.length === 0) {
		return [];
	}

	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate,
			content: { type: "text", text },
			messageId,
		}),
	];
}

function toSessionNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

const todoStatusMap: Record<TodoStatus, "pending" | "in_progress" | "completed"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	abandoned: "completed",
};

function mapTodoStatus(status: TodoStatus): "pending" | "in_progress" | "completed" {
	return todoStatusMap[status];
}

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	const trimmedIntent = intent?.trim();
	if (isNonEmptyString(trimmedIntent)) {
		return trimmedIntent;
	}

	const subject =
		extractStringProperty<PathContainer>(args, "path") ??
		extractStringProperty<CommandContainer>(args, "command") ??
		extractStringProperty<PatternContainer>(args, "pattern") ??
		extractStringProperty<QueryContainer>(args, "query");
	if (isNonEmptyString(subject)) {
		return `${toolName}: ${subject}`;
	}

	return toolName;
}
