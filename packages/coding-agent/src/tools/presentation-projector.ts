import type { AgentSessionEvent } from "../session/agent-session";
import type { ToolPresentationResult } from "./presentation-types";
import type { ToolPresenter } from "./presenters";

type ToolExecutionEvent = Extract<
	AgentSessionEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

export type ToolPresentationProjector = (event: ToolExecutionEvent) => ToolPresentationResult;

export interface ToolPresentationFailure {
	toolName: string;
	method: "presentCall" | "presentResult";
	error: string;
}

const MAX_DIAGNOSTIC_LENGTH = 500;

export function createToolPresentationProjector(
	presenters: Readonly<Record<string, ToolPresenter>>,
	reportFailure: (failure: ToolPresentationFailure) => void = () => {},
): ToolPresentationProjector {
	const argsByToolCallId = new Map<string, Record<string, unknown>>();

	return event => {
		const presenter = presenters[event.toolName];
		if (event.type === "tool_execution_start") {
			argsByToolCallId.set(event.toolCallId, event.args);
			if (!presenter?.presentCall) return undefined;
			try {
				return presenter.presentCall(event.args, { expanded: false, isPartial: true });
			} catch (error) {
				reportPresenterFailure(reportFailure, event.toolName, "presentCall", error);
				return undefined;
			}
		}

		if (event.type === "tool_execution_update") {
			argsByToolCallId.set(event.toolCallId, event.args);
			if (!presenter?.presentResult) return undefined;
			try {
				return presenter.presentResult(event.partialResult, { expanded: false, isPartial: true }, event.args);
			} catch (error) {
				reportPresenterFailure(reportFailure, event.toolName, "presentResult", error);
				return undefined;
			}
		}

		const args = argsByToolCallId.get(event.toolCallId);
		try {
			if (!presenter?.presentResult) return undefined;
			return presenter.presentResult(event.result, { expanded: false, isPartial: false }, args);
		} catch (error) {
			reportPresenterFailure(reportFailure, event.toolName, "presentResult", error);
			return undefined;
		} finally {
			argsByToolCallId.delete(event.toolCallId);
		}
	};
}

function reportPresenterFailure(
	reportFailure: (failure: ToolPresentationFailure) => void,
	toolName: string,
	method: "presentCall" | "presentResult",
	error: unknown,
): void {
	try {
		reportFailure({
			toolName,
			method,
			error: String(error).slice(0, MAX_DIAGNOSTIC_LENGTH),
		});
	} catch {
		// Presentation diagnostics must never break the parent tool event.
	}
}
