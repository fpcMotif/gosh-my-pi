import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { isContextOverflow } from "@oh-my-pi/pi-ai";
import { parseModelString } from "../config/model-resolver";
import type { CompactionSettings } from "../config/settings-schema";
import { calculateContextTokens, shouldCompact } from "./compaction";

export interface ContextPruneResult {
	prunedCount: number;
	tokensSaved: number;
}

export type ContextPressureReason = "overflow" | "threshold";

export type ContextPressureDecision =
	| {
			kind: "promote-or-compact";
			reason: ContextPressureReason;
			willRetry: boolean;
			compactIfPromotionUnavailable: boolean;
			contextTokens?: number;
	  }
	| {
			kind: "skip";
			reason: "aborted" | "disabled" | "non-overflow-error" | "stale-overflow" | "within-threshold";
			contextTokens?: number;
	  };

export interface ContextPressureInput {
	assistantMessage: AssistantMessage;
	currentModel: Model | undefined;
	compactionSettings: CompactionSettings;
	skipAbortedCheck: boolean;
	errorIsFromBeforeCompaction: boolean;
	pruneResult?: ContextPruneResult;
}

function isCurrentModelOverflow(input: ContextPressureInput): boolean {
	const currentModel = input.currentModel;
	if (!currentModel) return false;
	if (input.assistantMessage.provider !== currentModel.provider || input.assistantMessage.model !== currentModel.id) {
		return false;
	}
	return isContextOverflow(input.assistantMessage, currentModel.contextWindow ?? 0);
}

function compactionEnabled(settings: CompactionSettings): boolean {
	return settings.enabled && settings.strategy !== "off";
}

export function shouldPruneForContextPressure(input: Omit<ContextPressureInput, "pruneResult">): boolean {
	if (input.skipAbortedCheck && input.assistantMessage.stopReason === "aborted") return false;
	if (isCurrentModelOverflow(input)) return false;
	if (!compactionEnabled(input.compactionSettings)) return false;
	return input.assistantMessage.stopReason !== "error";
}

export function decideContextPressure(input: ContextPressureInput): ContextPressureDecision {
	if (input.skipAbortedCheck && input.assistantMessage.stopReason === "aborted") {
		return { kind: "skip", reason: "aborted" };
	}

	if (isCurrentModelOverflow(input)) {
		if (input.errorIsFromBeforeCompaction) {
			return { kind: "skip", reason: "stale-overflow" };
		}
		return {
			kind: "promote-or-compact",
			reason: "overflow",
			willRetry: true,
			compactIfPromotionUnavailable: compactionEnabled(input.compactionSettings),
		};
	}

	if (!compactionEnabled(input.compactionSettings)) {
		return { kind: "skip", reason: "disabled" };
	}

	if (input.assistantMessage.stopReason === "error") {
		return { kind: "skip", reason: "non-overflow-error" };
	}

	const contextWindow = input.currentModel?.contextWindow ?? 0;
	const rawContextTokens = calculateContextTokens(input.assistantMessage.usage);
	const contextTokens = Math.max(0, rawContextTokens - (input.pruneResult?.tokensSaved ?? 0));
	if (shouldCompact(contextTokens, contextWindow, input.compactionSettings)) {
		return {
			kind: "promote-or-compact",
			reason: "threshold",
			willRetry: false,
			compactIfPromotionUnavailable: true,
			contextTokens,
		};
	}

	return { kind: "skip", reason: "within-threshold", contextTokens };
}

export function resolveContextPromotionConfiguredTarget(
	currentModel: Model,
	availableModels: readonly Model[],
): Model | undefined {
	const configuredTarget = currentModel.contextPromotionTarget?.trim();
	if (configuredTarget === null || configuredTarget === undefined || configuredTarget === "") return undefined;

	const parsed = parseModelString(configuredTarget);
	if (parsed) {
		const explicitModel = availableModels.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (explicitModel) return explicitModel;
	}

	return availableModels.find(model => model.provider === currentModel.provider && model.id === configuredTarget);
}

export function orderContextPressureModelCandidates(options: {
	availableModels: readonly Model[];
	roleModels: readonly (Model | undefined)[];
}): Model[] {
	const candidates: Model[] = [];
	const seen = new Set<string>();

	const addCandidate = (model: Model | undefined): void => {
		if (!model) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	for (const model of options.roleModels) {
		addCandidate(model);
	}

	const sortedByContext = [...options.availableModels].sort((a, b) => b.contextWindow - a.contextWindow);
	for (const model of sortedByContext) {
		if (!seen.has(`${model.provider}/${model.id}`)) {
			addCandidate(model);
			break;
		}
	}

	return candidates;
}
