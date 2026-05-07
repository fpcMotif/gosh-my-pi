import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	codexRankingStrategy,
	extractAccountId,
	extractEmail,
	normalizeCodexBaseUrl,
	openaiCodexUsageProvider,
	parseJwt,
	parseCodexUsagePayload,
} from "@oh-my-pi/pi-ai/usage/openai-codex";
import type { UsageCredential, UsageFetchContext, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";

function makeJwt(claims: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toBase64();
	const payload = Buffer.from(JSON.stringify(claims), "utf8").toBase64();
	return `${header}.${payload}.sig`;
}

function makeCredential(overrides: Partial<UsageCredential> = {}): UsageCredential {
	return {
		type: "oauth",
		accessToken: "access-token",
		refreshToken: "refresh-token",
		expiresAt: Date.now() + 60_000,
		...overrides,
	};
}

type StubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeFetchContext(impl: StubFetch): UsageFetchContext {
	return {
		fetch: impl as unknown as typeof fetch,
		logger: { debug: () => {}, warn: () => {} },
	};
}

describe("openai-codex parseJwt", () => {
	it("returns null for non-JWT input", () => {
		expect(parseJwt("not-a-jwt")).toBeNull();
		expect(parseJwt("a.b")).toBeNull();
	});

	it("decodes claims when payload is valid base64url JSON", () => {
		const token = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acc_42" },
			"https://api.openai.com/profile": { email: "alice@example.com" },
		});
		const decoded = parseJwt(token);
		expect(decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id).toBe("acc_42");
		expect(decoded?.["https://api.openai.com/profile"]?.email).toBe("alice@example.com");
	});

	it("returns null when payload is not valid JSON", () => {
		const bad = `header.${Buffer.from("not-json", "utf8").toBase64()}.sig`;
		expect(parseJwt(bad)).toBeNull();
	});
});

describe("openai-codex JWT identity extraction", () => {
	it("extracts chatgpt_account_id from auth claim", () => {
		const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_77" } });
		expect(extractAccountId(token)).toBe("acc_77");
	});

	it("extracts and normalizes email from profile claim", () => {
		const token = makeJwt({ "https://api.openai.com/profile": { email: "  Alice@Example.COM  " } });
		expect(extractEmail(token)).toBe("alice@example.com");
	});

	it("returns undefined for empty or missing token", () => {
		expect(extractAccountId(undefined)).toBeUndefined();
		expect(extractAccountId("")).toBeUndefined();
		expect(extractEmail(undefined)).toBeUndefined();
	});

	it("returns undefined when claim is absent", () => {
		const token = makeJwt({ unrelated: true });
		expect(extractAccountId(token)).toBeUndefined();
		expect(extractEmail(token)).toBeUndefined();
	});
});

describe("openai-codex parseCodexUsagePayload", () => {
	it("returns null for non-record input", () => {
		expect(parseCodexUsagePayload(null)).toBeNull();
		expect(parseCodexUsagePayload("string")).toBeNull();
		expect(parseCodexUsagePayload([])).toBeNull();
	});

	it("returns null when rate_limit is missing", () => {
		expect(parseCodexUsagePayload({ plan_type: "pro" })).toBeNull();
	});

	it("returns null when rate_limit has no usable fields", () => {
		expect(parseCodexUsagePayload({ rate_limit: {} })).toBeNull();
	});

	it("parses primary, secondary, plan and limit_reached", () => {
		const parsed = parseCodexUsagePayload({
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 25, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 3600 },
				secondary_window: { used_percent: 80, limit_window_seconds: 7 * 24 * 60 * 60 },
			},
		});
		expect(parsed?.planType).toBe("pro");
		expect(parsed?.allowed).toBe(true);
		expect(parsed?.limitReached).toBe(false);
		expect(parsed?.primary?.usedPercent).toBe(25);
		expect(parsed?.primary?.limitWindowSeconds).toBe(18_000);
		expect(parsed?.secondary?.usedPercent).toBe(80);
		expect(parsed?.secondary?.limitWindowSeconds).toBe(604_800);
	});
});

describe("openai-codex normalizeCodexBaseUrl", () => {
	it("appends /backend-api for chatgpt.com hosts", () => {
		expect(normalizeCodexBaseUrl("https://chatgpt.com")).toBe("https://chatgpt.com/backend-api");
		expect(normalizeCodexBaseUrl("https://chat.openai.com/")).toBe("https://chat.openai.com/backend-api");
	});

	it("does not double-append /backend-api", () => {
		expect(normalizeCodexBaseUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api");
	});

	it("respects third-party hosts unchanged", () => {
		expect(normalizeCodexBaseUrl("https://example.com/codex")).toBe("https://example.com/codex");
	});

	it("uses CODEX_BASE_URL fallback when input is empty", () => {
		expect(normalizeCodexBaseUrl(undefined)).toBe("https://chatgpt.com/backend-api");
		expect(normalizeCodexBaseUrl("")).toBe("https://chatgpt.com/backend-api");
	});
});

function makeLimit(over: Partial<UsageLimit>, id: string): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider: "openai-codex" },
		amount: { unit: "percent" },
		...over,
	};
}

