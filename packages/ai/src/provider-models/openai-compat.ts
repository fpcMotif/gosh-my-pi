import { type Api, type Model } from "../types";

/** Model-dev capability types */
export type ModelsDevModality = "text" | "image" | "audio" | "video";

export interface ModelsDevModel {
	name?: string;
	description?: string;
	context_window?: number;
	max_output_tokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: ModelsDevModality[];
		output?: ModelsDevModality[];
	};
	tool_call?: boolean;
	reasoning?: boolean;
	pricing?: {
		input?: number;
		output?: number;
	};
}

export interface ModelsDevProviderDescriptor {
	modelsDevKey: string;
	providerId: string;
	api: Api;
	baseUrl: string;
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	resolveApi?: (modelId: string, model: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

export const UNK_CONTEXT_WINDOW = 0;
export const UNK_MAX_TOKENS = 0;

/** Generic mapper that converts models.dev data using provider descriptors. */
export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			const mapped = mapModelsDevEntry(modelId, rawModel, desc);
			if (mapped !== null && mapped !== undefined) {
				models.push(mapped);
			}
		}
	}
	return models;
}

function mapModelsDevEntry(modelId: string, rawModel: unknown, desc: ModelsDevProviderDescriptor): Model<Api> | null {
	if (!isRecord(rawModel)) return null;
	const m = rawModel as ModelsDevModel;

	if (!shouldIncludeModel(modelId, m, desc)) return null;

	const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
	if (resolved === null || resolved === undefined) return null;

	return {
		id: modelId,
		name: toModelName(m.name, modelId),
		api: resolved.api,
		provider: desc.providerId as Model<Api>["provider"],
		baseUrl: resolved.baseUrl,
		reasoning: m.reasoning === true,
		input: toInputCapabilities(m.modalities?.input),
		cost: getModelCost(m),
		contextWindow: m.context_window ?? UNK_CONTEXT_WINDOW,
		maxTokens: m.max_output_tokens ?? UNK_MAX_TOKENS,
	};
}

function shouldIncludeModel(modelId: string, m: ModelsDevModel, desc: ModelsDevProviderDescriptor): boolean {
	if (desc.filterModel) {
		return desc.filterModel(modelId, m);
	}
	return m.tool_call === true;
}

function getModelCost(m: ModelsDevModel) {
	return {
		input: toNumber(m.cost?.input) ?? 0,
		output: toNumber(m.cost?.output) ?? 0,
		cacheRead: toNumber(m.cost?.cache_read) ?? 0,
		cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
	};
}

function toModelName(name: string | undefined, id: string): string {
	return name !== undefined && name !== null && name.length > 0 ? name : id;
}

function toInputCapabilities(modalities: ModelsDevModality[] | undefined): Model<Api>["input"] {
	const input: Model<Api>["input"] = ["text"];
	if (modalities?.includes("image") === true) {
		input.push("image");
	}
	return input;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toNumber(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Provider Specific Options
// ---------------------------------------------------------------------------

import { fetchOpenAICompatibleModels } from "../utils/discovery/openai-compatible";
import type { ModelManagerOptions } from "../model-manager";
import type {
	OpenAICompatibleModelEntry as OpenAICompatibleModelRecord,
	OpenAICompatibleModelMapperContext,
} from "../utils/discovery/openai-compatible";

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: Model<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): Model<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							name: typeof entry.display_name === "string" ? entry.display_name : defaults.name,
							reasoning: entry.supports_reasoning === true || id.includes("thinking"),
							input: entry.supports_image_in === true || id.includes("k2.5") ? ["text", "image"] : ["text"],
							contextWindow: typeof entry.context_length === "number" ? entry.context_length : 262144,
							maxTokens: 32000,
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
				}),
		}),
	};
}

/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	// --- OpenAI ---
	{
		modelsDevKey: "openai",
		providerId: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
	},
	// --- Moonshot ---
	{
		modelsDevKey: "moonshot",
		providerId: "moonshot",
		api: "openai-completions",
		baseUrl: "https://api.moonshot.ai/v1",
	},
	// --- MiniMax (Anthropic-compatible) ---
	{
		modelsDevKey: "minimax",
		providerId: "minimax",
		api: "openai-completions", // User wants to keep it, but we removed anthropic-messages. Minimax also has OpenAI compat.
		baseUrl: "https://api.minimax.io/v1",
	},
];
