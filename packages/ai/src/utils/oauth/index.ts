import { type OAuthCredentials, type OAuthProvider } from "./types";
import { refreshOAuthToken } from "./refresh";

export * from "./types";
export * from "./refresh";
export * from "./callback-server";

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
