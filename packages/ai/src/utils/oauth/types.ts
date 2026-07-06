export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
};

export type OAuthProvider =
	| "kagi"
	| "kimi"
	| "kimi-code"
	| "minimax-code"
	| "minimax-code-cn"
	| "moonshot"
	| "openai-codex"
	| "parallel"
	| "tavily"
	| "zai";

export type OAuthProviderId = OAuthProvider | (string & {});

// "kimi" was a legacy alias for the Kimi Code plan; models.json and the model
// registry key credentials on "kimi-code", so storage must use the canonical id.
const LEGACY_OAUTH_PROVIDER_ALIASES: Record<string, OAuthProvider> = { kimi: "kimi-code" };

export function canonicalOAuthProviderId(p: string): string {
	return LEGACY_OAUTH_PROVIDER_ALIASES[p] ?? p;
}

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}

export interface OAuthController {
	onAuth?(info: OAuthAuthInfo): void;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onPrompt?(prompt: OAuthPrompt): Promise<string>;
	signal?: AbortSignal;
}

export interface OAuthLoginCallbacks extends OAuthController {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	readonly available?: boolean;
	readonly sourceId?: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
	refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey?(credentials: OAuthCredentials): string;
}
