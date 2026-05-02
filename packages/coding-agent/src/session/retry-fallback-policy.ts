import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { calculateRateLimitBackoffMs, parseRateLimitReason, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, parseModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";

export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ThinkingLevel | undefined;
}

export function parseRetryFallbackSelector(selector: string): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed);
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	const selector = formatModelString(model);
	return thinkingLevel !== undefined ? `${selector}:${thinkingLevel}` : selector;
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

export interface RetryFallbackPolicyOptions {
	settings: Settings;
	modelRegistry: ModelRegistry;
}

export class RetryFallbackPolicy {
	constructor(private readonly options: RetryFallbackPolicyOptions) {}

	getChains(): RetryFallbackChains {
		const configuredChains = this.options.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		return configuredChains as RetryFallbackChains;
	}

	validateChains(): string[] {
		const warnings: string[] = [];
		const warn = (message: string) => {
			logger.warn(message);
			warnings.push(message);
		};

		const configuredChains = this.options.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return warnings;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			warn("retry.fallbackChains must be a mapping of role names to selector arrays.");
			return warnings;
		}

		for (const [role, chain] of Object.entries(configuredChains as Record<string, unknown>)) {
			if (!Array.isArray(chain)) {
				warn(`Fallback chain for role '${role}' must be an array of selector strings.`);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					warn(`Fallback chain for role '${role}' contains a non-string selector.`);
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr);
				if (!parsed) {
					warn(`Invalid fallback selector format in role '${role}': ${selectorStr}`);
					continue;
				}
				const exists = this.options.modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					warn(`Fallback chain for role '${role}' references unknown model: ${selectorStr}`);
				}
			}
		}
		return warnings;
	}

	getRevertPolicy(): RetryFallbackRevertPolicy {
		return this.options.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	getPrimarySelector(role: string): RetryFallbackSelector | undefined {
		const configuredSelector = this.options.settings.getModelRole(role);
		return configuredSelector !== null && configuredSelector !== undefined && configuredSelector !== ""
			? parseRetryFallbackSelector(configuredSelector)
			: undefined;
	}

	isSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.options.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	noteCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (cooldownMs === null || cooldownMs === undefined || cooldownMs === 0 || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.options.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	resolveRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		if (!parsedCurrent) return undefined;
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		for (const role of Object.keys(this.getChains())) {
			const primarySelector = this.getPrimarySelector(role);
			if (!primarySelector) continue;
			if (primarySelector.raw === currentSelector) return role;
			if (formatRetryFallbackBaseSelector(primarySelector) === currentBaseSelector) return role;
		}
		return undefined;
	}

	findCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		const chain = this.#getEffectiveChain(role);
		if (chain.length <= 1) return [];
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const exactIndex = chain.findIndex(selector => selector.raw === currentSelector);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex =
			currentBaseSelector !== null && currentBaseSelector !== undefined && currentBaseSelector !== ""
				? chain.findIndex(selector => formatRetryFallbackBaseSelector(selector) === currentBaseSelector)
				: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	#getEffectiveChain(role: string): RetryFallbackSelector[] {
		const primarySelector = this.getPrimarySelector(role);
		if (!primarySelector) return [];
		const chain = [primarySelector];
		const seen = new Set<string>([primarySelector.raw]);
		for (const selector of this.getChains()[role] ?? []) {
			const parsed = parseRetryFallbackSelector(selector);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}
}
