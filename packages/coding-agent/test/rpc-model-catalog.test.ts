import { afterEach, describe, expect, it } from "bun:test";
import {
	type Api,
	type Model,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai";
import { buildRpcModelCatalog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function model(provider: string, id: string, input: Model<Api>["input"] = ["text"]): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:10531/v1",
		reasoning: id.startsWith("gpt-5"),
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function sessionStub(options: {
	allModels: Model<Api>[];
	availableModels: Model<Api>[];
	authenticatedProviders: string[];
	current?: Model<Api>;
	modelRoles?: Record<string, string>;
}): AgentSession {
	const settings = Settings.isolated({
		modelRoles: options.modelRoles ?? {},
	});
	return {
		getAvailableModels: () => options.availableModels,
		modelRegistry: {
			getAll: () => options.allModels,
			authStorage: {
				list: () => options.authenticatedProviders,
			},
		},
		settings,
		model: options.current,
	} as unknown as AgentSession;
}

describe("buildRpcModelCatalog", () => {
	afterEach(() => {
		unregisterOAuthProviders();
	});

	it("returns backend model availability, auth metadata, and role selections", () => {
		const provider = {
			id: "openai-codex",
			name: "OpenAI Codex",
			available: true,
			login: async () => "token",
		} satisfies OAuthProviderInterface & { available: boolean };
		registerOAuthProvider(provider);
		const large = model("chatgpt-sub", "gpt-5.5");
		const small = model("openai-codex", "gpt-5.3-codex-spark", ["text", "image"]);
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [large, small],
				availableModels: [large],
				authenticatedProviders: ["chatgpt-sub"],
				current: large,
				modelRoles: {
					default: "chatgpt-sub/gpt-5.5:xhigh",
					smol: "openai-codex/gpt-5.3-codex-spark",
				},
			}),
		);

		const largeEntry = catalog.models.find(entry => entry.provider === "chatgpt-sub" && entry.id === "gpt-5.5");
		expect(largeEntry).toMatchObject({
			available: true,
			authenticated: true,
			current: true,
			roles: ["default"],
		});

		const smallEntry = catalog.models.find(
			entry => entry.provider === "openai-codex" && entry.id === "gpt-5.3-codex-spark",
		);
		expect(smallEntry).toMatchObject({
			providerName: "OpenAI Codex",
			available: false,
			authenticated: false,
			loginSupported: true,
			loginAvailable: true,
			current: false,
			roles: ["smol"],
			supportsImages: true,
		});
		expect(catalog.roles).toContainEqual({
			role: "default",
			selector: "chatgpt-sub/gpt-5.5:xhigh",
			provider: "chatgpt-sub",
			modelId: "gpt-5.5",
		});
	});

	it("keeps unauthenticated non-oauth providers selectable as catalog-only entries", () => {
		const local = model("local-openai", "qwen-local");
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [local],
				availableModels: [local],
				authenticatedProviders: [],
				modelRoles: {
					default: "not a model selector",
				},
			}),
		);

		expect(catalog.models).toEqual([
			expect.objectContaining({
				provider: "local-openai",
				providerName: "local-openai",
				id: "qwen-local",
				available: true,
				authenticated: false,
				loginSupported: false,
				loginAvailable: false,
				roles: [],
			}),
		]);
		expect(catalog.roles).toContainEqual({
			role: "default",
			selector: "not a model selector",
			provider: undefined,
			modelId: undefined,
		});
	});

	it("marks built-in backend auth providers as login-capable", () => {
		const codex = model("openai-codex", "gpt-5.3-codex-spark");
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [codex],
				availableModels: [],
				authenticatedProviders: [],
			}),
		);

		expect(catalog.models).toEqual([
			expect.objectContaining({
				provider: "openai-codex",
				providerName: "OpenAI Codex",
				available: false,
				loginSupported: true,
				loginAvailable: true,
			}),
		]);
	});
});
