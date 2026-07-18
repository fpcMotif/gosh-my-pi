import { describe, expect, it } from "bun:test";
import { type Api, type Model } from "@oh-my-pi/pi-ai";
import { applyRpcModelSelection, buildRpcModelCatalog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fromAny } from "@total-typescript/shoehorn";

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
	resolvedRoleModels?: Record<string, Model<Api> | undefined>;
	resolveRoleModel?: (role: string, candidates: Model<Api>[] | undefined) => Model<Api> | undefined;
}): AgentSession {
	const settings = Settings.isolated({
		modelRoles: options.modelRoles ?? {},
	});
	return fromAny<AgentSession, object>({
		getAvailableModels: () => options.availableModels,
		modelRegistry: {
			getAll: () => options.allModels,
			authStorage: {
				list: () => options.authenticatedProviders,
			},
		},
		settings,
		model: options.current,
		resolveRoleModel: (role: string, candidates?: Model<Api>[]) =>
			options.resolveRoleModel?.(role, candidates) ?? options.resolvedRoleModels?.[role],
	});
}

describe("buildRpcModelCatalog", () => {
	it("returns backend model availability, auth metadata, and role selections", () => {
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

	it("registers the canonical 'kimi-code' id (not legacy 'kimi') as a login-capable built-in provider", () => {
		const kimi = model("kimi-code", "kimi-k2");
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [kimi],
				availableModels: [],
				authenticatedProviders: [],
			}),
		);

		expect(catalog.models).toEqual([
			expect.objectContaining({
				provider: "kimi-code",
				providerName: "Kimi",
				available: false,
				loginSupported: true,
				loginAvailable: true,
			}),
		]);

		const legacyKimi = model("kimi", "kimi-k2");
		const legacyCatalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [legacyKimi],
				availableModels: [],
				authenticatedProviders: [],
			}),
		);
		expect(legacyCatalog.models).toEqual([
			expect.objectContaining({
				provider: "kimi",
				providerName: "kimi",
				loginSupported: false,
				loginAvailable: false,
			}),
		]);
	});

	it("uses the resolved canonical role model while retaining the raw selector", () => {
		const current = model("chatgpt-sub", "gpt-5.5");
		const canonical = model("openai-codex", "gpt-5.3-codex-spark");
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [current, canonical],
				availableModels: [current, canonical],
				authenticatedProviders: [current.provider, canonical.provider],
				current,
				modelRoles: { smol: "legacy-small/fast" },
				resolvedRoleModels: { smol: canonical },
			}),
		);

		expect(catalog.roles).toContainEqual({
			role: "smol",
			selector: "legacy-small/fast",
			provider: canonical.provider,
			modelId: canonical.id,
		});
		expect(catalog.roles).toContainEqual({
			role: "default",
			selector: undefined,
			provider: undefined,
			modelId: undefined,
		});
		expect(catalog.models.find(entry => entry.id === canonical.id)?.roles).toEqual(["smol"]);
	});

	it("resolves unavailable role selectors against the full backend catalog", () => {
		const unavailable = model("openai-codex", "gpt-5.3-codex-spark");
		const catalog = buildRpcModelCatalog(
			sessionStub({
				allModels: [unavailable],
				availableModels: [],
				authenticatedProviders: [],
				modelRoles: { smol: "openai-codex/gpt-5.3-codex-spark" },
				resolveRoleModel: (_role, candidates) => candidates?.find(candidate => candidate.id === unavailable.id),
			}),
		);

		expect(catalog.roles).toContainEqual({
			role: "smol",
			selector: "openai-codex/gpt-5.3-codex-spark",
			provider: unavailable.provider,
			modelId: unavailable.id,
		});
		expect(catalog.models.find(entry => entry.id === unavailable.id)).toMatchObject({
			available: false,
			roles: ["smol"],
		});
	});

	it("assigns smol without replacing the active model", async () => {
		const large = model("chatgpt-sub", "gpt-5.5");
		const small = model("openai-codex", "gpt-5.3-codex-spark");
		let active = large;
		const thinkingLevel = "high";
		const settings = Settings.isolated();
		settings.setModelRole("smol", "openai-codex/previous-small:xhigh");
		const session = fromAny<AgentSession, object>({
			get model() {
				return active;
			},
			thinkingLevel,
			settings,
			getAvailableModels: () => [large, small],
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === small.provider && id === small.id ? small : undefined,
				getAll: () => [large, small],
				authStorage: { list: () => [large.provider, small.provider] },
			},
			setModel: async (next: Model<Api>) => {
				active = next;
			},
			assignModelRole: async (next: Model<Api>, role: string) => {
				settings.setModelRole(role, `${next.provider}/${next.id}:xhigh`);
			},
			resolveRoleModel: () => undefined,
		});

		const result = await applyRpcModelSelection(session, {
			type: "set_model",
			provider: small.provider,
			modelId: small.id,
			role: "smol",
		});

		expect(result).toMatchObject({
			ok: true,
			receipt: {
				...small,
				activeModel: large,
				thinkingLevel,
				assignment: {
					role: "smol",
					selector: "openai-codex/gpt-5.3-codex-spark:xhigh",
					provider: small.provider,
					modelId: small.id,
				},
			},
		});
		expect(active).toBe(large);
		expect(settings.getModelRole("smol")).toBe("openai-codex/gpt-5.3-codex-spark:xhigh");
		const catalog = buildRpcModelCatalog(session);
		expect(catalog.current).toBe(large);
		expect(catalog.models.find(entry => entry.id === small.id)?.roles).toEqual(["smol"]);
	});

	it("rejects blank or padded role keys before mutating session state", async () => {
		const selected = model("openai", "gpt-5");
		let mutations = 0;
		const session = fromAny<AgentSession, object>({
			model: selected,
			thinkingLevel: "high",
			modelRegistry: { find: () => selected },
			setModel: async () => {
				mutations++;
			},
			assignModelRole: async () => {
				mutations++;
			},
		});

		for (const role of ["", " ", " smol", "smol "]) {
			const result = await applyRpcModelSelection(session, {
				type: "set_model",
				provider: selected.provider,
				modelId: selected.id,
				role,
			});
			expect(result).toEqual({
				ok: false,
				error: "Model role must be non-empty and have no surrounding whitespace",
			});
		}

		expect(mutations).toBe(0);
	});
});
