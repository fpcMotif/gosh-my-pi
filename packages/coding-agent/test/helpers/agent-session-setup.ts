import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	getBundledModel,
	type AssistantMessage,
	type Context,
	type Model,
	AuthStorage,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentSession, type AgentSessionEvent } from "../../src/session/agent-session";
import type { BranchSummaryCompleter } from "../../src/session/compaction";
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

const localBranchSummaryCompleter: BranchSummaryCompleter = async (model, _context, options) => {
	await Bun.sleep(200);
	if (options?.signal?.aborted === true) {
		return createAssistantMessage("", { model, stopReason: "aborted" });
	}
	return createAssistantMessage("Mock branch summary", { model });
};

export interface LocalAgentSessionHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	agent: Agent;
	model: Model;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
}

export async function createLocalAgentSessionHarness(
	options: {
		streamFn?: (model: Model, context: Context, options?: SimpleStreamOptions) => MockAssistantStream;
		systemPrompt?: string;
		sessionManager?: SessionManager;
		branchSummaryCompleter?: BranchSummaryCompleter;
	} = {},
): Promise<LocalAgentSessionHarness> {
	const tempDir = TempDir.createSync("@omp-test-");
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const dbPath = path.join(tempDir.path(), "agent.db");

	const model = getBundledModel("openai", "gpt-4o-mini");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "",
		},
		streamFn: options.streamFn ?? instantTextStreamFn("ok"),
	});

	const sessionManager = options.sessionManager ?? (await SessionManager.open(sessionFile));
	const settings = new Settings();
	const authStorage = await AuthStorage.create(dbPath);
	authStorage.setRuntimeApiKey(model.provider, "mock-key");
	const modelRegistry = new ModelRegistry(authStorage);

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		branchSummaryCompleter: options.branchSummaryCompleter ?? localBranchSummaryCompleter,
	});

	return {
		session,
		sessionManager,
		agent,
		model,
		tempDir,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			try {
				tempDir.removeSync();
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
