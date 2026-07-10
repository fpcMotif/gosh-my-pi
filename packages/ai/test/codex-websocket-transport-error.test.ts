import { describe, expect, it } from "bun:test";
import {
	CodexWebSocketConnection,
	createCodexWebSocketTransportError,
	formatCodexWebSocketTransportErrorMessage,
	unwrapCodexWebSocketTransportError,
} from "@oh-my-pi/pi-ai/providers/openai-codex/websocket";

const originalWebSocket = global.WebSocket;

function restoreWebSocket(): void {
	global.WebSocket = originalWebSocket;
}

type WsListener = (event: Event) => void;

/** Base fake WebSocket: registers listeners, tracks sent frames, no scripted behavior. */
class FakeWebSocketBase {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState = FakeWebSocketBase.CONNECTING;
	listeners = new Map<string, Set<WsListener>>();

	constructor(_url: string, _options?: { headers?: Record<string, string> }) {}

	addEventListener(type: string, listener: unknown): void {
		if (typeof listener !== "function") return;
		const listeners = this.listeners.get(type) ?? new Set<WsListener>();
		listeners.add(listener as WsListener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: unknown): void {
		if (typeof listener !== "function") return;
		this.listeners.get(type)?.delete(listener as WsListener);
	}

	send(_data: string): void {}

	close(): void {
		this.readyState = FakeWebSocketBase.CLOSED;
	}

	emit(type: string, event: unknown): void {
		const listeners = this.listeners.get(type);
		if (!listeners) return;
		for (const listener of listeners) listener(event as Event);
	}
}

describe("createCodexWebSocketTransportError / formatCodexWebSocketTransportErrorMessage", () => {
	it("assigns the malformed-message reason with the raw parse error as detail", () => {
		const error = createCodexWebSocketTransportError("malformed-message", "SyntaxError: bad token");
		expect(error.reason).toBe("malformed-message");
		expect(error.detail).toBe("SyntaxError: bad token");
		expect(formatCodexWebSocketTransportErrorMessage(error)).toBe("SyntaxError: bad token");
	});

	it("distinguishes closed-before-open from closed-mid-stream by detail presence and reason", () => {
		const beforeOpen = createCodexWebSocketTransportError("closed-before-open", "1006");
		const midStreamWithCode = createCodexWebSocketTransportError("closed-mid-stream", "1006");
		const midStreamFolded = createCodexWebSocketTransportError("closed-mid-stream");

		expect(beforeOpen.reason).toBe("closed-before-open");
		expect(formatCodexWebSocketTransportErrorMessage(beforeOpen)).toBe("websocket closed before open (1006)");

		expect(midStreamWithCode.reason).toBe("closed-mid-stream");
		expect(formatCodexWebSocketTransportErrorMessage(midStreamWithCode)).toBe("websocket closed (1006)");

		// The folded (former L172 null-drain) variant carries no detail.
		expect(midStreamFolded.reason).toBe("closed-mid-stream");
		expect(formatCodexWebSocketTransportErrorMessage(midStreamFolded)).toBe(
			"websocket closed before response completion",
		);
	});

	it("round-trips through unwrapCodexWebSocketTransportError, including via .cause", () => {
		const tagged = createCodexWebSocketTransportError("socket-error", "boom");
		expect(unwrapCodexWebSocketTransportError(tagged)).toBe(tagged);

		const wrapped = new Error("outer wrapper");
		(wrapped as { cause?: unknown }).cause = tagged;
		expect(unwrapCodexWebSocketTransportError(wrapped)).toBe(tagged);

		expect(unwrapCodexWebSocketTransportError(new Error("unrelated"))).toBeUndefined();
		expect(unwrapCodexWebSocketTransportError("not an error")).toBeUndefined();
	});
});

describe("CodexWebSocketConnection reason wiring", () => {
	it("produces first-event-timeout when no message arrives before the first-event deadline", async () => {
		class Ws extends FakeWebSocketBase {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.OPEN;
					this.emit("open", new Event("open"));
				}, 0);
			}
			// send() intentionally never produces a message -> forces the first-event deadline.
		}
		global.WebSocket = Ws as unknown as typeof WebSocket;
		try {
			const connection = new CodexWebSocketConnection(
				"wss://example.test",
				{},
				{ idleTimeoutMs: 5000, firstEventTimeoutMs: 10, onHandshakeHeaders: undefined },
			);
			await connection.connect();

			const generator = connection.streamRequest({ type: "response.create" });
			let caught: unknown;
			try {
				await generator.next();
			} catch (error) {
				caught = error;
			}

			const wsError = unwrapCodexWebSocketTransportError(caught);
			expect(wsError?.reason).toBe("first-event-timeout");
		} finally {
			restoreWebSocket();
		}
	});

	it("produces idle-timeout once a first (non-terminal) event has already been delivered", async () => {
		class Ws extends FakeWebSocketBase {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.OPEN;
					this.emit("open", new Event("open"));
				}, 0);
			}
			override send(): void {
				// Deliver exactly one non-terminal event, then go idle.
				setTimeout(() => {
					this.emit("message", {
						data: JSON.stringify({
							type: "response.output_item.added",
							item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
						}),
					});
				}, 0);
			}
		}
		global.WebSocket = Ws as unknown as typeof WebSocket;
		try {
			const connection = new CodexWebSocketConnection(
				"wss://example.test",
				{},
				{ idleTimeoutMs: 10, firstEventTimeoutMs: 5000, onHandshakeHeaders: undefined },
			);
			await connection.connect();

			const generator = connection.streamRequest({ type: "response.create" });
			const first = await generator.next();
			expect(first.done).toBe(false);

			let caught: unknown;
			try {
				await generator.next();
			} catch (error) {
				caught = error;
			}

			const wsError = unwrapCodexWebSocketTransportError(caught);
			expect(wsError?.reason).toBe("idle-timeout");
		} finally {
			restoreWebSocket();
		}
	});

	it("assigns malformed-message when a message fails JSON.parse", async () => {
		class Ws extends FakeWebSocketBase {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.OPEN;
					this.emit("open", new Event("open"));
				}, 0);
			}
			override send(): void {
				setTimeout(() => {
					this.emit("message", { data: "{not valid json" });
				}, 0);
			}
		}
		global.WebSocket = Ws as unknown as typeof WebSocket;
		try {
			const connection = new CodexWebSocketConnection(
				"wss://example.test",
				{},
				{ idleTimeoutMs: 5000, firstEventTimeoutMs: 5000, onHandshakeHeaders: undefined },
			);
			await connection.connect();

			const generator = connection.streamRequest({ type: "response.create" });
			let caught: unknown;
			try {
				await generator.next();
			} catch (error) {
				caught = error;
			}

			const wsError = unwrapCodexWebSocketTransportError(caught);
			expect(wsError?.reason).toBe("malformed-message");
			expect(wsError?.detail).toContain("SyntaxError");
		} finally {
			restoreWebSocket();
		}
	});

	it("assigns closed-before-open when the socket closes before the handshake settles", async () => {
		class Ws extends FakeWebSocketBase {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.CLOSED;
					// Never emits "open" — the close race wins the handshake.
					this.emit("close", { code: 1006 });
				}, 0);
			}
		}
		global.WebSocket = Ws as unknown as typeof WebSocket;
		try {
			const connection = new CodexWebSocketConnection(
				"wss://example.test",
				{},
				{ idleTimeoutMs: 5000, firstEventTimeoutMs: 5000, onHandshakeHeaders: undefined },
			);

			let caught: unknown;
			try {
				await connection.connect();
			} catch (error) {
				caught = error;
			}

			const wsError = unwrapCodexWebSocketTransportError(caught);
			expect(wsError?.reason).toBe("closed-before-open");
			expect(wsError?.detail).toBe("1006");
		} finally {
			restoreWebSocket();
		}
	});

	// Proves the ~L172 null-drain fold is safe: the "close" listener always
	// pushes a "closed-mid-stream" CodexWebSocketTransportError immediately
	// before pushing null onto the same FIFO queue (see websocket.ts). If a
	// counter-example could reach the null-drain fallback (the folded,
	// no-detail "websocket closed before response completion" message)
	// instead of this paired error, the `detail` assertion below would fail
	// (the fallback carries no detail) or the reason would differ.
	it("drains the paired closed-mid-stream error before the null that follows it on the queue", async () => {
		class Ws extends FakeWebSocketBase {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.OPEN;
					this.emit("open", new Event("open"));
				}, 0);
			}
			override send(): void {
				setTimeout(() => {
					this.readyState = FakeWebSocketBase.CLOSED;
					this.emit("close", { code: 1005 });
				}, 0);
			}
		}
		global.WebSocket = Ws as unknown as typeof WebSocket;
		try {
			const connection = new CodexWebSocketConnection(
				"wss://example.test",
				{},
				{ idleTimeoutMs: 5000, firstEventTimeoutMs: 5000, onHandshakeHeaders: undefined },
			);
			await connection.connect();

			const generator = connection.streamRequest({ type: "response.create" });
			let caught: unknown;
			try {
				await generator.next();
			} catch (error) {
				caught = error;
			}

			const wsError = unwrapCodexWebSocketTransportError(caught);
			expect(wsError?.reason).toBe("closed-mid-stream");
			// A detail is present, proving the drained item was the paired
			// "close (code)" error — not the folded null-drain fallback, which
			// never carries a detail.
			expect(wsError?.detail).toBe("1005");
		} finally {
			restoreWebSocket();
		}
	});
});
