/**
 * Unified provider descriptors — single source of truth for provider metadata
 * used by both runtime model discovery (model-registry.ts) and catalog
 * generation (generate-models.ts).
 */
import type { ModelManagerOptions } from "../model-manager";
import type { Api, KnownProvider } from "../types";
import type { OAuthProvider } from "../utils/oauth/types";
import { kimiCodeModelManagerOptions } from "./openai-compat";
import { zaiModelManagerOptions } from "./special";

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/** Environment variables to check for API keys during catalog generation. */
	envVars: string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: OAuthProvider;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: KnownProvider;
	createModelManagerOptions(config: { apiKey?: string; baseUrl?: string }): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery !== undefined && d.catalogDiscovery !== null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

function catalogDescriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	catalogDiscovery: CatalogDiscoveryConfig,
	options: Pick<ProviderDescriptor, "allowUnauthenticated"> = {},
): ProviderDescriptor {
	return {
		providerId,
		defaultModel,
		createModelManagerOptions,
		catalogDiscovery,
		...options,
	};
}

function catalog(
	label: string,
	envVars: string[],
	options: Pick<CatalogDiscoveryConfig, "oauthProvider" | "allowUnauthenticated"> = {},
): CatalogDiscoveryConfig {
	return {
		label,
		envVars,
		...options,
	};
}

/**
 * Standard providers participating in runtime model discovery and catalog generation.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
	catalogDescriptor(
		"kimi-code",
		"kimi-k2.5",
		config => kimiCodeModelManagerOptions(config),
		catalog("Kimi Code", ["KIMI_API_KEY"], { oauthProvider: "kimi" }),
	),
	catalogDescriptor(
		"zai",
		"glm-5.1",
		config => zaiModelManagerOptions(config),
		catalog("zAI", ["ZAI_API_KEY"], { oauthProvider: "zai" }),
	),
] as const;

/** Default model IDs for all known providers, built from descriptors + special providers. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = {
	...Object.fromEntries(PROVIDER_DESCRIPTORS.map(d => [d.providerId, d.defaultModel])),
	// Providers not in PROVIDER_DESCRIPTORS (special auth or no standard discovery)
	openai: "gpt-5.4",
	"openai-codex": "gpt-5.4",
	moonshot: "moonshot-v1-128k",
	minimax: "MiniMax-M2.5",
	"minimax-code": "MiniMax-M2.5",
	"minimax-code-cn": "MiniMax-M2.5",
} as unknown as Record<KnownProvider, string>;
