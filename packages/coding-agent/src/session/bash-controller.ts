import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import type { BashExecutionMessage } from "./messages";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";

/**
 * Dependencies the {@link BashController} needs from its owning session.
 */
export interface BashControllerContext {
	sessionId: string;
	agent: { appendMessage(message: AgentMessage): void };
	sessionManager: {
		getCwd(): string;
		saveArtifact(content: string, label: string): Promise<string>;
		appendMessage(message: BashExecutionMessage): string;
	};
	isStreaming(): boolean;
	extensionRunner: ExtensionRunner | undefined;
}

/**
 * Owns the per-session "user-initiated bash command" subsystem: tracking
 * in-flight commands' abort controllers, queueing bash messages emitted
 * during streaming so they don't break tool_use/tool_result ordering, and
 * flushing the queue before the next prompt.
 *
 * Extracted from `AgentSession` to give the cluster a deletion-test seam:
 * five public methods + two state fields now live behind one field on the
 * session.
 */
export class BashController {
	#ctx: BashControllerContext;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: BashExecutionMessage[] = [];

	constructor(ctx: BashControllerContext) {
		this.#ctx = ctx;
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	get hasPending(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/**
	 * Execute a bash command. If the session has a `user_bash` extension hook,
	 * the extension may handle execution itself; otherwise the bash-executor
	 * runs the command with a timeout and per-session abort.
	 */
	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#ctx.sessionManager.getCwd();

		if (this.#ctx.extensionRunner?.hasHandlers("user_bash") === true) {
			const hookResult = await this.#ctx.extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#abortControllers.add(abortController);

		try {
			const result = await executeBash(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.#ctx.sessionId,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveOriginalArtifact(originalText),
			});

			this.recordResult(command, result, options);
			return result;
		} finally {
			this.#abortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash result in session history. Called by `execute()` and also
	 * by `user_bash` extensions that handle execution themselves.
	 */
	recordResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.#ctx.isStreaming()) {
			this.#pendingMessages.push(bashMessage);
		} else {
			this.#ctx.agent.appendMessage(bashMessage);
			this.#ctx.sessionManager.appendMessage(bashMessage);
		}
	}

	/** Cancel every in-flight bash command. */
	abort(): void {
		for (const abortController of this.#abortControllers) {
			abortController.abort();
		}
	}

	/**
	 * Flush pending bash messages to agent state and session. Called before
	 * the next prompt to maintain message ordering.
	 */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;

		for (const bashMessage of this.#pendingMessages) {
			this.#ctx.agent.appendMessage(bashMessage);
			this.#ctx.sessionManager.appendMessage(bashMessage);
		}
		this.#pendingMessages = [];
	}

	async #saveOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.#ctx.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}
}
