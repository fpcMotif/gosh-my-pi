import type { SearchProvider } from "./providers/base";
import { CodexProvider } from "./providers/codex";
import { KimiProvider } from "./providers/kimi";
import { TavilyProvider } from "./providers/tavily";
import { ZaiProvider } from "./providers/zai";
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
	kimi: new KimiProvider(),
	zai: new ZaiProvider(),
	codex: new CodexProvider(),
	tavily: new TavilyProvider(),
} as const;

export const SEARCH_PROVIDER_ORDER: SearchProviderId[] = ["kimi", "codex", "zai"];

export function getSearchProvider(provider: SearchProviderId): SearchProvider {
	return SEARCH_PROVIDERS[provider];
}

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Determine which providers are configured  */
export async function resolveProviderChain(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	if (preferredProvider !== "auto") {
		if (await getSearchProvider(preferredProvider).isAvailable()) {
			providers.push(getSearchProvider(preferredProvider));
		}
	}

	for (const id of SEARCH_PROVIDER_ORDER) {
		if (id === preferredProvider) continue;

		const provider = getSearchProvider(id);
		if (await provider.isAvailable()) {
			providers.push(provider);
		}
	}

	return providers;
}
