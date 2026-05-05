/** Moonshot login flow (API key paste against https://api.moonshot.ai/v1). */
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthCredentials } from "./types";

export const loginMoonshot = createApiKeyLogin({
	providerLabel: "Moonshot",
	authUrl: "https://platform.moonshot.ai/console/api-keys",
	instructions: "Copy your API key from the Moonshot dashboard",
	promptMessage: "Paste your Moonshot API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		model: "kimi-k2.5",
	},
});

/** Moonshot uses API keys — token refresh is not supported. */
export function refreshMoonshotToken(_refreshToken: string): Promise<OAuthCredentials> {
	return Promise.reject(new Error("Moonshot does not support token refresh"));
}
