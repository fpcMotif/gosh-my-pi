import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-ai/model-thinking";

export * from "@oh-my-pi/pi-agent-core/thinking";

/**
 * Display metadata used to render thinking selector values in the
 * coding-agent UI. Pure presentation — kept here because pi-agent-core
 * has no UI concerns.
 */
export interface ThinkingLevelMetadata {
	value: ThinkingLevel;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevel, ThinkingLevelMetadata> = {
	[ThinkingLevel.Inherit]: {
		value: ThinkingLevel.Inherit,
		label: "inherit",
		description: "Inherit session default",
	},
	[ThinkingLevel.Off]: { value: ThinkingLevel.Off, label: "off", description: "No reasoning" },
	[ThinkingLevel.Minimal]: {
		value: ThinkingLevel.Minimal,
		label: "min",
		description: "Very brief reasoning (~1k tokens)",
	},
	[ThinkingLevel.Low]: { value: ThinkingLevel.Low, label: "low", description: "Light reasoning (~2k tokens)" },
	[ThinkingLevel.Medium]: {
		value: ThinkingLevel.Medium,
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	[ThinkingLevel.High]: { value: ThinkingLevel.High, label: "high", description: "Deep reasoning (~16k tokens)" },
	[ThinkingLevel.XHigh]: {
		value: ThinkingLevel.XHigh,
		label: "xhigh",
		description: "Maximum reasoning (~32k tokens)",
	},
};

/** Returns display metadata for a thinking selector. */
export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

const EFFORT_LEVELS = new Set<string>(THINKING_EFFORTS);

/**
 * Parse a CLI-input string into an {@link Effort}, or undefined when the
 * input is not a recognized provider-facing effort level.
 *
 * Stays in coding-agent because it parses CLI input — pi-ai expects typed
 * `Effort` values at its API boundary.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return value !== undefined && value !== null && EFFORT_LEVELS.has(value) ? (value as Effort) : undefined;
}
