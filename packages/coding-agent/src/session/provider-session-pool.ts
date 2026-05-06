import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Owns the per-session map of provider-side transport state (the
 * `ProviderSessionState` instances that providers stash here so they can
 * persist long-lived state across turns — e.g. OpenAI Codex Responses needs
 * a stable `previous_response_id` chain). Encapsulates the close-by-reason
 * patterns: close all on dispose / new session, close model-affected ones
 * on model switch, close the Codex-only ones on history-rewrite operations.
 *
 * The {@link state} map is shared with `Agent.providerSessionState` so
 * providers can read/write directly.
 */
export class ProviderSessionPool {
	#state = new Map<string, ProviderSessionState>();

	/** The shared state map. Hand to `Agent.providerSessionState` at construction. */
	get state(): Map<string, ProviderSessionState> {
		return this.#state;
	}

	/** Close every retained provider session. Used on dispose / new session / session switch. */
	closeAll(reason: string): void {
		for (const [providerKey, state] of this.#state) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}
		this.#state.clear();
	}

	/**
	 * Close provider sessions affected by a model switch. Codex Responses
	 * sessions close on any switch involving Codex; OpenAI Responses sessions
	 * close per-provider when the relevant provider model changes.
	 */
	closeForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		for (const providerKey of providerKeys) {
			const state = this.#state.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#state.delete(providerKey);
		}
	}

	/**
	 * Close Codex-specific provider sessions on history-rewrite operations
	 * (compaction, replace-messages, etc). No-op when the current model is
	 * not Codex Responses.
	 */
	closeForCodexHistoryRewrite(currentModel: Model | undefined): void {
		if (!currentModel || currentModel.api !== "openai-codex-responses") return;
		this.closeForModelSwitch(currentModel, currentModel);
	}
}
