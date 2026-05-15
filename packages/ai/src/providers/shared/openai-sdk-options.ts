// Shared defaults for the upstream OpenAI Node SDK client across pi-ai's
// non-codex providers. The SDK exposes its own internal retry/backoff layer;
// pi-ai's Effect-based retry policies sit above this for orchestration
// concerns (turn replay, credential rotation) while leaving the SDK's
// transient HTTP retry on by default.

import type OpenAI from "openai";

const DEFAULT_OPENAI_SDK_RETRIES = 5;

export interface OpenAiSdkOptionsInput {
	readonly apiKey: string;
	readonly baseUrl: string | undefined;
	readonly defaultHeaders: Record<string, string>;
	readonly fetch?: typeof fetch;
}

/**
 * Build the constructor argument for `new OpenAI(...)` with project-wide
 * defaults. Callers stay free to add their own keys to the returned object
 * before constructing the client.
 */
export function buildOpenAiSdkOptions(input: OpenAiSdkOptionsInput): ConstructorParameters<typeof OpenAI>[0] {
	const options: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: input.apiKey,
		baseURL: input.baseUrl,
		dangerouslyAllowBrowser: true,
		maxRetries: DEFAULT_OPENAI_SDK_RETRIES,
		defaultHeaders: input.defaultHeaders,
	};
	if (input.fetch !== undefined) {
		options.fetch = input.fetch;
	}
	return options;
}
