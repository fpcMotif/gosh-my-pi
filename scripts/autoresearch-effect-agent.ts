// Autoresearch metrics for the agent-runtime Effectify pass.
//
// Adapted from `scripts/autoresearch-effect-ai.ts`. Counts legacy control-flow
// markers across the in-scope files (every .ts under `packages/agent/src/`
// plus the four session-bridge files) and runs a small set of behavior
// contracts to confirm the loop / stream-pump refactor still terminates
// cleanly on the happy path and propagates iterator throws as a terminal
// error frame instead of an unhandled rejection.
//
// METRIC lines on stdout:
//   METRIC effect_agent_score=<n>
//   METRIC legacy_agent_markers=<n>
//   METRIC effect_agent_markers=<n>
//   METRIC agent_runtime_contracts=<n>
//   METRIC agent_runtime_contract_failures=<n>
//   METRIC effect_agent_baseline=<n>

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
} from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

interface Metrics {
	contractsPassed: number;
	contractsFailed: number;
	legacyAgentMarkers: number;
	effectAgentMarkers: number;
	effectAgentBaseline: number;
	effectAgentScore: number;
}

// Pre-Effectify counts captured against commit 7e4de39ac
// (`refactor: extract post-prompt recovery scheduler module`):
//   - 4 legacy markers across packages/agent/src — two unbounded-true
//     loops (one in agent-loop.ts, one in agent-loop/streaming.ts) and
//     two optional-chain abort polls inside the same stream pump
//   - 0 legacy markers across the four session-bridge files
//   - 15 Effect-marker occurrences across packages/agent/src (run/*, errors.ts)
//
// Score formula extends autoresearch-effect-ai.ts to also reward Effect-marker
// uplift across the in-scope files. The legacy-marker-only term that the AI
// script uses captures elimination but not adoption; for a smaller refactor
// like this pass, the elimination delta alone (4 markers) is too narrow a
// signal to distinguish a no-op rename from a real Effect-idiomatic rewrite,
// so we add the Effect-marker delta term:
//
//   score = contracts_passed * 100
//         - contracts_failed * 50
//         - legacy_markers
//         + (effect_markers - effect_marker_baseline)
//
// Baseline encoding: same 2 happy-path contracts pass against the pre-refactor
// surface (the public `agentLoop` / `agentLoopContinue` signatures and
// observable event sequence are preserved across the refactor), so the
// pre-refactor score is `2*100 - 0 - 4 + 0 = 196`.
const BASELINE_LEGACY_MARKERS = 4;
const BASELINE_EFFECT_MARKERS = 15;
const BASELINE_CONTRACTS_PASSED = 2;
const BASELINE_CONTRACTS_FAILED = 0;
const EFFECT_AGENT_BASELINE =
	BASELINE_CONTRACTS_PASSED * 100 - BASELINE_CONTRACTS_FAILED * 50 - BASELINE_LEGACY_MARKERS;

