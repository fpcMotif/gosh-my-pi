import { LocalAbort } from "@oh-my-pi/pi-ai/errors";
import { Http, HttpError, LiveHttp, makeHttpLayer, type HttpStreamOpts } from "@oh-my-pi/pi-ai/layers/http";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { callWithCopilotModelRetry } from "@oh-my-pi/pi-ai/utils/retry";
import { Cause, Effect, Exit, Option } from "@oh-my-pi/pi-utils/effect";

interface Metrics {
	contractsPassed: number;
	contractsFailed: number;
	codexFetchAttempts: number;
	legacyAiRetryMarkers: number;
	effectAiMarkers: number;
	effectfulAiScore: number;
}

const metrics: Metrics = {
	contractsPassed: 0,
	contractsFailed: 0,
	codexFetchAttempts: 0,
	legacyAiRetryMarkers: 0,
	effectAiMarkers: 0,
	effectfulAiScore: 0,
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

function expectErrorFailure(exit: Exit.Exit<unknown, unknown>): unknown {
	assert(Exit.isFailure(exit), "expected failure exit");
	const failure = Cause.failureOption(exit.cause);
	assert(Option.isSome(failure), "expected error failure cause");
	return Option.getOrThrow(failure);
}

function expectLocalAbortFailure(exit: Exit.Exit<unknown, unknown>): LocalAbort {
	const error = expectErrorFailure(exit);
	assert(error instanceof LocalAbort, `expected LocalAbort, got ${String(error)}`);
	return error;
}

function expectHttpFailure(exit: Exit.Exit<unknown, unknown>): HttpError {
	const error = expectErrorFailure(exit);
	assert(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
	return error;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

async function* yieldNumbers(values: readonly number[]): AsyncGenerator<number> {
	for (const value of values) yield value;
}

function pendingIterable<T>(): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: () => Promise.withResolvers<IteratorResult<T>>().promise,
			};
		},
	};
}

function openStream<T>(opts: HttpStreamOpts<T>): Promise<Exit.Exit<AsyncIterable<T>, unknown>> {
	return Effect.runPromiseExit(
		Effect.gen(function* () {
			const http = yield* Http;
			return yield* http.requestStream<T>(opts);
		}).pipe(Effect.provide(LiveHttp)),
	);
}