describe("codexRankingStrategy.findWindowLimits", () => {
	it("picks limits by canonical id", () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 0,
			limits: [
				makeLimit({}, "openai-codex:primary"),
				makeLimit({}, "openai-codex:secondary"),
				makeLimit({}, "noise"),
			],
		};
		const win = codexRankingStrategy.findWindowLimits(report);
		expect(win.primary?.id).toBe("openai-codex:primary");
		expect(win.secondary?.id).toBe("openai-codex:secondary");
	});

	it("falls back to windowId 1h / 7d when ids do not match", () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: 0,
			limits: [
				makeLimit({ scope: { provider: "openai-codex", windowId: "1h" } }, "x"),
				makeLimit({ scope: { provider: "openai-codex", windowId: "7d" } }, "y"),
			],
		};
		const win = codexRankingStrategy.findWindowLimits(report);
		expect(win.primary?.scope.windowId).toBe("1h");
		expect(win.secondary?.scope.windowId).toBe("7d");
	});
});

describe("codexRankingStrategy.hasPriorityBoost", () => {
	it("boosts a fresh 5h Pro window with zero usage", () => {
		const limit = makeLimit(
			{
				scope: { provider: "openai-codex", windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
				amount: { used: 0, limit: 100, usedFraction: 0, unit: "percent" },
			},
			"openai-codex:primary",
		);
		expect(codexRankingStrategy.hasPriorityBoost?.(limit)).toBe(true);
	});

	it("does not boost when usage is non-zero", () => {
		const limit = makeLimit(
			{
				scope: { provider: "openai-codex", windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
				amount: { used: 1, limit: 100, usedFraction: 0.01, unit: "percent" },
			},
			"openai-codex:primary",
		);
		expect(codexRankingStrategy.hasPriorityBoost?.(limit)).toBe(false);
	});

	it("does not boost a non-5h window", () => {
		const limit = makeLimit(
			{
				scope: { provider: "openai-codex", windowId: "1h" },
				window: { id: "1h", label: "1 Hour", durationMs: 60 * 60 * 1000 },
				amount: { used: 0, limit: 100, usedFraction: 0, unit: "percent" },
			},
			"openai-codex:primary",
		);
		expect(codexRankingStrategy.hasPriorityBoost?.(limit)).toBe(false);
	});

	it("does not boost when primary is undefined", () => {
		expect(codexRankingStrategy.hasPriorityBoost?.(undefined)).toBe(false);
	});
});

describe("openaiCodexUsageProvider.fetchUsage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when access token is missing", async () => {
		const ctx = makeFetchContext(() => Promise.reject(new Error("should not be called")));
		const report = await openaiCodexUsageProvider.fetchUsage(
			{ provider: "openai-codex", credential: makeCredential({ accessToken: "" }) },
			ctx,
		);
		expect(report).toBeNull();
	});

	it("returns null for expired credentials", async () => {
		const ctx = makeFetchContext(() => Promise.reject(new Error("should not be called")));
		const report = await openaiCodexUsageProvider.fetchUsage(
			{ provider: "openai-codex", credential: makeCredential({ expiresAt: Date.now() - 1 }) },
			ctx,
		);
		expect(report).toBeNull();
	});

	it("returns null when fetch returns non-ok", async () => {
		const ctx = makeFetchContext(async () => new Response("forbidden", { status: 403 }));
		const report = await openaiCodexUsageProvider.fetchUsage(
			{ provider: "openai-codex", credential: makeCredential() },
			ctx,
		);
		expect(report).toBeNull();
	});

	it("returns parsed usage with plan, accountId, and primary+secondary limits", async () => {
		const accessToken = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acc_jwt" },
			"https://api.openai.com/profile": { email: "Bob@Example.com" },
		});
		const recordedHeaders = { value: undefined as Record<string, string> | undefined };
		const recordedUrl = { value: "" };
		const stubFetch = (async (url: string | URL, init?: RequestInit) => {
			recordedUrl.value = String(url);
			recordedHeaders.value = init?.headers as Record<string, string>;
			return new Response(
				JSON.stringify({
					plan_type: "pro",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							used_percent: 12,
							limit_window_seconds: 5 * 3600,
							reset_after_seconds: 3600,
						},
						secondary_window: {
							used_percent: 50,
							limit_window_seconds: 7 * 24 * 3600,
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await openaiCodexUsageProvider.fetchUsage(
			{ provider: "openai-codex", credential: makeCredential({ accessToken }) },
			makeFetchContext(stubFetch),
		);

		expect(report).not.toBeNull();
		expect(recordedUrl.value).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(recordedHeaders.value?.Authorization).toBe(`Bearer ${accessToken}`);
		expect(recordedHeaders.value?.["ChatGPT-Account-Id"]).toBe("acc_jwt");

		expect(report?.metadata?.planType).toBe("pro");
		expect(report?.metadata?.accountId).toBe("acc_jwt");
		expect(report?.metadata?.email).toBe("bob@example.com");
		expect(report?.limits).toHaveLength(2);
		expect(report?.limits[0].id).toBe("openai-codex:primary");
		expect(report?.limits[0].window?.durationMs).toBe(5 * 3600 * 1000);
		expect(report?.limits[0].amount.usedFraction).toBeCloseTo(0.12, 5);
		expect(report?.limits[1].id).toBe("openai-codex:secondary");
		expect(report?.limits[1].window?.durationMs).toBe(7 * 24 * 3600 * 1000);
	});

	it("prefers credential.accountId over JWT-derived id when both present", async () => {
		const accessToken = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "from-jwt" } });
		let captured: Record<string, string> | undefined;
		const stubFetch = (async (_u: string | URL, init?: RequestInit) => {
			captured = init?.headers as Record<string, string>;
			return new Response(
				JSON.stringify({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 3600 } } }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: makeCredential({ accessToken, accountId: "from-cred" }),
			},
			makeFetchContext(stubFetch),
		);

		expect(captured?.["ChatGPT-Account-Id"]).toBe("from-cred");
	});
});
