import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "../src/auth-storage";
import type { Provider } from "../src/types";
import type { UsageCredential, UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../src/usage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";

describe("AuthStorage credential probes", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		unregisterOAuthProviders();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-storage-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		unregisterOAuthProviders();
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("distinguishes OAuth credentials from API key credentials", async () => {
		await authStorage.set("openai", { type: "api_key", key: "api-key" });

		expect(authStorage.has("openai")).toBe(true);
		expect(authStorage.hasOAuth("openai")).toBe(false);
		expect(await authStorage.peekApiKey("openai")).toBe("api-key");

		await authStorage.set("openai-codex", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
		});

		expect(authStorage.has("openai-codex")).toBe(true);
		expect(authStorage.hasOAuth("openai-codex")).toBe(true);
		expect(await authStorage.peekApiKey("openai-codex")).toBe("oauth-access");
	});

	test("does not treat expired OAuth access tokens as peekable API keys", async () => {
		await authStorage.set("openai-codex", {
			type: "oauth",
			access: "expired-access",
			refresh: "oauth-refresh",
			expires: Date.now() - 1,
		});

		expect(authStorage.hasOAuth("openai-codex")).toBe(true);
		expect(await authStorage.peekApiKey("openai-codex")).toBeUndefined();
	});

	test("applies custom OAuth API-key projection without refreshing", async () => {
		registerOAuthProvider({
			id: "custom-oauth",
			name: "Custom OAuth",
			async login() {
				throw new Error("not used");
			},
			async refreshToken() {
				throw new Error("peekApiKey must not refresh OAuth tokens");
			},
			getApiKey(credentials) {
				return `projected:${credentials.access}`;
			},
		});

		await authStorage.set("custom-oauth", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
		});

		expect(await authStorage.peekApiKey("custom-oauth")).toBe("projected:oauth-access");
	});
});

function makeCapturingUsageProvider(
	id: Provider,
	report: (cred: UsageCredential) => UsageReport,
	captured: { credential?: UsageCredential },
): UsageProvider {
	return {
		id,
		supports(p) {
			return p.provider === id && p.credential.type === "oauth";
		},
		async fetchUsage(p: UsageFetchParams, _ctx: UsageFetchContext) {
			captured.credential = p.credential;
			if (p.credential.type !== "oauth") return null;
			return report(p.credential);
		},
	};
}

describe("AuthStorage usage credential adapter", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		unregisterOAuthProviders();
	});

	afterEach(async () => {
		unregisterOAuthProviders();
		authStorage?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("converts OAuthCredential storage shape into the runtime UsageCredential shape", async () => {
		const captured: { credential?: UsageCredential } = {};
		const stub = makeCapturingUsageProvider(
			"kimi-code",
			() => ({ provider: "kimi-code", fetchedAt: Date.now(), limits: [] }),
			captured,
		);

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-adapter-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"), {
			usageProviderResolver: p => (p === "kimi-code" ? stub : undefined),
		});

		const expires = Date.now() + 60_000;
		await authStorage.set("kimi-code", {
			type: "oauth",
			access: "kimi-access",
			refresh: "kimi-refresh",
			expires,
			accountId: "kimi-acc",
			email: "user@example.com",
			projectId: "proj-1",
			enterpriseUrl: "https://kimi.example.com",
		});

		await authStorage.fetchUsageReports();

		expect(captured.credential).toBeDefined();
		expect(captured.credential).toMatchObject({
			type: "oauth",
			accessToken: "kimi-access",
			refreshToken: "kimi-refresh",
			expiresAt: expires,
			accountId: "kimi-acc",
			email: "user@example.com",
			projectId: "proj-1",
			enterpriseUrl: "https://kimi.example.com",
		});
	});
});