const metrics: Metrics = {
	contractsPassed: 0,
	contractsFailed: 0,
	legacyAgentMarkers: 0,
	effectAgentMarkers: 0,
	effectAgentBaseline: EFFECT_AGENT_BASELINE,
	effectAgentScore: 0,
};

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function contract(name: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		metrics.contractsPassed += 1;
	} catch (error) {
		metrics.contractsFailed += 1;
		const suffix = error instanceof Error ? error.message : String(error);
		process.stderr.write(`CONTRACT_FAILED ${name}: ${suffix}\n`);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function identityConvert(messages: AgentMessage[]): Message[] {
	return messages.filter(
		m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function collectEvents(
	stream: ReturnType<typeof agentLoop>,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const events: AgentEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	const messages = await stream.result();
	return { events, messages };
}

async function happyPathContract(): Promise<void> {
	await contract(
		"agentLoop emits agent_start..agent_end with assistant message_end on the happy path",
		async () => {
			const context: AgentContext = {
				systemPrompt: "You are deterministic.",
				messages: [],
				tools: [],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConvert,
			};
			const userMessage: AgentMessage = {
				role: "user",
				content: "ping",
				timestamp: 0,
			};

			const streamFn = (): AssistantMessageEventStream => {
				const out = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("pong");
					out.push({ type: "done", reason: "stop", message });
				});
				return out;
			};

			const stream = agentLoop([userMessage], context, config, undefined, streamFn);
			const { events, messages } = await collectEvents(stream);
			const types = events.map(e => e.type);
			assert(types.includes("agent_start"), "missing agent_start");
			assert(types.includes("turn_start"), "missing turn_start");
			assert(types.includes("message_end"), "missing message_end");
			assert(types.includes("turn_end"), "missing turn_end");
			assert(types.includes("agent_end"), "missing agent_end");
			assert(messages.length === 2, `expected 2 messages, got ${messages.length}`);
			assert(messages[1].role === "assistant", "second message should be assistant");
		},
	);
}

async function iteratorThrowContract(): Promise<void> {
	await contract(
		"agentLoop folds a mid-stream iterator throw into a terminal error frame",
		async () => {
			const context: AgentContext = {
				systemPrompt: "You are deterministic.",
				messages: [],
				tools: [],
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConvert,
			};
			const userMessage: AgentMessage = {
				role: "user",
				content: "ping",
				timestamp: 0,
			};

			const streamFn = (): AsyncIterable<AssistantMessageEvent> => ({
				[Symbol.asyncIterator]() {
					let firstCall = true;
					return {
						next(): Promise<IteratorResult<AssistantMessageEvent>> {
							if (firstCall) {
								firstCall = false;
								return Promise.resolve({
									done: false,
									value: { type: "start", partial: createAssistantMessage("") },
								});
							}
							return Promise.reject(new Error("simulated network failure"));
						},
					};
				},
			});

			const stream = agentLoop(
				[userMessage],
				context,
				config,
				undefined,
				streamFn as unknown as AgentLoopConfig["streamFn"],
			);
			const { events, messages } = await collectEvents(stream);
			const terminal = messages.findLast(m => m.role === "assistant");
			assert(terminal !== undefined, "expected at least one assistant message");
			assert(
				terminal.role === "assistant" && terminal.stopReason === "error",
				`expected terminal stopReason "error", got ${terminal.role === "assistant" ? terminal.stopReason : "non-assistant"}`,
			);
			assert(
				terminal.role === "assistant" &&
					typeof terminal.errorMessage === "string" &&
					terminal.errorMessage.includes("Provider stream failed"),
				"errorMessage should mention 'Provider stream failed'",
			);
			const endTypes = events.map(e => e.type);
			assert(endTypes.includes("agent_end"), "missing agent_end after iterator throw");
		},
	);
}

async function countPattern(filePath: string, pattern: RegExp): Promise<number> {
	const text = await fs.readFile(filePath, "utf8");
	return text.match(pattern)?.length ?? 0;
}

async function walkTs(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async entry => {
			const full = path.join(root, entry.name);
			if (entry.isDirectory()) return walkTs(full);
			if (entry.isFile() && entry.name.endsWith(".ts")) return [full];
			return [];
		}),
	);
	return nested.flat();
}

async function collectStaticMetrics(): Promise<void> {
	const agentSrc = await walkTs("packages/agent/src");
	const sessionFiles = [
		"packages/coding-agent/src/session/agent-session.ts",
		"packages/coding-agent/src/session/agent-event-router.ts",
		"packages/coding-agent/src/session/run-bridge.ts",
		"packages/coding-agent/src/session/recovery-driver.ts",
	];
	const targetFiles = [...agentSrc, ...sessionFiles];

	const legacyPatterns = [
		/\bwhile\s*\(\s*true\s*\)/g,
		/\bsetTimeout\s*\(/g,
		/\bnew Promise\(\s*\(/g,
		/signal\?\.aborted/g,
		/\bmaxRetries\s*:/g,
	] as const;
	const effectPatterns = [/\bEffect\./g, /\bSchedule\./g, /\bLayer\./g, /\bFiber\./g, /\bContext\.Tag\b/g] as const;

	const perFile = await Promise.all(
		targetFiles.map(async file => {
			const legacyCounts = await Promise.all(legacyPatterns.map(p => countPattern(file, p)));
			const effectCounts = await Promise.all(effectPatterns.map(p => countPattern(file, p)));
			return {
				legacy: legacyCounts.reduce((a, b) => a + b, 0),
				effect: effectCounts.reduce((a, b) => a + b, 0),
			};
		}),
	);
	const legacy = perFile.reduce((acc, e) => acc + e.legacy, 0);
	const effect = perFile.reduce((acc, e) => acc + e.effect, 0);
	metrics.legacyAgentMarkers = legacy;
	metrics.effectAgentMarkers = effect;
	metrics.effectAgentScore =
		metrics.contractsPassed * 100 -
		metrics.contractsFailed * 50 -
		metrics.legacyAgentMarkers +
		(metrics.effectAgentMarkers - BASELINE_EFFECT_MARKERS);
}

function emitMetrics(): void {
	process.stdout.write(`METRIC effect_agent_score=${metrics.effectAgentScore}\n`);
	process.stdout.write(`METRIC legacy_agent_markers=${metrics.legacyAgentMarkers}\n`);
	process.stdout.write(`METRIC effect_agent_markers=${metrics.effectAgentMarkers}\n`);
	process.stdout.write(`METRIC agent_runtime_contracts=${metrics.contractsPassed}\n`);
	process.stdout.write(`METRIC agent_runtime_contract_failures=${metrics.contractsFailed}\n`);
	process.stdout.write(`METRIC effect_agent_baseline=${metrics.effectAgentBaseline}\n`);
}

await happyPathContract();
await iteratorThrowContract();
await collectStaticMetrics();
emitMetrics();
