import { refreshKimiToken } from "./kimi";
import { refreshMinimaxCodeToken } from "./minimax-code";
import { refreshMoonshotToken } from "./moonshot";
import { refreshOpenAICodexToken } from "./openai-codex";
import { refreshZaiToken } from "./zai";
import type { OAuthCredentials, OAuthProvider } from "./types";

/**
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;

	switch (provider) {
		case "openai-codex":
			newCredentials = await refreshOpenAICodexToken(credentials.refresh);
			break;
		case "kimi":
			newCredentials = await refreshKimiToken(credentials.refresh);
			break;
		case "minimax-code":
			newCredentials = await refreshMinimaxCodeToken(credentials.refresh);
			break;
		case "moonshot":
			newCredentials = await refreshMoonshotToken(credentials.refresh);
			break;
		case "zai":
			newCredentials = await refreshZaiToken(credentials.refresh);
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}

	return newCredentials;
}