function requestWith(
	fetchFn: typeof fetch,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Exit.Exit<Response, HttpError>> {
	return Effect.runPromiseExit(
		Effect.gen(function* () {
			const http = yield* Http;
			return yield* http.request(input, init);
		}).pipe(Effect.provide(makeHttpLayer(fetchFn))),
	);
}

async function runHttpLayerContracts(): Promise<void> {
	await contract("Http.request preserves explicit caller signal", async () => {
		const externalController = new AbortController();
		let observedSignal: AbortSignal | null | undefined;
		const fetchFn = Object.assign(
			(_input: string | URL | Request, init?: RequestInit) => {
				observedSignal = init?.signal;
				return Promise.resolve(new Response("ok", { status: 201 }));
			},
			{ preconnect: fetch.preconnect },
		);

		const exit = await requestWith(fetchFn, "https://example.test/models", { signal: externalController.signal });
		assert(Exit.isSuccess(exit), "expected request success");
		assert(exit.value.status === 201, `expected status 201, got ${exit.value.status}`);
		assert(observedSignal === externalController.signal, "request did not preserve caller signal");
	});

	await contract("Http.request maps fetch rejection into typed HttpError", async () => {
		const cause = new Error("network down");
		const fetchFn = Object.assign(() => Promise.reject(cause), { preconnect: fetch.preconnect });
		const exit = await requestWith(fetchFn, "https://example.test/fail");
		const err = expectHttpFailure(exit);
		assert(err.cause === cause, "HttpError cause was not preserved");
		assert(err.url === "https://example.test/fail", `unexpected HttpError url ${err.url}`);
	});

	await contract("Http.requestStream opens and yields the body iterable", async () => {
		const exit = await openStream<number>({
			label: "ok stream",
			body: () => Promise.resolve(yieldNumbers([1, 2, 3])),
		});
		assert(Exit.isSuccess(exit), "expected stream open success");
		const values = await collect(exit.value);
		assert(JSON.stringify(values) === JSON.stringify([1, 2, 3]), `unexpected stream values ${JSON.stringify(values)}`);
	});

	await contract("Http.requestStream first-event watchdog aborts stalled bodies", async () => {
		let capturedSignal: AbortSignal | undefined;
		const exit = await openStream<number>({
			label: "opened stream",
			firstEventWatchdog: { kind: "timeout", timeoutMs: 10 },
			body: signal => {
				capturedSignal = signal;
				return Promise.resolve(pendingIterable<number>());
			},
		});
		assert(Exit.isSuccess(exit), "expected stream open before first-item watchdog");
		let thrown: unknown;
		try {
			await collect(exit.value);
		} catch (error) {
			thrown = error;
		}
		assert(thrown instanceof LocalAbort, `expected LocalAbort, got ${String(thrown)}`);
		assert(thrown.kind === "timeout", `expected timeout abort, got ${thrown.kind}`);
		assert(capturedSignal?.aborted === true, "body signal was not aborted by watchdog");
	});

	await contract("Http.requestStream open watchdog fails with typed LocalAbort", async () => {
		const { promise } = Promise.withResolvers<AsyncIterable<number>>();
		const exit = await openStream<number>({
			label: "stuck stream",
			firstEventWatchdog: { kind: "stall", timeoutMs: 10 },
			body: () => promise,
		});
		const err = expectLocalAbortFailure(exit);
		assert(err.kind === "stall", `expected stall abort, got ${err.kind}`);
		assert(err.durationMs === 10, `expected 10ms abort, got ${err.durationMs}`);
	});
}

async function runCopilotRetryContracts(): Promise<void> {
	await contract("Copilot transient model errors retry through Effect policy", async () => {
		let attempts = 0;
		const value = await callWithCopilotModelRetry(
			async () => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("model_not_supported");
					(error as { status?: number; code?: string }).status = 400;
					(error as { status?: number; code?: string }).code = "model_not_supported";
					throw error;
				}
				return "ok";
			},
			{ provider: "github-copilot" },
		);
		assert(value === "ok", `unexpected retry result ${value}`);
		assert(attempts === 3, `expected 3 attempts, got ${attempts}`);
	});

	await contract("Non-Copilot providers do not use Copilot retry policy", async () => {
		let attempts = 0;
		const expected = new Error("do not retry");
		let caught: unknown;
		try {
			await callWithCopilotModelRetry(
				async () => {
					attempts += 1;
					throw expected;
				},
				{ provider: "openai" },
			);
		} catch (error) {
			caught = error;
		}
		assert(caught === expected, "non-Copilot error was not surfaced unchanged");
		assert(attempts === 1, `expected 1 attempt, got ${attempts}`);
	});
}

function codexToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }), "utf8").toBase64();
	return `aaa.${payload}.bbb`;
}

function makeCodexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a deterministic benchmark assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
	};
}

function sseFrame(value: Record<string, unknown>): string {
	return `data: ${JSON.stringify(value)}`;
}

function makeSuccessSse(text: string): string {
	return `${[
		sseFrame({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] },
		}),
		sseFrame({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
		sseFrame({ type: "response.output_text.delta", delta: text }),
		sseFrame({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_retry",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		}),
		sseFrame({
			type: "response.completed",
			response: {
				id: "resp_retry",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		}),
	].join("\n\n")}\n\n`;
}

function makeTransientErrorSse(): string {
	return `${[
		sseFrame({
			type: "error",
			code: "model_error",
			message: "An error occurred while processing your request. You can retry your request.",
		}),
	].join("\n\n")}\n\n`;
}

function textFromMessage(message: AssistantMessage): string | undefined {
	const textBlock = message.content.find(block => block.type === "text");
	return textBlock?.type === "text" ? textBlock.text : undefined;
}

