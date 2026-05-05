import { type Api, type Model, type ThinkingConfig } from "./types";
import { parseKnownModel, semverEqual, semverGte, type ParsedModel, type OpenAIModel } from "./utils/model-parser";

const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic";

/**
 * Static fallback model injected when Cloudflare AI Gateway discovery
 * returns no results.
 */
export const CLOUDFLARE_FALLBACK_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	contextWindow: 200000,
	maxTokens: 64000,
};

/**
 * Link OpenAI model variants to their context promotion targets.
 *
 * When a model's context is exhausted, the agent can promote to a sibling
 * model with a larger context window on the same provider:
 * - `codex-spark` variants promote to `gpt-5.5`.
 * - `gpt-5.5` (270K input) promotes to `gpt-5.4` (1M input).
 */
export function linkOpenAIPromotionTargets(models: Model<Api>[]): void {
	for (const candidate of models) {
		const parsedCandidate = parseKnownModel(candidate.id);
		if (parsedCandidate.family !== "openai") continue;
		let targetId: string | undefined;
		if (parsedCandidate.variant === "codex-spark") {
			targetId = "gpt-5.5";
		} else if (parsedCandidate.variant === "base" && semverEqual(parsedCandidate.version, "5.5")) {
			targetId = "gpt-5.4";
		} else {
			continue;
		}
		const fallback = models.find(
			m => m.provider === candidate.provider && m.api === candidate.api && m.id === targetId,
		);
		if (!fallback) continue;
		candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}

/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GPT_5_2_PLUS_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

type ApiModel<TApi extends Api> = Pick<Model<TApi>, "api" | "id" | "provider" | "reasoning" | "thinking">;

/**
 * Returns supported thinking efforts from canonical model rules constrained by
 * explicit model metadata.
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (model.reasoning === false) {
		return [];
	}
	if (model.thinking === undefined || model.thinking === null) {
		return DEFAULT_REASONING_EFFORTS;
	}
	const configuredEfforts = expandEffortRange(model.thinking);
	const parsedModel = parseKnownModel(model.id);
	if (parsedModel.family === "unknown") {
		return configuredEfforts;
	}
	return intersectEfforts(configuredEfforts, inferSupportedEfforts(parsedModel));
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (model === undefined || model === null) {
		return requested;
	}
	if (model.reasoning === false || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (model.reasoning === false) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (levels.includes(effort) === false) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

export function enrichModelThinking<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const normalizedThinking = normalizeThinkingConfig(model.thinking);
	if (model.reasoning === false) {
		return normalizedThinking === undefined && model.thinking === undefined
			? model
			: { ...model, thinking: undefined };
	}

	const thinking =
		normalizedThinking !== undefined && normalizedThinking !== null ? normalizedThinking : inferModelThinking(model);
	if (thinkingsEqual(normalizedThinking, thinking)) {
		return model;
	}
	return { ...model, thinking };
}

export function refreshModelThinking<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if (model.reasoning === false) {
		const normalizedThinking = normalizeThinkingConfig(model.thinking);
		return normalizedThinking === undefined && model.thinking === undefined
			? model
			: { ...model, thinking: undefined };
	}
	return { ...model, thinking: inferModelThinking(model) };
}

export function applyGeneratedModelPolicies(models: Model<Api>[]): void {
	for (let index = 0; index < models.length; index++) {
		const modelEntry = models[index];
		if (modelEntry !== undefined && modelEntry !== null) {
			const model = refreshModelThinking(modelEntry);
			applyGeneratedModelPolicy(model);
			models[index] = model;
		}
	}
}

function applyGeneratedModelPolicy(_model: Model<Api>): void {
	// Provider-specific catalog policies (e.g. context window adjustments)
}

function inferModelThinking<TApi extends Api>(model: ApiModel<TApi>): ThinkingConfig {
	const parsedModel = parseKnownModel(model.id);
	const efforts = inferSupportedEfforts(parsedModel);
	const minLevel = efforts[0];
	const maxLevel = efforts.at(-1);
	if (minLevel === undefined || minLevel === null || maxLevel === undefined || maxLevel === null) {
		throw new Error(`Model ${model.provider}/${model.id} resolved to an empty thinking range`);
	}
	return {
		mode: inferThinkingControlMode(model, parsedModel),
		minLevel,
		maxLevel,
	};
}

function normalizeThinkingConfig(thinking: ThinkingConfig | undefined): ThinkingConfig | undefined {
	if (thinking === undefined || thinking === null || expandEffortRange(thinking).length === 0) {
		return undefined;
	}
	return thinking;
}

function thinkingsEqual(left: ThinkingConfig | undefined, right: ThinkingConfig | undefined): boolean {
	if (left === right) return true;
	if (left === undefined || left === null || right === undefined || right === null) return false;
	return left.mode === right.mode && left.minLevel === right.minLevel && left.maxLevel === right.maxLevel;
}

function expandEffortRange(thinking: ThinkingConfig): readonly Effort[] {
	const minIndex = THINKING_EFFORTS.indexOf(thinking.minLevel);
	const maxIndex = THINKING_EFFORTS.indexOf(thinking.maxLevel);
	if (minIndex === -1 || maxIndex === -1 || minIndex > maxIndex) {
		return [];
	}
	return THINKING_EFFORTS.slice(minIndex, maxIndex + 1);
}

function intersectEfforts(left: readonly Effort[], right: readonly Effort[]): readonly Effort[] {
	return left.filter(effort => right.includes(effort));
}

function inferSupportedEfforts(parsedModel: ParsedModel): readonly Effort[] {
	switch (parsedModel.family) {
		case "openai":
			return inferOpenAISupportedEfforts(parsedModel);
		default:
			return DEFAULT_REASONING_EFFORTS;
	}
}

function inferOpenAISupportedEfforts(model: OpenAIModel): readonly Effort[] {
	if (semverGte(model.version, "5.2")) {
		return GPT_5_2_PLUS_EFFORTS;
	}
	return DEFAULT_REASONING_EFFORTS;
}

export function inferThinkingControlMode<TApi extends Api>(
	_model: { api: string; id: string },
	_parsedModel: ParsedModel,
): ThinkingConfig["mode"] {
	return "effort";
}

/**
 * Extract model ID from full resource name.
 */
export function extractModelId(modelId: string): string {
	const p = modelId.lastIndexOf("/");
	return p === -1 ? modelId : modelId.slice(p + 1);
}

/**
 * Finalize an error message for an assistant response.
 */
export async function finalizeErrorMessage(
	error: unknown,
	requestDump: string | undefined,
	errorResponse?: Response,
): Promise<string> {
	let message = error instanceof Error ? error.message : String(error);
	if (errorResponse !== undefined && errorResponse !== null) {
		try {
			const body = await errorResponse.text();
			if (body !== undefined && body !== null && body.length > 0) {
				message = `${message}\n\nServer Response: ${body}`;
			}
		} catch {
			// Ignore read errors
		}
	}
	if (requestDump !== undefined && requestDump !== null && requestDump.length > 0) {
		message = `${message}\n\nRequest Context: ${requestDump}`;
	}
	return message;
}

/**
 * Utility for tracking abort signal state across async boundaries.
 */
export class AbortTracker {
	#aborted = false;
	#signal?: AbortSignal;

	constructor(signal?: AbortSignal) {
		this.#signal = signal;
		if (signal !== undefined && signal.aborted) {
			this.#aborted = true;
		} else {
			signal?.addEventListener(
				"abort",
				() => {
					this.#aborted = true;
				},
				{ once: true },
			);
		}
	}

	get aborted(): boolean {
		return this.#aborted;
	}

	wasCallerAbort(): boolean {
		return this.#aborted && this.#signal !== undefined && this.#signal.aborted;
	}
}
