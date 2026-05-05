import { getBundledModels, type GeneratedProvider } from "./models";
import { type Api, type Model } from "./types";
import { DEFAULT_CACHE_TTL_MS, readModelCache, writeModelCache } from "./model-cache";
import { isRecord } from "./utils";

export type ModelRefreshStrategy = "online-if-uncached" | "online" | "offline";

export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	providerId: string;
	staticModels?: Model<TApi>[];
	fetchDynamicModels?: () => Promise<Model<TApi>[] | null>;
	modelsDevKey?: string;
	mapModelsDev?: (payload: TModelsDevPayload) => Model<TApi>[];
	cacheTtlMs?: number;
	cacheDbPath?: string;
	now?: () => number;
}

export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
}

/**
 * Stateful facade over provider model resolution.
 */
export interface ModelManager<TApi extends Api = Api> {
	refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}

/**
 * Creates a reusable provider model manager.
 */
export function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): ModelManager<TApi> {
	return {
		refresh(strategy: ModelRefreshStrategy = "online-if-uncached") {
			return resolveProviderModels(options, strategy);
		},
	};
}

/**
 * Resolve available models for a provider using static, cached, and remote sources.
 */
export async function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const dbPath = options.cacheDbPath;

	const staticModels = normalizeModelList<TApi>(
		options.staticModels ?? getBundledModels(options.providerId as GeneratedProvider),
	);
	const cache = readModelCache<TApi>(options.providerId, ttlMs, now, dbPath);

	const dynamicFetcher = options.fetchDynamicModels;
	const hasDynamicFetcher = typeof dynamicFetcher === "function";
	const hasAuthoritativeCache = (cache?.authoritative ?? false) || !hasDynamicFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;

	const shouldFetchFromNetwork = shouldFetchRemoteSources(
		strategy,
		cache?.fresh ?? false,
		hasAuthoritativeCache,
		cacheAgeMs,
	);

	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await fetchRemoteModels(options, dynamicFetcher)
		: [null, null];

	const modelsDevModels = normalizeModelList<TApi>(fetchedModelsDevModels ?? []);
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;

	const resultModels = buildResultModels(staticModels, modelsDevModels, fetchedDynamicModels, cache);

	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && (cache?.fresh ?? false) && hasAuthoritativeCache;
	const dynamicAuthoritative = !hasDynamicFetcher || dynamicFetchSucceeded || shouldUseFreshCacheAsAuthoritative;

	if (shouldFetchFromNetwork) {
		updateModelCache(
			options,
			now(),
			staticModels,
			modelsDevModels,
			dynamicModelsFromFetched(fetchedDynamicModels),
			dynamicFetchSucceeded,
			cache,
			dbPath,
		);
	}

	return {
		models: resultModels,
		stale: !dynamicAuthoritative,
	};
}

function dynamicModelsFromFetched<TApi extends Api>(fetched: Model<TApi>[] | null): Model<TApi>[] {
	return fetched ?? [];
}

function buildResultModels<TApi extends Api>(
	staticModels: Model<TApi>[],
	modelsDevModels: Model<TApi>[],
	fetchedDynamicModels: Model<TApi>[] | null,
	cache: any,
): Model<TApi>[] {
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const cacheModels = dynamicFetchSucceeded ? [] : normalizeModelList<TApi>(cache?.models ?? []);
	const dynamicModels = fetchedDynamicModels ?? [];

	const mergedWithCache = mergeDynamicModels(mergeModelSources(staticModels, modelsDevModels), cacheModels);
	return mergeDynamicModels(mergedWithCache, dynamicModels);
}

async function fetchRemoteModels<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	dynamicFetcher?: () => Promise<Model<TApi>[] | null>,
): Promise<[Model<TApi>[] | null, Model<TApi>[] | null]> {
	return Promise.all([fetchModelsDev(options), dynamicFetcher ? dynamicFetcher() : Promise.resolve(null)]);
}

