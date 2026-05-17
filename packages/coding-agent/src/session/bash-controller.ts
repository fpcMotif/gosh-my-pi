import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import type { BashExecutionMessage } from "./messages";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import { UserExecutionQueue } from "./user-execution-queue";

/**
 * Dependencies the {@link BashController} needs from its owning session.
 */
export interface BashControllerContext {
	sessionId: string;
	agent: { appendMessage(message: AgentMessage): void };
	sessionManager: {
		getCwd(): string;
		saveArtifact(content: string, label: string): Promise<string | undefined>;
		appendMessage(message: BashExecutionMessage): string;
	};
	isStreaming(): boolean;
	extensionRunner: ExtensionRunner | undefined;
}

/**
 * Owns the per-session "user-initiated bash command" subsystem. Delegates the
 * streaming-deferred execution queue (in-flight aborts, pending-message buffer,
 * flush-on-idle) to {@link UserExecutionQueue}; this class owns the bash-specific
 * concerns: extension hook routing, the bash-executor call, artifact persistence,
 * and constructing the {@link BashExecutionMessage} from a {@link BashResult}.
 */
export class BashController {
	#ctx: BashControllerContext;
	#queue: UserExecutionQueue<BashExecutionMessage>;

	constructor(ctx: BashControllerContext) {
		this.#ctx = ctx;
		this.#queue = new UserExecutionQueue<BashExecutionMessage>({
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

		return this.#queue.runTracked(async signal => {
			const result = await executeBash(command, {
				onChunk,
				signal,
				sessionKey: this.#ctx.sessionId,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveOriginalArtifact(originalText),
			});

			this.recordResult(command, result, options);
			return result;
		});
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
		this.#queue.recordMessage(bashMessage);
	}

	/** Cancel every in-flight bash command. */
	abort(): void {
		this.#queue.abort();
	}

	/**
	 * Flush pending bash messages to agent state and session. Called before
	 * the next prompt to maintain message ordering.
	 */
	flushPending(): void {
		this.#queue.flushPending();
	}

	async #saveOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.#ctx.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}
}
