import { clampThinkingLevelForModel, Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-ai/model-thinking";
import type { Model } from "@oh-my-pi/pi-ai/types";

/**
 * Agent-local thinking selector.
 *
 * `off` disables reasoning, while `inherit` defers to a higher-level selector.
 */
export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: Effort.Minimal,
	Low: Effort.Low,
	Medium: Effort.Medium,
	High: Effort.High,
	XHigh: Effort.XHigh,
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ResolvedThinkingLevel = Exclude<ThinkingLevel, "inherit">;

const THINKING_LEVELS = new Set<string>([ThinkingLevel.Inherit, ThinkingLevel.Off, ...THINKING_EFFORTS]);

/**
 * Parse a string into a {@link ThinkingLevel}, or return undefined when the
 * input does not match any known level. Accepts `"inherit"`, `"off"`, and any
 * `Effort` value.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return value !== undefined && value !== null && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

/**
 * Convert a session-level {@link ThinkingLevel} into the provider-facing
 * {@link Effort}. Returns undefined for `"off"` and `"inherit"` (callers
 * should omit the reasoning field rather than send it).
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

/**
 * Resolve a {@link ThinkingLevel} against the current model:
 * - `"inherit"` → undefined (defer to caller)
 * - `"off"` → preserved as `"off"`
 * - any Effort → clamped against the model's supported range
 *
 * Pure: does not mutate `model` and does not log.
 */
export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	return clampThinkingLevelForModel(model, level);
}
