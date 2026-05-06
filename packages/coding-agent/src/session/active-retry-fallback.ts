import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import {
	type ActiveRetryFallbackState,
	formatRetryFallbackSelector,
	parseRetryFallbackSelector,
	type RetryFallbackPolicy,
	type RetryFallbackSelector,
} from "./retry-fallback-policy";
import type { SessionManager } from "./session-manager";

/**
 * Dependencies the {@link ActiveRetryFallback} controller needs from its
 * owning session. Each field is intentionally fine-grained so the controller
 * can be exercised in tests without instantiating a full `AgentSession`.
 */
export interface ActiveRetryFallbackContext {
	sessionId: string;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	settings: Settings;
	policy: RetryFallbackPolicy;
	getModel(): Model | undefined;
	getThinkingLevel(): ThinkingLevel | undefined;
	setModelWithReset(model: Model): void;
	setThinkingLevel(level: ThinkingLevel | undefined): void;
	emitFallbackApplied(payload: { from: string; to: string; role: string }): Promise<void>;
}

/**
 * Owns the per-session "currently-active retry fallback" state and the
 * methods that mutate it: applying a candidate model when the primary fails,
 * clearing on success, and restoring the primary once its cooldown expires.
 *
 * Extracted from `AgentSession` to give the cluster a deletion-test seam:
 * the entire fallback subsystem now lives behind one field on the session,
 * and unsubscribing it is a one-line change.
 */
export class ActiveRetryFallback {
	#state: ActiveRetryFallbackState | undefined = undefined;
	#ctx: ActiveRetryFallbackContext;

	constructor(ctx: ActiveRetryFallbackContext) {
		this.#ctx = ctx;
	}

	/** The role of the currently-active fallback, or `undefined` when none is active. */
	get role(): string | undefined {
		return this.#state?.role;
	}

	clear(): void {
		this.#state = undefined;
	}

	/**
	 * Try to apply a fallback candidate for the role currently associated with
	 * `currentSelector`. Returns `true` when a candidate was applied.
	 */
	async tryFallback(currentSelector: string): Promise<boolean> {
		const role = this.#state?.role ?? this.#ctx.policy.resolveRole(currentSelector);
		if (role === null || role === undefined || role === "") return false;

		for (const selector of this.#ctx.policy.findCandidates(role, currentSelector)) {
			if (this.#ctx.policy.isSelectorSuppressed(selector)) continue;
			const candidate = this.#ctx.modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#ctx.modelRegistry.getApiKey(candidate, this.#ctx.sessionId);
			if (apiKey === null || apiKey === undefined || apiKey === "") continue;
			await this.#applyCandidate(role, selector, currentSelector);
			return true;
		}
		return false;
	}

	async #applyCandidate(role: string, selector: RetryFallbackSelector, currentSelector: string): Promise<void> {
		const candidate = this.#ctx.modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#ctx.modelRegistry.getApiKey(candidate, this.#ctx.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}

		const currentThinkingLevel = this.#ctx.getThinkingLevel();
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;

		this.#ctx.setModelWithReset(candidate);
		this.#ctx.sessionManager.appendModelChange(`${candidate.provider}/${candidate.id}`, "temporary");
		this.#ctx.settings.getStorage()?.recordModelUsage(`${candidate.provider}/${candidate.id}`);
		this.#ctx.setThinkingLevel(nextThinkingLevel);

		if (!this.#state) {
			this.#state = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
			};
		} else {
			this.#state.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
		}

		await this.#ctx.emitFallbackApplied({ from: currentSelector, to: selector.raw, role });
	}

	/**
	 * If a fallback is active and the revert policy is `cooldown-expiry`,
	 * restore the primary selector once its cooldown has lapsed.
	 */
	async maybeRestorePrimary(): Promise<void> {
		if (!this.#state) return;
		if (this.#ctx.policy.getRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#state;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw);
		if (!originalSelector) {
			this.clear();
			return;
		}

		const currentModel = this.#ctx.getModel();
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#ctx.getThinkingLevel());
		if (currentSelector === originalSelector.raw) {
			if (!this.#ctx.policy.isSelectorSuppressed(originalSelector)) {
				this.clear();
			}
			return;
		}
		if (this.#ctx.policy.isSelectorSuppressed(originalSelector)) return;

		const primaryModel = this.#ctx.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#ctx.modelRegistry.getApiKey(primaryModel, this.#ctx.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") return;

		const currentThinkingLevel = this.#ctx.getThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		this.#ctx.setModelWithReset(primaryModel);
		this.#ctx.sessionManager.appendModelChange(`${primaryModel.provider}/${primaryModel.id}`, "temporary");
		this.#ctx.settings.getStorage()?.recordModelUsage(`${primaryModel.provider}/${primaryModel.id}`);
		this.#ctx.setThinkingLevel(thinkingToApply);
		this.clear();
	}
}
