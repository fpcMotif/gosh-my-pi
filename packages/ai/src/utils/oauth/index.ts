import { type OAuthCredentials, type OAuthProvider, type OAuthProviderInterface } from "./types";
import { refreshOAuthToken } from "./refresh";

export * from "./types";
export * from "./refresh";
export * from "./callback-server";

// ─── Custom OAuth Provider Registry ────────────────────────────────────────

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/** Register a custom OAuth provider. */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

/** Unregister all custom OAuth providers. */
export function unregisterOAuthProviders(): void {
	customOAuthProviders.clear();
}

/** Get a custom OAuth provider by id. */
export function getOAuthProvider(id: string): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/** List all registered custom OAuth providers. */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(customOAuthProviders.values());
}

/**
 * Get an API key from OAuth credentials, refreshing if necessary.
 */
export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const creds = credentials[provider];
	if (creds === undefined || creds === null) {
		return null;
	}

	const now = Date.now();
	if (creds.expires > now + 60 * 1000) {
		return { newCredentials: creds, apiKey: creds.access };
	}

	try {
		const refreshed = await refreshOAuthToken(provider, creds);
		return { newCredentials: refreshed, apiKey: refreshed.access };
	} catch {
		return null;
	}
}
