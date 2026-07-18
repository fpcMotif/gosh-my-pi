import { isRecord } from "@oh-my-pi/pi-utils";
import { isRpcHostToolResult, isRpcHostToolUpdate } from "./host-tools";
import type { RpcExtensionUIResponse, RpcHostToolResult, RpcHostToolUpdate } from "./rpc-types";

export type RpcCommandEnvelope = { id?: string; type: string };

export interface RpcInboundRouterOptions {
	input: AsyncIterable<Uint8Array>;
	commandCapacity?: number;
	onCommand: (command: RpcCommandEnvelope) => Promise<void>;
	onExtensionUIResponse: (response: RpcExtensionUIResponse) => void;
	onHostToolResult: (result: RpcHostToolResult) => void;
	onHostToolUpdate: (update: RpcHostToolUpdate) => void;
	onParseError: (message: string) => void;
	onQueueFull: (command: RpcCommandEnvelope) => void;
	onEnd: () => void;
}

/**
 * Keeps the bidirectional control lane live while command work is blocked.
 * Commands wait in one bounded FIFO queue. Dialog and host-tool replies never
 * enter that queue, so startup and long commands cannot deadlock their reply.
 */
export class RpcInboundRouter {
	#input: AsyncIterable<Uint8Array>;
	#commandCapacity: number;
	#onCommand: (command: RpcCommandEnvelope) => Promise<void>;
	#onExtensionUIResponse: (response: RpcExtensionUIResponse) => void;
	#onHostToolResult: (result: RpcHostToolResult) => void;
	#onHostToolUpdate: (update: RpcHostToolUpdate) => void;
	#onParseError: (message: string) => void;
	#onQueueFull: (command: RpcCommandEnvelope) => void;
	#onEnd: () => void;
	#commands: RpcCommandEnvelope[] = [];
	#started = false;
	#ready = false;
	#closed = false;
	#draining = false;
	#reader?: Promise<void>;
	#drained = Promise.withResolvers<void>();
	#drainedSettled = false;

	constructor(options: RpcInboundRouterOptions) {
		this.#input = options.input;
		this.#commandCapacity = options.commandCapacity ?? 128;
		this.#onCommand = options.onCommand;
		this.#onExtensionUIResponse = options.onExtensionUIResponse;
		this.#onHostToolResult = options.onHostToolResult;
		this.#onHostToolUpdate = options.onHostToolUpdate;
		this.#onParseError = options.onParseError;
		this.#onQueueFull = options.onQueueFull;
		this.#onEnd = options.onEnd;
	}

	get closed(): boolean {
		return this.#closed;
	}

	get finished(): Promise<void> {
		return this.#reader ?? Promise.resolve();
	}

	get complete(): Promise<void> {
		return this.#drained.promise;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#reader = this.#read();
	}

	activate(): void {
		this.#ready = true;
		this.#scheduleDrain();
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const lineBytes of this.#input) {
				this.#routeLine(decoder.decode(lineBytes).trim());
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#onParseError(`Failed to read command: ${message}`);
		} finally {
			this.#closed = true;
			// A disconnected host cannot observe later command responses. Keep an
			// already-running command intact, but never start queued side effects.
			this.#commands = [];
			this.#onEnd();
			this.#finishIfComplete();
		}
	}

	#routeLine(raw: string): void {
		if (raw.length === 0) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#onParseError(`Failed to parse command: ${message}`);
			return;
		}

		if (isRpcExtensionUIResponse(parsed)) {
			this.#onExtensionUIResponse(parsed);
			return;
		}
		if (isRpcHostToolResult(parsed)) {
			this.#onHostToolResult(parsed);
			return;
		}
		if (isRpcHostToolUpdate(parsed)) {
			this.#onHostToolUpdate(parsed);
			return;
		}
		if (isMalformedControlFrame(parsed)) {
			this.#onParseError("Failed to parse command: malformed control frame");
			return;
		}
		if (!isRpcCommandEnvelope(parsed)) {
			this.#onParseError("Failed to parse command: expected object with string type and optional string id");
			return;
		}
		if (this.#commands.length >= this.#commandCapacity) {
			this.#onQueueFull(parsed);
			return;
		}
		this.#commands.push(parsed);
		this.#scheduleDrain();
	}

	#scheduleDrain(): void {
		if (!this.#ready || this.#draining || this.#commands.length === 0) return;
		this.#draining = true;
		void this.#drain();
	}

	async #drain(): Promise<void> {
		try {
			while (this.#ready && !this.#closed) {
				const command = this.#commands.shift();
				if (command === undefined) return;
				await this.#onCommand(command);
			}
		} finally {
			this.#draining = false;
			this.#scheduleDrain();
			this.#finishIfComplete();
		}
	}

	#finishIfComplete(): void {
		if (this.#closed && !this.#draining && this.#commands.length === 0 && !this.#drainedSettled) {
			this.#drainedSettled = true;
			this.#drained.resolve();
		}
	}
}

export function isRpcCommandEnvelope(value: unknown): value is RpcCommandEnvelope {
	return isRecord(value) && typeof value.type === "string" && (value.id === undefined || typeof value.id === "string");
}

function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") return false;
	return (
		typeof value.value === "string" ||
		typeof value.confirmed === "boolean" ||
		(value.cancelled === true && (value.timedOut === undefined || typeof value.timedOut === "boolean"))
	);
}

function isMalformedControlFrame(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		value.type === "extension_ui_response" || value.type === "host_tool_result" || value.type === "host_tool_update"
	);
}
