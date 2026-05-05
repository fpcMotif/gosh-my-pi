import type { Message } from "../types";

/**
 * Infer the initiator of a Copilot request based on message attribution.
 * Returns "agent" if the last non-assistant message was initiated by the agent,
 * otherwise "user".
 */
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") continue;
		if (msg.attribution === "agent") return "agent";
		if (msg.attribution === "user") return "user";
	}
	return "user";
}
