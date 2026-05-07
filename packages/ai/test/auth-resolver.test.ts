import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	rankOAuthSelections,
	requiresOpenAICodexProModel,
	tryOAuthCredential,
	type ResolverContext,
} from "@oh-my-pi/pi-ai/auth-resolver";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth-types";
import type { CredentialRankingStrategy, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";

function makeOAuthCred(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 600_000,
		...overrides,
	};
}

function makeUsageReport(overrides: Partial<UsageReport> = {}): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [],
		...overrides,
	};
}

function makeContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
	const blockedMap = new Map<string, Map<number, number>>();
	return {
		getUsageReport: async () => null,
		isUsageLimitReached: () => false,
		getUsageResetAtMs: () => undefined,
		markCredentialBlocked: (pk, i, until) => {
			const m = blockedMap.get(pk) ?? new Map();
			m.set(i, until);
			blockedMap.set(pk, m);
		},
		replaceCredentialAt: () => {},
		recordSessionCredential: () => {},
		getCredentialBlockedUntil: (pk, i) => blockedMap.get(pk)?.get(i),
		getCredentialsForProvider: () => [],
		usageRequestTimeoutMs: 1_000,
		rawCtrlChar: () => "",
		...overrides,
	};
}

const noopStrategy: CredentialRankingStrategy = {
	findWindowLimits: () => ({ primary: undefined, secondary: undefined }),
	windowDefaults: { primaryMs: 60_000, secondaryMs: 300_000 },
};

describe("requiresOpenAICodexProModel", () => {
	it("matches openai-codex with -spark suffix", () => {
		expect(requiresOpenAICodexProModel("openai-codex", "gpt-5.1-codex-spark")).toBe(true);
		expect(requiresOpenAICodexProModel("openai-codex", "spark-test-spark-v2")).toBe(true);
	});

	it("does not match plain Codex models", () => {
		expect(requiresOpenAICodexProModel("openai-codex", "gpt-5-codex")).toBe(false);
		expect(requiresOpenAICodexProModel("openai-codex", "gpt-5.1-codex")).toBe(false);
	});

	it("does not match non-codex providers even with -spark in id", () => {
		expect(requiresOpenAICodexProModel("openai", "gpt-spark")).toBe(false);
		expect(requiresOpenAICodexProModel("kimi-code", "kimi-spark")).toBe(false);
	});

	it("returns false when modelId is undefined", () => {
		expect(requiresOpenAICodexProModel("openai-codex", undefined)).toBe(false);
	});
});

describe("rankOAuthSelections ordering", () => {
	it("places blocked credentials after unblocked ones", async () => {
		const credentials = [
			{ credential: makeOAuthCred({ access: "a" }), index: 0 },
			{ credential: makeOAuthCred({ access: "b" }), index: 1 },
		];
		const ctx = makeContext({
			getCredentialBlockedUntil: (_pk, i) => (i === 0 ? Date.now() + 60_000 : undefined),
		});
		const ranked = await rankOAuthSelections({
			providerKey: "openai-codex:oauth",
			provider: "openai-codex",
			order: [0, 1],
			credentials,
			strategy: noopStrategy,
			ctx,
		});
		expect(ranked.map(r => r.selection.index)).toEqual([1, 0]);
	});

	it("orders blocked credentials by their unblock time", async () => {
		const credentials = [
			{ credential: makeOAuthCred({ access: "a" }), index: 0 },
			{ credential: makeOAuthCred({ access: "b" }), index: 1 },
		];
		const ctx = makeContext({
			getCredentialBlockedUntil: (_pk, i) => (i === 0 ? Date.now() + 600_000 : Date.now() + 60_000),
		});
		const ranked = await rankOAuthSelections({
			providerKey: "openai-codex:oauth",
			provider: "openai-codex",
			order: [0, 1],
			credentials,
			strategy: noopStrategy,
			ctx,
		});
		expect(ranked.map(r => r.selection.index)).toEqual([1, 0]);
	});

	it("for Spark models, prefers a Pro-plan credential over plus", async () => {
		const credentials = [
			{ credential: makeOAuthCred({ access: "plus" }), index: 0 },
			{ credential: makeOAuthCred({ access: "pro" }), index: 1 },
		];
		const usageByCred = new Map<string, UsageReport | null>([
			["plus", makeUsageReport({ metadata: { planType: "plus" } })],
			["pro", makeUsageReport({ metadata: { planType: "pro" } })],
		]);
		const ctx = makeContext({
			getUsageReport: async (_p, cred) => usageByCred.get((cred as OAuthCredential).access) ?? null,
		});
		const ranked = await rankOAuthSelections({
			providerKey: "openai-codex:oauth",
			provider: "openai-codex",
			order: [0, 1],
			credentials,
			strategy: noopStrategy,
			options: { modelId: "gpt-5.1-codex-spark" },
			ctx,
		});
		expect(ranked.map(r => r.selection.credential.access)).toEqual(["pro", "plus"]);
	});

	it("does not gate on plan tier for non-Spark models", async () => {
		const credentials = [
			{ credential: makeOAuthCred({ access: "plus" }), index: 0 },
			{ credential: makeOAuthCred({ access: "pro" }), index: 1 },
		];
		const usageByCred = new Map<string, UsageReport | null>([
			["plus", makeUsageReport({ metadata: { planType: "plus" } })],
			["pro", makeUsageReport({ metadata: { planType: "pro" } })],
		]);
		const ctx = makeContext({
			getUsageReport: async (_p, cred) => usageByCred.get((cred as OAuthCredential).access) ?? null,
		});
		const ranked = await rankOAuthSelections({
			providerKey: "openai-codex:oauth",
			provider: "openai-codex",
			order: [0, 1],
			credentials,
			strategy: noopStrategy,
			options: { modelId: "gpt-5.1-codex" },
			ctx,
		});
		expect(ranked.map(r => r.selection.credential.access)).toEqual(["plus", "pro"]);
	});

	it("auto-blocks a credential whose usage report shows limit reached", async () => {
		const credentials = [{ credential: makeOAuthCred({ access: "exhausted" }), index: 7 }];
		const blocked: Array<{ pk: string; i: number; until: number }> = [];
		const ctx = makeContext({
			getUsageReport: async () =>
				makeUsageReport({
					limits: [
						{
							id: "openai-codex:primary",
							label: "Primary",
							scope: { provider: "openai-codex" },
							amount: { unit: "percent" },
							status: "exhausted",
							window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000 },
						},
					],
				}),
			isUsageLimitReached: () => true,
			getUsageResetAtMs: () => undefined,
			markCredentialBlocked: (pk, i, until) => blocked.push({ pk, i, until }),
		});

		await rankOAuthSelections({
			providerKey: "openai-codex:oauth",
			provider: "openai-codex",
			order: [0],
			credentials,
			strategy: noopStrategy,
			ctx,
		});

		expect(blocked.length).toBe(1);
		expect(blocked[0]).toMatchObject({ pk: "openai-codex:oauth", i: 7 });
		expect(blocked[0].until).toBeGreaterThan(Date.now());
	});
});

