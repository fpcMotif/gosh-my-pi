import type { Model, OpenAICompat } from "../types";

type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

export type ResolvedOpenAICompat = Required<
	Omit<OpenAICompat, "openRouterRouting" | "vercelGatewayRouting" | "extraBody" | "toolStrictMode">
> & {
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
	extraBody?: OpenAICompat["extraBody"];
	toolStrictMode: ResolvedToolStrictMode;
};

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (provider === "openai") {
		return true;
	}

	const normalizedBaseUrl = baseUrl.toLowerCase();
	return (
		normalizedBaseUrl.includes("api.openai.com") ||
		normalizedBaseUrl.includes(".openai.azure.com") ||
		normalizedBaseUrl.includes("models.inference.ai.azure.com")
	);
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 */
export function detectOpenAICompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	const provider = model.provider;
	const baseUrl = resolvedBaseUrl ?? model.baseUrl;

	const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
	const isKimiModel = model.id.includes("moonshotai/kimi") || /^kimi[-.]/i.test(model.id);

	const isNonStandard = isZai;

	const reasoningEffortMap: NonNullable<OpenAICompat["reasoningEffortMap"]> = {};

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: !isNonStandard,
		supportsReasoningEffort: !isZai,
		reasoningEffortMap,
		supportsUsageInStreaming: true,
		disableReasoningOnForcedToolChoice: isKimiModel,
		supportsToolChoice: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		thinkingFormat: isZai ? "zai" : "openai",
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls: isKimiModel,
		requiresAssistantContentForToolCalls: isKimiModel,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: undefined,
		toolStrictMode: "mixed",
	};
}

/**
 * Resolve compatibility settings by layering explicit model.compat overrides onto
 * the detected defaults.
 */
export function resolveOpenAICompat(
	model: Model<"openai-completions">,
	resolvedBaseUrl?: string,
): ResolvedOpenAICompat {
	const detected = detectOpenAICompat(model, resolvedBaseUrl);
	if (!model.compat) {
		return detected;
	}

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsToolChoice: model.compat.supportsToolChoice ?? detected.supportsToolChoice,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		reasoningContentField: model.compat.reasoningContentField ?? detected.reasoningContentField,
		requiresReasoningContentForToolCalls:
			model.compat.requiresReasoningContentForToolCalls ?? detected.requiresReasoningContentForToolCalls,
		requiresAssistantContentForToolCalls:
			model.compat.requiresAssistantContentForToolCalls ?? detected.requiresAssistantContentForToolCalls,
		disableReasoningOnForcedToolChoice:
			model.compat.disableReasoningOnForcedToolChoice ?? detected.disableReasoningOnForcedToolChoice,
		openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		extraBody: model.compat.extraBody,
		toolStrictMode: model.compat.toolStrictMode ?? detected.toolStrictMode,
	};
}
