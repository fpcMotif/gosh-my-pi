import type { ModelManagerOptions } from "../model-manager";
import { fetchCodexModels } from "../utils/discovery/codex";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion } = config;
	return {
		providerId: "openai-codex",
		...(accessToken !== null && accessToken !== undefined && accessToken !== ""
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// MiniMax variants (subscription-based, no model listing endpoint)
// ---------------------------------------------------------------------------

export interface MinimaxModelManagerConfig {}

export function minimaxModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "minimax" };
}

export function minimaxCnModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "minimax-cn" };
}

export function minimaxCodeModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	return { providerId: "minimax-code" };
}

export function minimaxCodeCnModelManagerOptions(
	_config: MinimaxModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	return { providerId: "minimax-code-cn" };
}

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}

// ---------------------------------------------------------------------------
// Google providers (stubbed during the in-progress migration)
//
// The dedicated Google provider modules were removed; these stubs preserve
// the option-builder contract so callers in coding-agent (and tests) compile
// and load. Restore the real implementations when re-introducing Google
// provider support.
// ---------------------------------------------------------------------------

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
}

export function googleAntigravityModelManagerOptions(
	_config: GoogleAntigravityModelManagerConfig = {},
): ModelManagerOptions<"openai-responses"> {
	return { providerId: "google-antigravity" };
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
}

export function googleGeminiCliModelManagerOptions(
	_config: GoogleGeminiCliModelManagerConfig = {},
): ModelManagerOptions<"openai-completions"> {
	return { providerId: "google-gemini-cli" };
}

// ---------------------------------------------------------------------------
// Local-token sentinel previously exported by the removed Ollama provider.
// Treated as a placeholder string; consumers compare against it to decide
// whether to send authentication credentials.
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_TOKEN = "local-no-auth";
