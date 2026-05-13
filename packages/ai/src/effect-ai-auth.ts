// pi-ai auth resolution for the Effect 4 OpenAi layer.
//
// Slice 4 — bridges pi-ai's "apiKey ?? env-fallback" + "baseUrl from the
// model registry" pattern onto `OpenAiClient.layer`'s `Options { apiKey,
// apiUrl }` shape.
//
// Scope:
//   - apiKey: option override -> env var (`<PROVIDER>_API_KEY`)
//   - baseUrl: option override -> model.baseUrl
//   - organizationId / projectId: option pass-through (no env fallback yet
//     — pi-ai doesn't currently expose these in the model registry)
//
// Out of scope (later sub-slices of slice 4):
//   - OAuth-backed providers (Kimi, ZAI) whose tokens come from
//     keychain-backed refresh flows in `auth-storage`.
//   - Per-account routing (Copilot, Cursor) that picks an apiKey based on
//     active account.
//   - Compat overrides (per-baseUrl auto-detection of capability flags).

import { getEnvApiKey } from "./stream";
import type { Api, Model } from "./types";

export interface ResolvedOpenAiAuth {
	readonly apiKey: string | undefined;
	readonly baseUrl: string;
	readonly organizationId: string | undefined;
	readonly projectId: string | undefined;
}

export interface ResolveOpenAiAuthOverrides {
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly organizationId?: string;
	readonly projectId?: string;
}

/**
 * Project a pi-ai `Model` + caller overrides onto the four fields
 * `OpenAiClient.layer` needs. Overrides win; `apiKey` falls back to the
 * canonical `<PROVIDER>_API_KEY` env var via `getEnvApiKey`; `baseUrl`
 * falls back to `model.baseUrl` (required on every pi-ai model).
 */
export const resolveOpenAiAuth = <TApi extends Api>(
	model: Model<TApi>,
	overrides: ResolveOpenAiAuthOverrides | undefined,
): ResolvedOpenAiAuth => ({
	apiKey: overrides?.apiKey ?? getEnvApiKey(model.provider),
	baseUrl: overrides?.baseUrl ?? model.baseUrl,
	organizationId: overrides?.organizationId,
	projectId: overrides?.projectId,
});
