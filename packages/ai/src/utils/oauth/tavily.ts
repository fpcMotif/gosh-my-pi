/** Tavily login flow (API key paste against https://app.tavily.com/home). */
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthCredentials } from "./types";

export const loginTavily = createApiKeyLogin({
	providerLabel: "Tavily",
	authUrl: "https://app.tavily.com/home",
	instructions: "Copy your API key from the Tavily dashboard",
	promptMessage: "Paste your Tavily API key",
	placeholder: "tvly-...",
	validation: null,
});

/** Tavily uses API keys — token refresh is not supported. */
export function refreshTavilyToken(_refreshToken: string): Promise<OAuthCredentials> {
	return Promise.reject(new Error("Tavily does not support token refresh"));
}
