// Effectful Codex WebSocket transport.
//
// Public surface is a thin async class (CodexWebSocketConnection) because
// callers from openai-codex-responses.ts iterate it with `for await`, but the
// internals are pure Effect:
//   - The TCP handshake race against a connect-timeout uses Effect.timeoutFail.
//   - The waiter loop inside #nextMessage uses Effect.race between an
//     Effect.async waiter and Effect.sleep(timeoutMs), so no `setTimeout`
//     handles leak across abort paths.
//   - Caller-supplied AbortSignals are bridged through effectFromSignal so
//     interruption tears down the fiber and any in-flight watchdogs.

import { logger } from "@oh-my-pi/pi-utils";
import { Duration, Effect, effectFromSignal } from "@oh-my-pi/pi-utils/effect";
import type { RequestBody } from "./request-transformer";

export type CodexTransport = "sse" | "websocket";

export type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	canAppend: boolean;
	turnState?: string;
	modelsEtag?: string;
	reasoningIncluded?: boolean;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
};

export const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";

export function createCodexWebSocketTransportError(message: string): Error {
	return new Error(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${message}`);
}

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export interface CodexWebSocketConnectionOptions {
	idleTimeoutMs: number;
	firstEventTimeoutMs: number;
	onHandshakeHeaders?: (headers: Headers) => void;
}

type CodexWebSocketMessage = Record<string, unknown>;
type CodexWebSocketQueueItem = CodexWebSocketMessage | Error | null;

type WebSocketCtorWithHeaders = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket;

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.completed",
	"response.done",
	"response.incomplete",
	"response.failed",
	"error",
]);

export class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#idleTimeoutMs: number;
	#firstEventTimeoutMs: number;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: WebSocket | null = null;
	#queue: Array<CodexWebSocketQueueItem> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#idleTimeoutMs = options.idleTimeoutMs;
		this.#firstEventTimeoutMs = options.firstEventTimeoutMs;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		const socket = this.#socket;
		if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
			socket.close(1000, reason);
		}
		this.#socket = null;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise !== undefined) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		logger.time("codexWs:awaitTcpHandshake");
		const connectTimeout = Effect.sleep(Duration.millis(CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS)).pipe(
			Effect.flatMap(() => {
				this.close("connect-timeout");
				return Effect.fail(createCodexWebSocketTransportError("connection timeout"));
			}),
		);
		const handshake = Effect.raceFirst(this.#openSocketEffect(), connectTimeout);
		const program = signal === undefined ? handshake : effectFromSignal(signal, handshake);
		const settled = Effect.runPromise(program).catch((error: unknown) => {
			throw this.#asTransportError(error);
		});
		this.#connectPromise = settled.finally(() => {
			this.#connectPromise = undefined;
		});
		await this.#connectPromise;
	}

	async *streamRequest(
		request: Record<string, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<Record<string, unknown>> {
		if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) {
			throw createCodexWebSocketTransportError("websocket connection is unavailable");
		}
		if (this.#activeRequest) {
			throw createCodexWebSocketTransportError("websocket request already in progress");
		}
		this.#activeRequest = true;

		const onAbort = (): void => {
			this.close("aborted");
			this.#push(createCodexWebSocketTransportError("request was aborted"));
		};

		if (signal !== undefined) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		try {
			this.#socket.send(JSON.stringify(request));
			yield* this.#streamUntilTerminal(false);
		} finally {
			this.#activeRequest = false;
			if (signal !== undefined) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	async *#streamUntilTerminal(sawFirstEvent: boolean): AsyncGenerator<Record<string, unknown>> {
		const next = await this.#nextMessage(
			sawFirstEvent ? this.#idleTimeoutMs : this.#firstEventTimeoutMs,
			sawFirstEvent ? "idle timeout waiting for websocket" : "timeout waiting for first websocket event",
		);
		if (next instanceof Error) throw next;
		if (next === null) {
			throw createCodexWebSocketTransportError("websocket closed before response completion");
		}
		yield next;
		const eventType = typeof next.type === "string" ? next.type : "";
		if (TERMINAL_EVENT_TYPES.has(eventType)) return;
		yield* this.#streamUntilTerminal(true);
	}

	#openSocketEffect(): Effect.Effect<void, Error> {
		return Effect.suspend(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const WebSocketWithHeaders = WebSocket as unknown as WebSocketCtorWithHeaders;
			const socket = new WebSocketWithHeaders(this.#url, { headers: this.#headers });
			this.#socket = socket;
			let settled = false;
			const settleSuccess = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const settleFailure = (err: Error): void => {
				if (settled) return;
				settled = true;
				reject(err);
			};
			const cleanup = (): void => {
				if (settled) return;
				socket.close(1000, "aborted");
				settled = true;
			};

			// WebSocket lifecycle is exposed only as DOM events; Effect owns the
			// handshake, timeout, and abort race around this listener boundary.
			socket.addEventListener("open", event => {
				this.#captureHandshakeHeaders(socket, event);
				settleSuccess();
			});
			socket.addEventListener("error", event => {
				const eventRecord = event as unknown as Record<string, unknown>;
				const detail =
					(typeof eventRecord.message === "string" && eventRecord.message.length > 0
						? eventRecord.message
						: undefined) ||
					(eventRecord.error instanceof Error && eventRecord.error.message.length > 0
						? eventRecord.error.message
						: undefined) ||
					String(event.type);
				const transportError = createCodexWebSocketTransportError(`websocket error: ${detail}`);
				if (settled) {
					this.#push(transportError);
					return;
				}
				settleFailure(transportError);
			});
			socket.addEventListener("close", event => {
				this.#socket = null;
				if (!settled) {
					settleFailure(createCodexWebSocketTransportError(`websocket closed before open (${event.code})`));
					return;
				}
				this.#push(createCodexWebSocketTransportError(`websocket closed (${event.code})`));
				this.#push(null);
			});
			socket.addEventListener("message", event => this.#dispatchMessage(event));

			return Effect.tryPromise({
				try: () => promise,
				catch: err => this.#asTransportError(err),
			}).pipe(Effect.onInterrupt(() => Effect.sync(cleanup)));
		});
	}

	#dispatchMessage(event: MessageEvent): void {
		if (typeof event.data !== "string") return;
		try {
			const parsed = JSON.parse(event.data) as Record<string, unknown>;
			if (parsed.type === "error" && parsed.error !== null && typeof parsed.error === "object") {
				const inner = parsed.error as Record<string, unknown>;
				if (typeof parsed.code !== "string" && typeof inner.code === "string") {
					parsed.code = inner.code;
				}
				if (typeof parsed.message !== "string" && typeof inner.message === "string") {
					parsed.message = inner.message;
				}
			}
			this.#push(parsed);
		} catch (error) {
			this.#push(createCodexWebSocketTransportError(String(error)));
		}
	}

	#captureHandshakeHeaders(socket: WebSocket, openEvent?: Event): void {
		if (this.#onHandshakeHeaders === undefined) return;
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (headers === undefined) return;
		this.#onHandshakeHeaders(headers);
	}

	#push(item: CodexWebSocketQueueItem): void {
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) waiter();
	}

	async #nextMessage(timeoutMs: number, timeoutReason: string): Promise<CodexWebSocketQueueItem> {
		const drained = this.#drainQueue();
		if (drained !== undefined) return drained;
		const outcome = await Effect.runPromise(this.#waitOneCycleEffect(timeoutMs));
		if (outcome === "timeout" && this.#drainQueue() === undefined) {
			return createCodexWebSocketTransportError(timeoutReason);
		}
		const drainedAfter = this.#drainQueue();
		return drainedAfter ?? null;
	}

	#drainQueue(): CodexWebSocketQueueItem | undefined {
		if (this.#queue.length === 0) return undefined;
		return this.#queue.shift() ?? null;
	}

	#waitOneCycleEffect(timeoutMs: number): Effect.Effect<"message" | "timeout"> {
		return Effect.suspend(() => {
			const { promise, resolve } = Promise.withResolvers<"message">();
			const cb = (): void => resolve("message");
			const removeWaiter = (): void => {
				const idx = this.#waiters.indexOf(cb);
				if (idx >= 0) this.#waiters.splice(idx, 1);
			};
			this.#waiters.push(cb);
			const waiter = Effect.promise(() => promise);
			if (timeoutMs <= 0) return waiter.pipe(Effect.ensuring(Effect.sync(removeWaiter)));
			const timeout = Effect.sleep(Duration.millis(timeoutMs)).pipe(Effect.map(() => "timeout" as const));
			return Effect.raceFirst(waiter, timeout).pipe(Effect.ensuring(Effect.sync(removeWaiter)));
		});
	}

	#asTransportError(err: unknown): Error {
		if (err instanceof Error) return err;
		return createCodexWebSocketTransportError(String(err));
	}
}

function extractCodexWebSocketHandshakeHeaders(socket: WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (record === null) return undefined;
	return new Headers(record);
}

function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (value === null || value === undefined || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}