function updateModelCache<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	timestamp: number,
	staticModels: Model<TApi>[],
	modelsDevModels: Model<TApi>[],
	dynamicModels: Model<TApi>[],
	dynamicFetchSucceeded: boolean,
	cache: any,
	dbPath?: string,
) {
	const baseModels = mergeModelSources(staticModels, modelsDevModels);
	if (dynamicFetchSucceeded) {
		const snapshotModels = mergeDynamicModels(baseModels, dynamicModels);
		writeModelCache(options.providerId, timestamp, snapshotModels, true, dbPath);
	} else {
		const cacheModels = normalizeModelList<TApi>(cache?.models ?? []);
		writeModelCache(options.providerId, timestamp, mergeDynamicModels(baseModels, cacheModels), false, dbPath);
	}
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): Promise<Model<TApi>[] | null> {
	if (
		options.modelsDevKey === undefined ||
		options.modelsDevKey === null ||
		options.modelsDevKey === "" ||
		options.mapModelsDev === undefined ||
		options.mapModelsDev === null
	) {
		return null;
	}

	try {
		const response = await fetch("https://models.dev/api/models");
		if (!response.ok) return null;
		const payload = (await response.json()) as TModelsDevPayload;
		return options.mapModelsDev(payload);
	} catch {
		return null;
	}
}

function shouldFetchRemoteSources(
	strategy: ModelRefreshStrategy,
	isCacheFresh: boolean,
	isCacheAuthoritative: boolean,
	cacheAgeMs: number,
): boolean {
	if (strategy === "offline") return false;
	if (strategy === "online") return true;
	if (isCacheFresh === false) return true;
	if (isCacheAuthoritative === false) return true;
	return false;
}

function normalizeModelList<TApi extends Api>(models: unknown): Model<TApi>[] {
	if (Array.isArray(models) === false) return [];
	return (models as unknown[]).filter(isModelLike) as Model<TApi>[];
}

function mergeModelSources<TApi extends Api>(left: Model<TApi>[], right: Model<TApi>[]): Model<TApi>[] {
	const merged = new Map<string, Model<TApi>>();
	for (const m of left) merged.set(m.id, m);
	for (const m of right) merged.set(m.id, m);
	return Array.from(merged.values());
}

function mergeDynamicModels<TApi extends Api>(base: Model<TApi>[], dynamic: Model<TApi>[]): Model<TApi>[] {
	const merged = new Map<string, Model<TApi>>();
	for (const m of base) merged.set(m.id, m);
	for (const m of dynamic) merged.set(m.id, m);
	return Array.from(merged.values());
}

function isModelLike(value: unknown): value is Model<Api> {
	if (isRecord(value) === false) return false;
	const m = value as any;
	return (
		typeof m.id === "string" &&
		m.id.length > 0 &&
		typeof m.name === "string" &&
		m.name.length > 0 &&
		typeof m.api === "string" &&
		m.api.length > 0 &&
		typeof m.provider === "string" &&
		m.provider.length > 0 &&
		typeof m.baseUrl === "string" &&
		m.baseUrl.length > 0 &&
		typeof m.reasoning === "boolean" &&
		isModelInputArray(m.input) &&
		isModelCost(m.cost) &&
		isModelLimitsValid(m)
	);
}

function isModelLimitsValid(m: any): boolean {
	return (
		typeof m.contextWindow === "number" &&
		Number.isFinite(m.contextWindow) &&
		m.contextWindow > 0 &&
		typeof m.maxTokens === "number" &&
		Number.isFinite(m.maxTokens) &&
		m.maxTokens > 0
	);
}

function isModelInputArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(v => v === "text" || v === "image" || v === "audio" || v === "video");
}

function isModelCost(value: unknown): boolean {
	if (isRecord(value) === false) return false;
	const c = value as any;
	return (
		typeof c.input === "number" &&
		typeof c.output === "number" &&
		typeof c.cacheRead === "number" &&
		typeof c.cacheWrite === "number"
	);
}