describe("tryOAuthCredential Pro filter", () => {
	beforeEach(() => {
		unregisterOAuthProviders();
		registerOAuthProvider({
			id: "openai-codex",
			name: "OpenAI Codex (test)",
			async login() {
				throw new Error("not used in test");
			},
			async refreshToken(creds) {
				return { ...creds, access: `refreshed:${creds.access}` };
			},
			getApiKey(creds) {
				return creds.access;
			},
		});
	});

	afterEach(() => {
		unregisterOAuthProviders();
	});

	it("rejects non-Pro credential when enforceProRequirement is true", async () => {
		const ctx = makeContext({
			getUsageReport: async () => makeUsageReport({ metadata: { planType: "plus" } }),
		});
		const out = await tryOAuthCredential({
			provider: "openai-codex",
			selection: { credential: makeOAuthCred({ access: "plus-token" }), index: 0 },
			providerKey: "openai-codex:oauth",
			sessionId: undefined,
			options: { modelId: "gpt-5.1-codex" },
			usageOptions: { checkUsage: false, allowBlocked: false, enforceProRequirement: true },
			ctx,
		});
		expect(out).toBeUndefined();
	});

	it("accepts Pro credential when enforceProRequirement is true", async () => {
		const ctx = makeContext({
			getUsageReport: async () => makeUsageReport({ metadata: { planType: "pro" } }),
		});
		const out = await tryOAuthCredential({
			provider: "openai-codex",
			selection: { credential: makeOAuthCred({ access: "pro-token" }), index: 0 },
			providerKey: "openai-codex:oauth",
			sessionId: undefined,
			options: { modelId: "gpt-5.1-codex" },
			usageOptions: { checkUsage: false, allowBlocked: false, enforceProRequirement: true },
			ctx,
		});
		expect(out).toBe("refreshed:pro-token");
	});

	it("auto-applies Pro filter for -spark models without explicit enforceProRequirement", async () => {
		const ctx = makeContext({
			getUsageReport: async () => makeUsageReport({ metadata: { planType: "free" } }),
		});
		const out = await tryOAuthCredential({
			provider: "openai-codex",
			selection: { credential: makeOAuthCred({ access: "free-token" }), index: 0 },
			providerKey: "openai-codex:oauth",
			sessionId: undefined,
			options: { modelId: "gpt-5.1-codex-spark" },
			usageOptions: { checkUsage: false, allowBlocked: false },
			ctx,
		});
		expect(out).toBeUndefined();
	});

	it("returns undefined when the credential is blocked and allowBlocked is false", async () => {
		const ctx = makeContext({
			getCredentialBlockedUntil: () => Date.now() + 60_000,
		});
		const out = await tryOAuthCredential({
			provider: "openai-codex",
			selection: { credential: makeOAuthCred(), index: 0 },
			providerKey: "openai-codex:oauth",
			sessionId: undefined,
			options: undefined,
			usageOptions: { checkUsage: true, allowBlocked: false },
			ctx,
		});
		expect(out).toBeUndefined();
	});
});
