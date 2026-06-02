/**
 * Persistence plumbing extracted from {@link SessionManager}.
 *
 * Two Modules live here:
 *
 * - {@link NdjsonFileWriter} — low-level append-only JSONL writer with an
 *   internal write queue. One instance per open file. Pure file I/O.
 * - {@link NdjsonAppendLog} — the durable-append seam SessionManager uses.
 *   Wraps a lazy-opened {@link NdjsonFileWriter}, owns the per-session write
 *   chain that serializes async appends LIFO-style, tracks the first persist
 *   error so subsequent appends bail without compounding it, owns the
 *   "next append should be a full rewrite" flag, and exposes atomic full
 *   rewrites via a temp-file swap.
 *
 * SessionManager retains: `fileEntries`, the `byId` index, semantic
 * `append*` methods (model change / thinking level / TTSR rule / recovery
 * marker / etc.), and the prep step that converts in-memory entries into
 * persisted form (e.g. {@link prepareEntryForPersistence}'s blob
 * externalization). Those are session-domain concerns. This Module owns the
 * "how do we durably write a line" concerns.
 */
import * as path from "node:path";
import { logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import type { FileEntry } from "./session-manager";
import type { SessionStorage, SessionStorageWriter } from "./session-storage";

export class NdjsonFileWriter {
	#writer: SessionStorageWriter;
	#closed = false;
	#closing = false;
	#error: Error | undefined;
	#pendingWrites: Promise<void> = Promise.resolve();
	#onError: ((err: Error) => void) | undefined;

	constructor(storage: SessionStorage, path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
		this.#writer = storage.openWriter(path, {
			flags: options?.flags ?? "a",
			onError: (err: Error) => this.#recordError(err),
		});
	}

	#recordError(err: unknown): Error {
		const writeErr = toError(err);
		if (!this.#error) this.#error = writeErr;
		this.#onError?.(writeErr);
		return writeErr;
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const run = async () => {
			if (this.#error) throw this.#error;
			await task();
		};
		const next = this.#pendingWrites.then(run);
		void next.catch((error: unknown) => {
			if (!this.#error) this.#error = toError(error);
		});
		this.#pendingWrites = next;
		return next;
	}

	async #writeLine(line: string): Promise<void> {
		if (this.#error) throw this.#error;
		try {
			await this.#writer.writeLine(line);
		} catch (error) {
			throw this.#recordError(error);
		}
	}

	/** Queue a write. Returns a promise so callers can await if needed. */
	write(entry: FileEntry): Promise<void> {
		if (this.#closed || this.#closing) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
		const line = `${JSON.stringify(entry)}\n`;
		return this.#enqueue(() => this.#writeLine(line));
	}

	/** Flush all buffered data to disk. Waits for all queued writes. */
	async flush(): Promise<void> {
		if (this.#closed) return;
		if (this.#error) throw this.#error;

		await this.#enqueue(async () => {});

		if (this.#error) throw this.#error;

		try {
			await this.#writer.flush();
		} catch (error) {
			throw this.#recordError(error);
		}
	}

	/** Sync data to persistent storage. */
	async fsync(): Promise<void> {
		if (this.#closed) return;
		if (this.#error) throw this.#error;
		try {
			await this.#writer.fsync();
		} catch (error) {
			throw this.#recordError(error);
		}
	}

	/** Close the writer, flushing all data. */
	async close(): Promise<void> {
		if (this.#closed || this.#closing) return;
		this.#closing = true;

		let closeError: Error | undefined;
		try {
			await this.flush();
		} catch (error) {
			closeError = toError(error);
		}

		try {
			await this.#pendingWrites;
		} catch (error) {
			if (!closeError) closeError = toError(error);
		}

		try {
			await this.#writer.close();
		} catch (error) {
			const endErr = this.#recordError(error);
			if (!closeError) closeError = endErr;
		}

		this.#closed = true;

		if (!closeError && this.#error) closeError = this.#error;
		if (closeError) throw closeError;
	}

	/** Check if there's a stored error. */
	getError(): Error | undefined {
		return this.#error;
	}
}

/**
 * Dependencies the {@link NdjsonAppendLog} needs to read its environment.
 * The log does not own these — they're driven by SessionManager's lifecycle
 * (the session file changes on switch/fork; persist flips false for in-memory
 * sessions; the storage adapter is the session-storage abstraction).
 */
export interface NdjsonAppendLogContext {
	persist: boolean;
	storage: SessionStorage;
	getSessionFile(): string | null | undefined;
}

/**
 * Durable-append seam for SessionManager. See module header for split.
 *
 * State invariants:
 * - The writer is lazy: {@link ensureWriter} opens it on first use and rotates
 *   when the session file changes underneath.
 * - The chain serializes async tasks; tasks observe the first persist error
 *   (unless they opt into `ignoreError`) so a failed write doesn't silently
 *   compound into further writes.
 * - The full-rewrite flag is set by SessionManager when in-memory entries
 *   diverge from disk (e.g. migration or in-place mutation); the next persist
 *   path consults it via {@link consumeFullRewriteFlag}.
 */
export class NdjsonAppendLog {
	#ctx: NdjsonAppendLogContext;
	#writer: NdjsonFileWriter | undefined;
	#writerPath: string | undefined;
	#chain: Promise<void> = Promise.resolve();
	#error: Error | undefined;
	#errorReported = false;
	#needsFullRewrite = false;

	constructor(ctx: NdjsonAppendLogContext) {
		this.#ctx = ctx;
	}

	/** First persist error this log has observed, if any. */
	getError(): Error | undefined {
		return this.#error;
	}

	/**
	 * Record a persistence error. The first error sticks; subsequent calls
	 * still log once but do not overwrite the original. Returns the normalised
	 * Error.
	 */
	recordError(err: unknown): Error {
		const normalized = toError(err);
		if (!this.#error) this.#error = normalized;
		if (!this.#errorReported) {
			this.#errorReported = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#ctx.getSessionFile(),
				error: normalized.message,
				stack: normalized.stack,
			});
		}
		return normalized;
	}

	/**
	 * Serialize a task behind every previously-queued task. Returns a promise
	 * that resolves when the task completes (or rejects if the task throws).
	 * If a prior task left a persist error, the new task short-circuits with
	 * that error unless `ignoreError` is set.
	 */
	queueTask(task: () => Promise<void>, options?: { ignoreError?: boolean }): Promise<void> {
		const next = this.#chain.then(async () => {
			if (this.#error && options?.ignoreError !== true) throw this.#error;
			await task();
		});
		this.#chain = next.catch(error => {
			this.recordError(error);
		});
		return next;
	}

	/** Lazy-open the writer for the current session file. Returns undefined when persistence is disabled or no session file is set. */
	ensureWriter(): NdjsonFileWriter | undefined {
		const sessionFile = this.#ctx.getSessionFile();
		if (!this.#ctx.persist || sessionFile === null || sessionFile === undefined || sessionFile === "")
			return undefined;
		if (this.#error) throw this.#error;
		if (this.#writer && this.#writerPath === sessionFile) return this.#writer;
		// Note: caller must await closeWriter() before calling this if switching files
		this.#writer = new NdjsonFileWriter(this.#ctx.storage, sessionFile, {
			onError: err => {
				this.recordError(err);
			},
		});
		this.#writerPath = sessionFile;
		return this.#writer;
	}

	async #closeWriterInternal(): Promise<void> {
		if (this.#writer) {
			await this.#writer.close();
			this.#writer = undefined;
		}
		this.#writerPath = undefined;
	}

	/** Whether a writer is currently open. */
	hasOpenWriter(): boolean {
		return this.#writer !== undefined;
	}

	/** Close the current writer, queued behind any in-flight tasks. Errors swallowed (intended for transitional flows like file switches). */
	async closeWriter(): Promise<void> {
		await this.queueTask(
			async () => {
				await this.#closeWriterInternal();
			},
			{ ignoreError: true },
		);
	}

	/**
	 * Flush + fsync the active writer behind the queue, then surface any
	 * persist error to the caller. Used by SessionManager.flush() at well-
	 * defined sync points (session switch, shutdown).
	 */
	async flushActiveWriter(): Promise<void> {
		await this.queueTask(async () => {
			if (this.#writer) {
				await this.#writer.flush();
				await this.#writer.fsync();
			}
		});
		if (this.#error) throw this.#error;
	}

	/**
	 * Close the active writer queued behind in-flight tasks, then surface
	 * any persist error to the caller. Used by SessionManager.close() at
	 * shutdown — distinct from {@link closeWriter}'s swallow-error semantics
	 * which is used for file-switch transitions.
	 */
	async closeWriterOrThrow(): Promise<void> {
		if (!this.#writer) return;
		await this.queueTask(async () => {
			await this.#closeWriterInternal();
		});
		if (this.#error) throw this.#error;
	}

	/**
	 * Atomic full-file rewrite queued behind any in-flight appends. The caller
	 * supplies an async producer that yields the entries to persist; the
	 * producer runs INSIDE the queued task so callers can read mutable
	 * session state at the right moment without racing against concurrent
	 * appends. Clears the full-rewrite flag on success.
	 */
	async rewriteAll(prepareEntries: () => Promise<FileEntry[]>): Promise<void> {
		await this.queueTask(async () => {
			await this.#closeWriterInternal();
			const entries = await prepareEntries();
			await this.writeEntriesAtomically(entries);
			this.#needsFullRewrite = false;
		});
	}

	/**
	 * Atomically replace the session file with the given entries. Writes to a
	 * temp file in the same directory, then renames over the target. Caller
	 * must close/reopen any open writer; this method does not touch the lazy
	 * writer field.
	 */
	async writeEntriesAtomically(entries: FileEntry[]): Promise<void> {
		const sessionFile = this.#ctx.getSessionFile();
		if (sessionFile === null || sessionFile === undefined || sessionFile === "") return;
		const dir = path.resolve(sessionFile, "..");
		const tempPath = path.join(dir, `.${path.basename(sessionFile)}.${Snowflake.next()}.tmp`);
		const writer = new NdjsonFileWriter(this.#ctx.storage, tempPath, { flags: "w" });
		try {
			for (const entry of entries) {
				await writer.write(entry);
			}
			await writer.flush();
			await writer.fsync();
			await writer.close();
			await this.#ctx.storage.rename(tempPath, sessionFile);
		} catch (error) {
			try {
				await writer.close();
			} catch {
				// Ignore cleanup errors
			}
			try {
				await this.#ctx.storage.unlink(tempPath);
			} catch {
				// Ignore cleanup errors
			}
			throw toError(error);
		}
	}

	/** Mark that the next persist should rewrite the whole file, not append. */
	requestFullRewriteOnNextAppend(): void {
		this.#needsFullRewrite = true;
	}

	/** Read the full-rewrite flag without clearing it. */
	needsFullRewrite(): boolean {
		return this.#needsFullRewrite;
	}

	/** Clear the full-rewrite flag (called once the rewrite completes). */
	clearFullRewriteFlag(): void {
		this.#needsFullRewrite = false;
	}

	/** Set the full-rewrite flag explicitly. Used by SessionManager.restoreState to project a captured snapshot back. */
	setFullRewriteFlag(value: boolean): void {
		this.#needsFullRewrite = value;
	}

	/**
	 * Reset the in-memory writer/chain/error state. Called by
	 * SessionManager.restoreState after a captureState→try→catch unwind so a
	 * new persist cycle starts cleanly under the restored session file.
	 */
	resetTransientState(): void {
		this.#writer = undefined;
		this.#writerPath = undefined;
		this.#chain = Promise.resolve();
		this.#error = undefined;
		this.#errorReported = false;
	}
}
