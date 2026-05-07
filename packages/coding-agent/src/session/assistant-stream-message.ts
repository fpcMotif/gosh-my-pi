import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";

/**
 * Pick the AssistantMessage carried by an AssistantMessageEvent variant.
 *
 * The runtime invokes the interceptor with a single discriminated-union
 * argument; each variant stores its message under a different field. Pre
 * b83fca9, agent-session.ts declared the interceptor with a stale
 * (message, event) signature that left `assistantMessageEvent` undefined,
 * so streaming partials and error events fed garbage into the
 * streaming-edit guard.
 *
 * Exported for direct unit testing — keep the branches in sync with the
 * AssistantMessageEvent union in @oh-my-pi/pi-ai.
 */
export function deriveAssistantStreamMessage(evt: AssistantMessageEvent): AssistantMessage {
	if (evt.type === "done") return evt.message;
	if (evt.type === "error") return evt.error;
	return evt.partial;
}