async function runCodexRetryContracts(): Promise<void> {
	await contract("Codex SSE retries status and provider transient failures without live network", async () => {
		const originalFetch = globalThis.fetch;
		let requestCount = 0;
		const successSse = makeSuccessSse("Hello after retry");
		const errorSse = makeTransientErrorSse();
		const fetchMock = Object.assign(
			(input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url !== "https://chatgpt.com/backend-api/codex/responses") {
					throw new Error(`unexpected network call: ${url}`);
				}
				requestCount += 1;
				metrics.codexFetchAttempts = requestCount;
				if (requestCount === 1) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "temporary" } }), {
							status: 429,
							headers: { "content-type": "application/json", "retry-after": "0" },
						}),
					);
				}
				return Promise.resolve(
					new Response(requestCount === 2 ? errorSse : successSse, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				);
			},
			{ preconnect: originalFetch.preconnect },
		);

		globalThis.fetch = fetchMock as typeof fetch;
		try {
			const result = await streamOpenAICodexResponses(makeCodexModel(), makeContext(), {
				apiKey: codexToken(),
			}).result();
			assert(requestCount === 3, `expected 3 fetch attempts, got ${requestCount}`);
			assert(result.stopReason === "stop", `expected stop result, got ${result.stopReason}`);
			assert(textFromMessage(result) === "Hello after retry", `unexpected final text ${textFromMessage(result)}`);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}

async function countPattern(path: string, pattern: RegExp): Promise<number> {
	const text = await Bun.file(path).text();
	return text.match(pattern)?.length ?? 0;
}

async function collectStaticMetrics(): Promise<void> {
	const targetFiles = [
		"packages/ai/src/providers/openai-codex-responses.ts",
		"packages/ai/src/providers/openai-completions.ts",
		"packages/ai/src/providers/openai-responses.ts",
		"packages/ai/src/providers/openai-codex/websocket.ts",
		"packages/ai/src/layers/http.ts",
		"packages/ai/src/utils/retry.ts",
		"packages/ai/src/utils/abort-effect.ts",
		"packages/ai/src/effect-utils.ts",
	] as const;
	const legacyPatterns = [
		/\bwhile\s*\(\s*true\s*\)/g,
		/\babortableSleep\s*\(/g,
		/\bfetchWithRetry\b/g,
		/\bmaxRetries\s*:/g,
		/\bsetTimeout\s*\(/g,
	] as const;
	const effectPatterns = [/\bEffect\./g, /\bSchedule\./g, /\bLayer\./g, /\bContext\.Tag\b/g] as const;

	let legacyCount = 0;
	let effectCount = 0;
	for (const path of targetFiles) {
		for (const pattern of legacyPatterns) legacyCount += await countPattern(path, pattern);
		for (const pattern of effectPatterns) effectCount += await countPattern(path, pattern);
	}
	metrics.legacyAiRetryMarkers = legacyCount;
	metrics.effectAiMarkers = effectCount;
	metrics.effectfulAiScore = metrics.contractsPassed * 100 - metrics.contractsFailed * 50 - metrics.legacyAiRetryMarkers;
}

function emitMetrics(): void {
	process.stdout.write(`METRIC effectful_ai_score=${metrics.effectfulAiScore}\n`);
	process.stdout.write(`METRIC legacy_ai_retry_markers=${metrics.legacyAiRetryMarkers}\n`);
	process.stdout.write(`METRIC ai_retry_contracts=${metrics.contractsPassed}\n`);
	process.stdout.write(`METRIC ai_retry_contract_failures=${metrics.contractsFailed}\n`);
	process.stdout.write(`METRIC codex_retry_fetch_attempts=${metrics.codexFetchAttempts}\n`);
	process.stdout.write(`METRIC effect_ai_markers=${metrics.effectAiMarkers}\n`);
}

await runHttpLayerContracts();
await runCopilotRetryContracts();
await runCodexRetryContracts();
await collectStaticMetrics();
emitMetrics();
