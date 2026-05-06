import { Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Generic id-correlated request/response primitive shared by the two
 * bidirectional RPC channels (extension UI dialogs + host tool calls).
 *
 * Replaces two bespoke `Map<string, {resolve, reject}>` patterns with one
 * tested implementation. Wire shape is unchanged — only the correlation
 * logic is shared (decision 8, interpretation B).
 *
 * Lifecycle for one request:
 *   1. caller invokes `register(opts)` to get an id + promise
 *   2. caller emits a frame with the id (e.g. `host_tool_call` or `extension_ui_request`)
 *   3. response frame arrives; caller invokes `resolve(id, value)`
 *   4. promise settles; correlator state is cleaned up
 *
 * Failure modes the correlator handles:
 *   - timeout (caller-supplied; default = no timeout)
 *   - abort signal (caller-supplied)
 *   - explicit cancel (e.g. session shutdown)
 *
 * Calling `resolve`/`reject`/`cancel` on an unknown id returns `false`
 * (no-op); this lets callers safely respond to stale frames.
 */

export interface RegisterOptions<T> {
	/**
	 * Optional explicit id. When omitted, the correlator generates a fresh
	 * Snowflake id. Callers MUST use the returned id when emitting the
	 * outbound frame.
	 */
	id?: string;
	/** Abort signal — when fired, the request is cancelled with `defaultValue`. */
	signal?: AbortSignal;
	/** Timeout in milliseconds — when fired, the request resolves with `defaultValue`. */
	timeoutMs?: number;
	/**
	 * Value to resolve with on timeout or abort. Required when the request
	 * is cancellable; if omitted, timeout/abort cause rejection instead.
	 */
	defaultValue?: T;
	/** Callback fired when timeout elapses (before the promise resolves). */
	onTimeout?: () => void;
	/** Callback fired when abort signal fires (before the promise resolves). */
	onAbort?: () => void;
}

interface CorrelatedRequest<T> {
	readonly id: string;
	readonly promise: Promise<T>;
}

interface PendingEntry {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	cleanup: () => void;
}

export class RequestCorrelator {
	#pending = new Map<string, PendingEntry>();

	/**
	 * Register a new pending request. Returns a unique id and a promise that
	 * resolves when the matching response arrives via {@link resolve}, or
	 * settles via timeout/abort/cancel.
	 */
	register<T>(opts: RegisterOptions<T> = {}): CorrelatedRequest<T> {
		const id = opts.id ?? (Snowflake.next() as string);

		// Pre-resolution short-circuit when signal is already aborted.
		if (opts.signal?.aborted === true) {
			return {
				id,
				promise:
					opts.defaultValue !== undefined
						? Promise.resolve(opts.defaultValue)
						: Promise.reject(new Error(`Request ${id} aborted before registration`)),
			};
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			opts.signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};

		const onAbort = (): void => {
			cleanup();
			opts.onAbort?.();
			if (opts.defaultValue !== undefined) {
				resolve(opts.defaultValue);
			} else {
				reject(new Error(`Request ${id} aborted`));
			}
		};

		opts.signal?.addEventListener("abort", onAbort, { once: true });

		if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				cleanup();
				opts.onTimeout?.();
				if (opts.defaultValue !== undefined) {
					resolve(opts.defaultValue);
				} else {
					reject(new Error(`Request ${id} timed out after ${opts.timeoutMs}ms`));
				}
			}, opts.timeoutMs);
		}

		this.#pending.set(id, {
			resolve: value => {
				cleanup();
				resolve(value as T);
			},
			reject: reason => {
				cleanup();
				reject(reason);
			},
			cleanup,
		});

		return { id, promise };
	}

	/** Whether an id is currently pending. */
	has(id: string): boolean {
		return this.#pending.has(id);
	}

	/**
	 * Resolve a pending request with `value`. Returns `true` when the id
	 * matched a pending request (promise settled), `false` when the id was
	 * unknown (stale or never registered).
	 */
	resolve(id: string, value: unknown): boolean {
		const entry = this.#pending.get(id);
		if (!entry) return false;
		entry.resolve(value);
		return true;
	}

	/**
	 * Reject a pending request. Returns `true` when the id matched.
	 */
	reject(id: string, reason: unknown): boolean {
		const entry = this.#pending.get(id);
		if (!entry) return false;
		entry.reject(reason);
		return true;
	}

	/**
	 * Cancel a pending request — same as reject but with a default reason.
	 * Returns `true` when the id matched.
	 */
	cancel(id: string, reason?: string): boolean {
		const entry = this.#pending.get(id);
		if (!entry) return false;
		entry.reject(new Error(reason ?? `Request ${id} cancelled`));
		return true;
	}

	/**
	 * Cancel every pending request (used on shutdown). Returns the number
	 * of requests cancelled.
	 */
	cancelAll(reason?: string): number {
		const ids = Array.from(this.#pending.keys());
		for (const id of ids) {
			this.cancel(id, reason);
		}
		return ids.length;
	}

	/**
	 * Read-only view of currently-pending request count. Useful for
	 * shutdown-quiescence checks.
	 */
	get pendingCount(): number {
		return this.#pending.size;
	}
}
