/** Kagi login flow (API key paste against https://kagi.com/settings?p=api). */
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthCredentials } from "./types";

export const loginKagi = createApiKeyLogin({
	providerLabel: "Kagi",
	authUrl: "https://kagi.com/settings?p=api",
	instructions: "Copy your API key from Kagi settings",
	promptMessage: "Paste your Kagi API key",
	placeholder: "...",
	validation: null,
});

/** Kagi uses API keys — token refresh is not supported. */
export function refreshKagiToken(_refreshToken: string): Promise<OAuthCredentials> {
	return Promise.reject(new Error("Kagi does not support token refresh"));
}
