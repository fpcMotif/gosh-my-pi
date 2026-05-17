import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { disposeKernelSessionsByOwner, executePython, type PythonResult } from "../ipy/executor";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";
import { UserExecutionQueue } from "./user-execution-queue";

/**
 * Dependencies the {@link PythonController} needs from its owning session.
 */
export interface PythonControllerContext {
	kernelOwnerId: string;
	agent: { appendMessage(message: AgentMessage): void };
	sessionManager: {
		getCwd(): string;
		getSessionFile(): string | null | undefined;
		appendMessage(message: PythonExecutionMessage): string;
	};
	settings: Settings;
	isStreaming(): boolean;
	extensionRunner: ExtensionRunner | undefined;
}

/**
 * Owns the per-session "user-initiated Python execution" subsystem. The streaming-
 * deferred queue (in-flight aborts, pending-message buffer, flush-on-idle, active-
 * execution tracking, await-settlement) lives in {@link UserExecutionQueue}; this
 * class adds the Python-specific concerns: extension hook routing, the kernel call,
 * the kernel-owner id, and the disposal lifecycle (`markDisposing`,
 * `prepareForDispose`, `disposeKernel`) the bash controller does not have.
 */
export class PythonController {
	#ctx: PythonControllerContext;
	#queue: UserExecutionQueue<PythonExecutionMessage>;
	#disposing = false;

	constructor(ctx: PythonControllerContext) {
		this.#ctx = ctx;
		this.#queue = new UserExecutionQueue<PythonExecutionMessage>({
			agent: ctx.agent,
			sessionManager: ctx.sessionManager,
			isStreaming: () => ctx.isStreaming(),
		});
	}

	get isRunning(): boolean {
		return this.#queue.isRunning;
	}

	get hasPending(): boolean {
		return this.#queue.hasPending;
	}

	/** Throws if execution is currently disabled (during session disposal). */
	assertAllowed(): void {
		if (this.#disposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Execute Python in the shared kernel. Uses the same kernel session as
	 * the Python tool so the user can collaborate with the agent on running
	 * state.
	 */
	async execute(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#ctx.sessionManager.getCwd();
		this.assertAllowed();

		return this.#queue.runTracked(async signal => {
			if (this.#ctx.extensionRunner?.hasHandlers("user_python") === true) {
				const hookResult = await this.#ctx.extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertAllowed();
				if (hookResult?.result) {
					this.recordResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			const sessionFile = this.#ctx.sessionManager.getSessionFile();
			const sessionId =
				sessionFile !== null && sessionFile !== undefined && sessionFile !== ""
					? `session:${sessionFile}:cwd:${cwd}`
					: `cwd:${cwd}`;
			const result = await executePython(code, {
				cwd,
				sessionId,
				kernelOwnerId: this.#ctx.kernelOwnerId,
				kernelMode: this.#ctx.settings.get("python.kernelMode"),
				useSharedGateway: this.#ctx.settings.get("python.sharedGateway"),
				onChunk,
				signal,
			});
			this.recordResult(code, result, options);
			return result;
		});
	}

	/**
	 * Track a Python execution started outside {@link execute} so dispose can
	 * await and abort it too.
	 */
	track<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#queue.track(execution, abortController);
	}

	recordResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		this.#queue.recordMessage(pythonMessage);
	}

	abort(): void {
		this.#queue.abort();
	}

	flushPending(): void {
		this.#queue.flushPending();
	}

	/** Mark the controller as disposing so further executions are rejected. */
	markDisposing(): void {
		this.#disposing = true;
	}

	/**
	 * Wait for active Python executions to settle, then abort surviving ones
	 * and wait again. Returns true if all executions settled cooperatively.
	 */
	async prepareForDispose(): Promise<boolean> {
		if (!(await this.#queue.awaitSettlement(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#queue.awaitSettlement(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Detach this controller's retained kernel ownership. Called once during dispose. */
	disposeKernel(): Promise<void> {
		return disposeKernelSessionsByOwner(this.#ctx.kernelOwnerId);
	}
}