describe("AuthStorage Kimi credential ranking", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		unregisterOAuthProviders();
	});

	afterEach(async () => {
		unregisterOAuthProviders();
		authStorage?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("skips a Kimi credential whose usage report shows the limit is exhausted", async () => {
		registerOAuthProvider({
			id: "kimi-code",
			name: "Kimi (test)",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(creds) {
				return { ...creds };
			},
			getApiKey(creds) {
				return creds.access;
			},
		});

		const buildReport = (exhausted: boolean, accountId: string): UsageReport => ({
			provider: "kimi-code",
			fetchedAt: Date.now(),
			limits: [
				{
					id: `kimi-code:${accountId}`,
					label: "Hourly",
					scope: { provider: "kimi-code", accountId, windowId: "1h" },
					window: { id: "1h", label: "1h", durationMs: 60 * 60 * 1000 },
					amount: exhausted
						? { used: 100, limit: 100, usedFraction: 1, unit: "unknown" }
						: { used: 5, limit: 100, usedFraction: 0.05, unit: "unknown" },
					status: exhausted ? "exhausted" : "ok",
				},
			],
		});

		const usageStub: UsageProvider = {
			id: "kimi-code",
			supports: p => p.credential.type === "oauth",
			async fetchUsage(p) {
				if (p.credential.type !== "oauth") return null;
				const acc = p.credential.accountId ?? "";
				return buildReport(acc === "exhausted-acc", acc);
			},
		};

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-kimi-rank-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"), {
			usageProviderResolver: p => (p === "kimi-code" ? usageStub : undefined),
		});

		await authStorage.set("kimi-code", [
			{
				type: "oauth",
				access: "exhausted-access",
				refresh: "exhausted-refresh",
				expires: Date.now() + 600_000,
				accountId: "exhausted-acc",
			},
			{
				type: "oauth",
				access: "fresh-access",
				refresh: "fresh-refresh",
				expires: Date.now() + 600_000,
				accountId: "fresh-acc",
			},
		]);

		const apiKey = await authStorage.getApiKey("kimi-code");
		expect(apiKey).toBe("fresh-access");
	});

	test("falls back to round-robin when no ranking strategy is registered", async () => {
		registerOAuthProvider({
			id: "kimi-code",
			name: "Kimi (test)",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(creds) {
				return { ...creds };
			},
			getApiKey(creds) {
				return creds.access;
			},
		});

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-kimi-no-strat-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"), {
			rankingStrategyResolver: () => undefined,
			usageProviderResolver: () => undefined,
		});

		await authStorage.set("kimi-code", [
			{
				type: "oauth",
				access: "first-access",
				refresh: "first-refresh",
				expires: Date.now() + 600_000,
				accountId: "first",
			},
			{
				type: "oauth",
				access: "second-access",
				refresh: "second-refresh",
				expires: Date.now() + 600_000,
				accountId: "second",
			},
		]);

		const apiKey = await authStorage.getApiKey("kimi-code");
		expect(apiKey).toBe("first-access");
	});
});

describe("AuthStorage Codex Pro plan Spark selection", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		unregisterOAuthProviders();
	});

	afterEach(async () => {
		unregisterOAuthProviders();
		authStorage?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function setup() {
		registerOAuthProvider({
			id: "openai-codex",
			name: "OpenAI Codex (test)",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(creds) {
				return { ...creds };
			},
			getApiKey(creds) {
				return creds.access;
			},
		});

		const buildReport = (planType: string, accountId: string): UsageReport => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "openai-codex:primary",
					label: "Primary",
					scope: { provider: "openai-codex", accountId, windowId: "1h" },
					window: { id: "1h", label: "1h", durationMs: 60 * 60 * 1000 },
					amount: { used: 10, limit: 100, usedFraction: 0.1, unit: "percent" },
				},
			],
			metadata: { planType },
		});

		const usageStub: UsageProvider = {
			id: "openai-codex",
			supports: p => p.credential.type === "oauth",
			async fetchUsage(p) {
				if (p.credential.type !== "oauth") return null;
				const planType = p.credential.accountId === "pro-acc" ? "pro" : "plus";
				return buildReport(planType, p.credential.accountId ?? "anon");
			},
		};

		return usageStub;
	}

	test("for -spark models, picks the Pro account over Plus", async () => {
		const usageStub = setup();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-codex-spark-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"), {
			usageProviderResolver: p => (p === "openai-codex" ? usageStub : undefined),
		});

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "plus-access",
				refresh: "plus-refresh",
				expires: Date.now() + 600_000,
				accountId: "plus-acc",
			},
			{
				type: "oauth",
				access: "pro-access",
				refresh: "pro-refresh",
				expires: Date.now() + 600_000,
				accountId: "pro-acc",
			},
		]);

		const sparkKey = await authStorage.getApiKey("openai-codex", undefined, {
			modelId: "gpt-5.1-codex-spark",
		});
		expect(sparkKey).toBe("pro-access");
	});

	test("for non-spark Codex models, plan tier does not gate selection", async () => {
		const usageStub = setup();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-codex-plain-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"), {
			usageProviderResolver: p => (p === "openai-codex" ? usageStub : undefined),
		});

		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "plus-access",
				refresh: "plus-refresh",
				expires: Date.now() + 600_000,
				accountId: "plus-acc",
			},
			{
				type: "oauth",
				access: "pro-access",
				refresh: "pro-refresh",
				expires: Date.now() + 600_000,
				accountId: "pro-acc",
			},
		]);

		const result = await authStorage.getApiKey("openai-codex", undefined, {
			modelId: "gpt-5.1-codex",
		});
		expect(result === "plus-access" || result === "pro-access").toBe(true);
	});
});
