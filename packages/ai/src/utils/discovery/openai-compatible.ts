import { type Api, type Model } from "../../types";
import { normalizeBaseUrl } from "../../utils";

const MODELS_PATH = "/models";
const UNK_CONTEXT_WINDOW = 0;
const UNK_MAX_TOKENS = 0;

export interface OpenAICompatibleModelEntry {
	id: string;
	name?: string;
	[key: string]: unknown;
}

export interface OpenAICompatibleModelMapperContext<TApi extends Api> {
	api: TApi;
	provider: string;
	baseUrl: string;
}

export type OpenAICompatibleModelMapper<TApi extends Api> = (
	entry: OpenAICompatibleModelEntry,
	defaults: Model<TApi>,
	context: OpenAICompatibleModelMapperContext<TApi>,
) => Model<TApi> | null | undefined;

export interface FetchOpenAICompatibleModelsOptions<TApi extends Api> {
	api: TApi;
	provider: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	mapModel?: OpenAICompatibleModelMapper<TApi>;
	filterModel?: (entry: OpenAICompatibleModelEntry, mapped: Model<TApi>) => boolean;
}

/**
 * Fetch available models from an OpenAI-compatible /models endpoint.
 */
export async function fetchOpenAICompatibleModels<TApi extends Api>(
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<Model<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	if (baseUrl === null || baseUrl === undefined || baseUrl === "") return null;

	const payload = await fetchModelPayload(baseUrl, options);
	if (payload === null) return null;

	const entries = extractModelEntries(payload);
	if (entries === null) return null;

	const context: OpenAICompatibleModelMapperContext<TApi> = {
		api: options.api,
		provider: options.provider,
		baseUrl,
	};

	const deduped = mapAndDedupeModels(entries, options, context);
	return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

async function fetchModelPayload<TApi extends Api>(
	baseUrl: string,
	options: FetchOpenAICompatibleModelsOptions<TApi>,
): Promise<unknown> {
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey !== undefined && options.apiKey !== null && options.apiKey !== "") {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}

	const fetchImpl = options.fetch ?? globalThis.fetch;
	try {
		const response = await fetchImpl(`${baseUrl}${MODELS_PATH}`, {
			method: "GET",
			headers: requestHeaders,
			signal: options.signal,
		});

		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

function extractModelEntries(payload: unknown): OpenAICompatibleModelEntry[] | null {
	if (payload !== null && typeof payload === "object") {
		// Response is { data: [...] }
		if ("data" in payload && Array.isArray(payload.data)) {
			return payload.data as OpenAICompatibleModelEntry[];
		}
		// Response is [...]
		if (Array.isArray(payload)) {
			return payload as OpenAICompatibleModelEntry[];
		}
	}
	return null;
}

function mapAndDedupeModels<TApi extends Api>(
	entries: OpenAICompatibleModelEntry[],
	options: FetchOpenAICompatibleModelsOptions<TApi>,
	context: OpenAICompatibleModelMapperContext<TApi>,
): Map<string, Model<TApi>> {
	const deduped = new Map<string, Model<TApi>>();
	for (const entry of entries) {
		const mapped = mapSingleModel(entry, options, context);
		if (mapped !== null && mapped !== undefined) {
			deduped.set(mapped.id, mapped);
		}
	}
	return deduped;
}

function mapSingleModel<TApi extends Api>(
	entry: OpenAICompatibleModelEntry,
	options: FetchOpenAICompatibleModelsOptions<TApi>,
	context: OpenAICompatibleModelMapperContext<TApi>,
): Model<TApi> | null {
	const defaults: Model<TApi> = {
		id: entry.id,
		name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
		api: options.api,
		provider: options.provider,
		baseUrl: context.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: UNK_CONTEXT_WINDOW,
		maxTokens: UNK_MAX_TOKENS,
	};

	const mapped = options.mapModel?.(entry, defaults, context) ?? defaults;
	if (mapped === null || mapped === undefined || typeof mapped.id !== "string" || mapped.id.length === 0) {
		return null;
	}
	if (options.filterModel && !options.filterModel(entry, mapped)) {
		return null;
	}
	return mapped;
}
