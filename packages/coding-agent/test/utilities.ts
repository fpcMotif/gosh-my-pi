import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	createAssistantMessage,
	createLocalAgentSessionHarness,
	type LocalAgentSessionHarness,
} from "./helpers/agent-session-setup";

export type TestSessionContext = LocalAgentSessionHarness & {
	sessionManager: LocalAgentSessionHarness["sessionManager"];
};

export async function createTestSession(
	options: {
		systemPrompt?: string;
		settingsOverrides?: Record<string, unknown>;
	} = {},
): Promise<TestSessionContext> {
	const harness = await createLocalAgentSessionHarness({
		systemPrompt: options.systemPrompt,
	});

	// Apply settings overrides if any
	if (options.settingsOverrides) {
		const flatten = (obj: Record<string, unknown>, prefix = "") => {
			for (const [key, value] of Object.entries(obj)) {
				const path = prefix ? `${prefix}.${key}` : key;
				if (value !== null && typeof value === "object" && !Array.isArray(value)) {
					flatten(value as Record<string, unknown>, path);
				} else {
					harness.session.settings.set(path as never, value as never);
				}
			}
		};
		flatten(options.settingsOverrides);
	}

	return {
		...harness,
		sessionManager: harness.session.sessionManager,
	};
}

export function e2eApiKey(name: string): string | undefined {
	// For testing purposes, we can return a mock key if it's an OpenAI key
	// or whatever is available in the environment.
	if (name === "ANTHROPIC_API_KEY") {
		// Since we pruned Anthropic, we might want to return something or nothing
		return process.env.OPENAI_API_KEY || "mock-key";
	}
	return process.env[name];
}

export function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantMsg(text: string): AgentMessage {
	return createAssistantMessage(text);
}
