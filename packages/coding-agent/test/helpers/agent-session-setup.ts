import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type AssistantMessage, type Model, AuthStorage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";

export class MockAssistantStream extends AssistantMessageEventStream {}

export function createAssistantMessage(
	text: string,
	options: { model?: Model; stopReason?: AssistantMessage["stopReason"] } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: options.model?.provider ?? "openai",
		model: options.model?.id ?? "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

export function instantTextStreamFn(text: string, options: { stopReason?: AssistantMessage["stopReason"] } = {}) {
	return (model: Model) => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const message = createAssistantMessage(text, { model, stopReason: options.stopReason });
			stream.push({ type: "done", reason: options.stopReason ?? "stop", message });
		});
		return stream;
	};
}

export interface LocalAgentSessionHarness {
	session: AgentSession;
	agent: Agent;
	model: Model;
	tempDir: string;
	cleanup: () => Promise<void>;
}

export async function createLocalAgentSessionHarness(
	options: {
		streamFn?: (model: Model) => MockAssistantStream;
		systemPrompt?: string;
	} = {},
): Promise<LocalAgentSessionHarness> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-"));
	const sessionFile = path.join(tempDir, "session.jsonl");
	const dbPath = path.join(tempDir, "agent.db");

	const model = getBundledModel("openai", "gpt-4o-mini");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "",
		},
		streamFn: options.streamFn ?? instantTextStreamFn("ok"),
	});

	const sessionManager = await SessionManager.open(sessionFile);
	const settings = new Settings();
	const authStorage = await AuthStorage.create(dbPath);
	authStorage.setRuntimeApiKey(model.provider, "mock-key");
	const modelRegistry = new ModelRegistry(authStorage);

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});

	return {
		session,
		agent,
		model,
		tempDir,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

export function trackSessionEvents(session: AgentSession) {
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe(event => {
		events.push(event);
	});
	return {
		events,
		unsubscribe,
	};
}
