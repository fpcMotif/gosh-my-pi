import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { disposeKernelSessionsByOwner, executePython, type PythonResult } from "../ipy/executor";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";

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
 * Owns the per-session "user-initiated Python execution" subsystem: tracks
 * in-flight kernel executions (so dispose can wait/abort), queues messages
 * emitted during streaming, manages a per-session kernel owner id used to
 * scope kernel-session disposal.
 *
 * Sibling of {@link BashController}, with the additional concern of
 * cooperative kernel cleanup at dispose time.
 */
export class PythonController {
	#ctx: PythonControllerContext;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: PythonExecutionMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();
	#disposing = false;

	constructor(ctx: PythonControllerContext) {
		this.#ctx = ctx;
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	get hasPending(): boolean {
		return this.#pendingMessages.length > 0;
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

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
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
				signal: abortController.signal,
			});
			this.recordResult(code, result, options);
			return result;
		})();
		return await this.track(execution, abortController);
	}

	/**
	 * Track a Python execution started outside {@link execute} so dispose can
	 * await and abort it too.
	 */
	track<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		void execution.then(
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
		);
		return execution;
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

		if (this.#ctx.isStreaming()) {
			this.#pendingMessages.push(pythonMessage);
		} else {
			this.#ctx.agent.appendMessage(pythonMessage);
			this.#ctx.sessionManager.appendMessage(pythonMessage);
		}
	}

	abort(): void {
		for (const abortController of this.#abortControllers) {
			abortController.abort();
		}
	}

	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		for (const pythonMessage of this.#pendingMessages) {
			this.#ctx.agent.appendMessage(pythonMessage);
			this.#ctx.sessionManager.appendMessage(pythonMessage);
		}
		this.#pendingMessages = [];
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
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
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

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}
}
