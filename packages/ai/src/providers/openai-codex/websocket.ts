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

export const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
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

export class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#idleTimeoutMs: number;
	#firstEventTimeoutMs: number;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
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
		if (
			this.#socket !== null &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise !== undefined && this.#connectPromise !== null) {
			await this.#connectPromise;
			return;
		}
		const WebSocketWithHeaders = WebSocket as unknown as {
			new (url: string, options?: { headers?: Record<string, string> }): WebSocket;
		};
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new WebSocketWithHeaders(this.#url, { headers: this.#headers });
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const onAbort = () => {
			socket.close(1000, "aborted");
			if (settled === false) {
				settled = true;
				reject(createCodexWebSocketTransportError("request was aborted"));
			}
		};

		if (signal !== undefined && signal !== null) {
			if (signal.aborted === true) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		const clearPending = () => {
			if (timeout !== undefined && timeout !== null) clearTimeout(timeout);
			if (signal !== undefined && signal !== null) signal.removeEventListener("abort", onAbort);
		};

		timeout = setTimeout(() => {
			socket.close(1000, "connect-timeout");
			if (settled === false) {
				settled = true;
				reject(createCodexWebSocketTransportError("connection timeout"));
			}
		}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);

		socket.addEventListener("open", event => {
			if (settled === false) {
				settled = true;
				clearPending();
				this.#captureHandshakeHeaders(socket, event);
				resolve();
			}
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
			const error = createCodexWebSocketTransportError(`websocket error: ${detail}`);
			if (settled === false) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		});

		socket.addEventListener("close", event => {
			this.#socket = null;
			if (settled === false) {
				settled = true;
				clearPending();
				reject(createCodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(createCodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		});

		socket.addEventListener("message", event => {
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
		});

		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		signal?: AbortSignal,
	): AsyncGenerator<Record<string, unknown>> {
		if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) {
			throw createCodexWebSocketTransportError("websocket connection is unavailable");
		}
		if (this.#activeRequest === true) {
			throw createCodexWebSocketTransportError("websocket request already in progress");
		}
		this.#activeRequest = true;

		const onAbort = () => {
			this.close("aborted");
			this.#push(createCodexWebSocketTransportError("request was aborted"));
		};

		if (signal !== undefined && signal !== null) {
			if (signal.aborted === true) {
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
			if (signal !== undefined && signal !== null) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	async *#streamUntilTerminal(sawFirstEvent: boolean): AsyncGenerator<Record<string, unknown>> {
		const next = await this.#nextMessage(
			sawFirstEvent ? this.#idleTimeoutMs : this.#firstEventTimeoutMs,
			sawFirstEvent ? "idle timeout waiting for websocket" : "timeout waiting for first websocket event",
		);
		if (next instanceof Error) {
			throw next;
		}
		if (next === null) {
			throw createCodexWebSocketTransportError("websocket closed before response completion");
		}
		yield next;
		const eventType = typeof next.type === "string" ? next.type : "";
		if (
			eventType === "response.completed" ||
			eventType === "response.done" ||
			eventType === "response.incomplete" ||
			eventType === "response.failed" ||
			eventType === "error"
		) {
			return;
		}
		yield* this.#streamUntilTerminal(true);
	}

	#captureHandshakeHeaders(socket: WebSocket, openEvent?: Event): void {
		if (this.#onHandshakeHeaders === undefined || this.#onHandshakeHeaders === null) return;
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (headers === undefined || headers === null) return;
		this.#onHandshakeHeaders(headers);
	}

	#push(item: Record<string, unknown> | Error | null): void {
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter !== undefined && waiter !== null) waiter();
	}

	async #nextMessage(timeoutMs: number, timeoutReason: string): Promise<Record<string, unknown> | Error | null> {
		if (this.#queue.length > 0) {
			return this.#queue.shift() ?? null;
		}
		const timedOut = await this.#waitOneCycle(timeoutMs);
		if (timedOut === true && this.#queue.length === 0) {
			return createCodexWebSocketTransportError(timeoutReason);
		}
		if (this.#queue.length === 0) {
			return this.#nextMessage(timeoutMs, timeoutReason);
		}
		return this.#queue.shift() ?? null;
	}

	#waitOneCycle(timeoutMs: number): Promise<boolean> {
		return new Promise<boolean>(settle => {
			let timedOut = false;
			let settled = false;
			const settleOnce = (didTimeOut: boolean) => {
				if (settled === true) return;
				settled = true;
				if (timeout !== undefined && timeout !== null) clearTimeout(timeout);
				settle(didTimeOut);
			};
			const resolve = () => settleOnce(timedOut);
			this.#waiters.push(resolve);
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					settleOnce(true);
				}, timeoutMs);
			}
		});
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
