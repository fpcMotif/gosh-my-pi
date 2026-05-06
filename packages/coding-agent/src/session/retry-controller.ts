import type { Agent, AgentErrorKind } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { abortableSleep } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ActiveRetryFallback } from "./active-retry-fallback";
import type { RetryFallbackPolicy } from "./retry-fallback-policy";

/** Events the retry controller emits; subset of `AgentSessionEvent`. */
export type RetryControllerEvent =
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/**
 * Dependencies the {@link RetryController} needs from its owning session.
 * Each field is fine-grained so the controller can be exercised in tests
 * without instantiating a full `AgentSession`.
 */
export interface RetryControllerContext {
	sessionId: string;
	settings: Settings;
	agent: Agent;
	modelRegistry: ModelRegistry;
	retryFallbackPolicy: RetryFallbackPolicy;
	activeRetryFallback: ActiveRetryFallback;
	getModel(): { provider: string; baseUrl?: string } | undefined;
	getModelSelector(): string | undefined;
	getPromptGeneration(): number;
	emitSessionEvent(event: RetryControllerEvent): Promise<void>;
	scheduleAgentContinue(options: { delayMs: number; generation: number }): void;
}

/**
 * Owns the per-session retry-attempt loop: attempt counter, the awaitable
 * promise consumers can `waitFor()`, the abort controller for the current
 * backoff sleep. On a retryable error, decides whether to retry, runs
 * credential / model fallback, sleeps with exponential backoff, then
 * schedules a continue.
 *
 * Extracted from `AgentSession` to give the cluster a deletion-test seam
 * and to keep the `errorKind`-driven retry decisions in one place.
 */
export class RetryController {
	#attempt = 0;
	#promise: Promise<void> | undefined = undefined;
	#resolve: (() => void) | undefined = undefined;
	#abortController: AbortController | undefined = undefined;
	#ctx: RetryControllerContext;

	constructor(ctx: RetryControllerContext) {
		this.#ctx = ctx;
	}

	get attempt(): number {
		return this.#attempt;
	}

	get isRetrying(): boolean {
		return this.#promise !== undefined;
	}

	/** Promise to await for an in-flight retry, or undefined when none is in progress. */
	waitFor(): Promise<void> | undefined {
		return this.#promise;
	}

	/** Resolve the in-flight retry promise (if any) and clear it. */
	resolve(): void {
		if (this.#resolve) {
			this.#resolve();
			this.#resolve = undefined;
			this.#promise = undefined;
		}
	}

	/** Cancel any sleeping backoff and resolve the retry promise. */
	abort(): void {
		this.#abortController?.abort();
		this.resolve();
	}

	/**
	 * Called when an assistant turn ends successfully while a retry was in
	 * progress. Returns the attempt count for telemetry, then resets state.
	 */
	consumeSuccessfulAttempt(): number {
		const attempt = this.#attempt;
		this.#attempt = 0;
		return attempt;
	}

	/** Whether the message+errorKind pair is the kind of error this controller retries. */
	isRetryable(message: AssistantMessage, errorKind: AgentErrorKind | undefined): boolean {
		if (message.stopReason !== "error") return false;
		return errorKind?.kind === "usage_limit" || errorKind?.kind === "transient";
	}

	/**
	 * Handle a retryable error: schedule fallback / backoff / continue.
	 * Returns true if a retry was initiated; false if max retries exceeded
	 * or auto-retry is disabled.
	 */
	async handle(message: AssistantMessage, errorKind: AgentErrorKind | undefined): Promise<boolean> {
		const retrySettings = this.#ctx.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;

		const generation = this.#ctx.getPromptGeneration();
		this.#attempt++;

		// Create retry promise on first attempt so waitFor() can await it.
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls).
		if (!this.#promise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#promise = promise;
			this.#resolve = resolve;
		}

		if (this.#attempt > retrySettings.maxRetries) {
			await this.#ctx.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#attempt - 1,
				finalError: message.errorMessage,
			});
			this.#attempt = 0;
			this.resolve();
			return false;
		}

		const errorMessage = message.errorMessage ?? "Unknown error";
		const parsedRetryAfterMs =
			errorKind?.kind === "usage_limit"
				? errorKind.retryAfterMs
				: errorKind?.kind === "transient"
					? errorKind.retryAfterMs
					: undefined;
		let delayMs = retrySettings.baseDelayMs * 2 ** (this.#attempt - 1);
		let switchedCredential = false;
		let switchedModel = false;

		const currentModel = this.#ctx.getModel();
		if (currentModel && errorKind?.kind === "usage_limit") {
			const retryAfterMs = errorKind.retryAfterMs;
			const switched = await this.#ctx.modelRegistry.authStorage.markUsageLimitReached(
				currentModel.provider,
				this.#ctx.sessionId,
				{
					retryAfterMs,
					baseUrl: currentModel.baseUrl,
				},
			);
			if (switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (retryAfterMs > delayMs) {
				delayMs = retryAfterMs;
			}
		}

		const currentSelector = this.#ctx.getModelSelector();
		if (!switchedCredential && currentSelector !== null && currentSelector !== undefined && currentSelector !== "") {
			this.#ctx.retryFallbackPolicy.noteCooldown(currentSelector, errorKind);
			switchedModel = await this.#ctx.activeRetryFallback.tryFallback(currentSelector);
			if (switchedModel) {
				delayMs = 0;
			} else if (
				parsedRetryAfterMs !== null &&
				parsedRetryAfterMs !== undefined &&
				parsedRetryAfterMs !== 0 &&
				parsedRetryAfterMs > delayMs
			) {
				delayMs = parsedRetryAfterMs;
			}
		}

		await this.#ctx.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#attempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.#ctx.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.#ctx.agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#abortController?.abort();
		this.#abortController = retryAbortController;
		try {
			await abortableSleep(delayMs, retryAbortController.signal);
		} catch {
			if (this.#abortController !== retryAbortController) {
				return false;
			}
			const attempt = this.#attempt;
			this.#attempt = 0;
			this.#abortController = undefined;
			await this.#ctx.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.resolve();
			return false;
		}
		if (this.#abortController === retryAbortController) {
			this.#abortController = undefined;
		}

		// Retry via continue() outside the agent_end event callback chain.
		this.#ctx.scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}
}
