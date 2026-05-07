import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	buildUsageRow,
	buildWindow,
	formatDurationLabel,
	kimiRankingStrategy,
	kimiUsageProvider,
	normalizeBaseUrl,
	parseResetTime,
	parseKimiUsagePayload,
} from "@oh-my-pi/pi-ai/usage/kimi";
import type { UsageCredential, UsageFetchContext, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import * as kimiOAuth from "@oh-my-pi/pi-ai/utils/oauth/kimi";

function makeCredential(overrides: Partial<UsageCredential> = {}): UsageCredential {
	return {
		type: "oauth",
		accessToken: "kimi-access",
		refreshToken: "kimi-refresh",
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

describe("kimi normalizeBaseUrl", () => {
	it("strips trailing slashes from the explicit baseUrl", () => {
		expect(normalizeBaseUrl("https://api.kimi.com/coding/v1/")).toBe("https://api.kimi.com/coding/v1");
		expect(normalizeBaseUrl("https://example.com//path//")).toBe("https://example.com//path");
	});

	it("falls back to the default base URL when input is empty", () => {
		expect(normalizeBaseUrl(undefined)).toBe("https://api.kimi.com/coding/v1");
		expect(normalizeBaseUrl("")).toBe("https://api.kimi.com/coding/v1");
		expect(normalizeBaseUrl("   ")).toBe("https://api.kimi.com/coding/v1");
	});
});

describe("kimi formatDurationLabel", () => {
	it("formats minute multiples of 60 as hours", () => {
		expect(formatDurationLabel(60, "MINUTE")).toBe("1h limit");
		expect(formatDurationLabel(180, "MINUTE")).toBe("3h limit");
	});

	it("formats minute non-multiples as minutes", () => {
		expect(formatDurationLabel(45, "MINUTE")).toBe("45m limit");
	});

	it("formats hours and days", () => {
		expect(formatDurationLabel(2, "HOUR")).toBe("2h limit");
		expect(formatDurationLabel(7, "DAY")).toBe("7d limit");
		expect(formatDurationLabel(30, "SECOND")).toBe("30s limit");
	});

	it("returns undefined for unknown units", () => {
		expect(formatDurationLabel(1, "FORTNIGHT")).toBeUndefined();
	});
});

describe("kimi parseResetTime", () => {
	const now = 1_700_000_000_000;

	it("parses ISO datetime strings", () => {
		const iso = new Date(1_700_000_000_000).toISOString();
		expect(parseResetTime({ reset_at: iso }, now)).toBe(1_700_000_000_000);
	});

	it("treats large numeric values as epoch milliseconds", () => {
		expect(parseResetTime({ reset_at: 1_700_000_001_234 }, now)).toBe(1_700_000_001_234);
	});

	it("treats small numeric values as epoch seconds", () => {
		expect(parseResetTime({ reset_at: 1_700_000_000 }, now)).toBe(1_700_000_000_000);
	});

	it("computes future epoch from reset_in/ttl seconds", () => {
		expect(parseResetTime({ reset_in: 60 }, now)).toBe(now + 60_000);
		expect(parseResetTime({ ttl: 3600 }, now)).toBe(now + 3_600_000);
	});

	it("returns undefined when no reset field is present", () => {
		expect(parseResetTime({}, now)).toBeUndefined();
	});
});

describe("kimi buildUsageRow", () => {
	it("derives used = limit - remaining when only those two are present", () => {
		const row = buildUsageRow({ limit: 100, remaining: 30 }, "x", 0);
		expect(row?.used).toBe(70);
		expect(row?.limit).toBe(100);
		expect(row?.remaining).toBe(30);
	});

	it("returns null when neither used nor limit is present", () => {
		expect(buildUsageRow({}, "x", 0)).toBeNull();
	});

	it("uses defaultLabel when name/title are missing", () => {
		const row = buildUsageRow({ used: 5, limit: 10 }, "fallback", 0);
		expect(row?.label).toBe("fallback");
	});

	it("prefers data.name over defaultLabel", () => {
		const row = buildUsageRow({ used: 5, limit: 10, name: "Pro Quota" }, "fallback", 0);
		expect(row?.label).toBe("Pro Quota");
	});
});

describe("kimi buildWindow", () => {
	it("returns durationMs for HOUR units", () => {
		const win = buildWindow({ duration: 2, timeUnit: "HOUR" }, 0);
		expect(win?.durationMs).toBe(2 * 3_600_000);
		expect(win?.label).toBe("2h limit");
		expect(win?.id).toBe("2hour");
	});

	it("returns durationMs for MINUTE units (sub-hour)", () => {
		const win = buildWindow({ duration: 30, timeUnit: "MINUTE" }, 0);
		expect(win?.durationMs).toBe(30 * 60_000);
	});

	it("returns durationMs for DAY units", () => {
		const win = buildWindow({ duration: 7, timeUnit: "DAY" }, 0);
		expect(win?.durationMs).toBe(7 * 86_400_000);
	});

	it("returns undefined for empty input", () => {
		expect(buildWindow({}, 0)).toBeUndefined();
	});
});

describe("kimi parseKimiUsagePayload", () => {
	it("returns null for non-record input", () => {
		expect(parseKimiUsagePayload(null, 0)).toBeNull();
		expect(parseKimiUsagePayload([], 0)).toBeNull();
	});

	it("emits a Total quota row when usage is present", () => {
		const out = parseKimiUsagePayload({ usage: { used: 10, limit: 100 } }, 0);
		expect(out?.rows).toHaveLength(1);
		expect(out?.rows[0].label).toBe("Total quota");
		expect(out?.rows[0].used).toBe(10);
		expect(out?.rows[0].limit).toBe(100);
	});

	it("emits per-limit rows from limits array with windows", () => {
		const out = parseKimiUsagePayload(
			{
				limits: [
					{ name: "Hourly", detail: { used: 5, limit: 50 }, window: { duration: 1, timeUnit: "HOUR" } },
					{ name: "Daily", detail: { used: 80, limit: 500 }, window: { duration: 1, timeUnit: "DAY" } },
				],
			},
			0,
		);
		expect(out?.rows.map(r => r.label)).toEqual(["Hourly", "Daily"]);
		expect(out?.rows[0].window?.durationMs).toBe(3_600_000);
		expect(out?.rows[1].window?.durationMs).toBe(86_400_000);
	});

	it("combines summary + per-limit rows", () => {
		const out = parseKimiUsagePayload(
			{
				usage: { used: 12, limit: 100 },
				limits: [{ detail: { used: 3, limit: 25 }, window: { duration: 1, timeUnit: "HOUR" } }],
			},
			0,
		);
		expect(out?.rows).toHaveLength(2);
		expect(out?.rows[0].label).toBe("Total quota");
	});
});

function makeLimit(over: Partial<UsageLimit>, id: string): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider: "kimi-code" },
		amount: { unit: "unknown" },
		...over,
	};
}

describe("kimiRankingStrategy.findWindowLimits", () => {
	it("picks shortest-window primary and longest-window secondary", () => {
		const report: UsageReport = {
			provider: "kimi-code",
			fetchedAt: 0,
			limits: [
				makeLimit({ window: { id: "1d", label: "1 day", durationMs: 86_400_000 } }, "kimi-code:1"),
				makeLimit({ window: { id: "1h", label: "1 hour", durationMs: 3_600_000 } }, "kimi-code:0"),
				makeLimit({ window: { id: "30m", label: "30m limit", durationMs: 1_800_000 } }, "kimi-code:2"),
			],
		};
		const win = kimiRankingStrategy.findWindowLimits(report);
		expect(win.primary?.window?.durationMs).toBe(1_800_000);
		expect(win.secondary?.window?.durationMs).toBe(86_400_000);
	});

	it("falls back to first limit when no windowed limits are present", () => {
		const report: UsageReport = {
			provider: "kimi-code",
			fetchedAt: 0,
			limits: [makeLimit({}, "kimi-code:0"), makeLimit({}, "kimi-code:1")],
		};
		const win = kimiRankingStrategy.findWindowLimits(report);
		expect(win.primary?.id).toBe("kimi-code:0");
		expect(win.secondary).toBeUndefined();
	});

	it("returns undefined secondary when only one windowed limit exists", () => {
		const report: UsageReport = {
			provider: "kimi-code",
			fetchedAt: 0,
			limits: [makeLimit({ window: { id: "1h", label: "1h", durationMs: 3_600_000 } }, "kimi-code:0")],
		};
		const win = kimiRankingStrategy.findWindowLimits(report);
		expect(win.primary?.id).toBe("kimi-code:0");
		expect(win.secondary).toBeUndefined();
	});

	it("declares window defaults to 1h primary / 24h secondary", () => {
		expect(kimiRankingStrategy.windowDefaults.primaryMs).toBe(3_600_000);
		expect(kimiRankingStrategy.windowDefaults.secondaryMs).toBe(86_400_000);
	});
});

describe("kimiUsageProvider.fetchUsage", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when access token is missing", async () => {
		const ctx = makeFetchContext(() => Promise.reject(new Error("should not be called")));
		const out = await kimiUsageProvider.fetchUsage(
			{ provider: "kimi-code", credential: makeCredential({ accessToken: "" }) },
			ctx,
		);
		expect(out).toBeNull();
	});

	it("returns null when fetch returns non-ok", async () => {
		vi.spyOn(kimiOAuth, "getKimiCommonHeaders").mockResolvedValue({});
		const ctx = makeFetchContext(async () => new Response("denied", { status: 401 }));
		const out = await kimiUsageProvider.fetchUsage({ provider: "kimi-code", credential: makeCredential() }, ctx);
		expect(out).toBeNull();
	});

	it("attaches Authorization and common headers, returns parsed limits", async () => {
		vi.spyOn(kimiOAuth, "getKimiCommonHeaders").mockResolvedValue({ "X-Msh-Platform": "kimi_cli" });
		const captured = { url: "", headers: undefined as Record<string, string> | undefined };
		const stubFetch = (async (url: string | URL, init?: RequestInit) => {
			captured.url = String(url);
			captured.headers = init?.headers as Record<string, string>;
			return new Response(
				JSON.stringify({
					usage: { used: 4, limit: 100 },
					limits: [{ name: "Hourly", detail: { used: 2, limit: 25 }, window: { duration: 1, timeUnit: "HOUR" } }],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const out = await kimiUsageProvider.fetchUsage(
			{ provider: "kimi-code", credential: makeCredential({ accountId: "kimi-acc" }) },
			makeFetchContext(stubFetch),
		);

		expect(captured.url).toBe("https://api.kimi.com/coding/v1/usages");
		expect(captured.headers?.Authorization).toBe("Bearer kimi-access");
		expect(captured.headers?.["X-Msh-Platform"]).toBe("kimi_cli");
		expect(out?.limits).toHaveLength(2);
		expect(out?.limits[0].label).toBe("Total quota");
		expect(out?.limits[1].label).toBe("Hourly");
		expect(out?.limits[1].window?.durationMs).toBe(3_600_000);
		expect(out?.limits.every(l => l.scope.accountId === "kimi-acc")).toBe(true);
	});

	it("refreshes the access token when the credential is expired", async () => {
		vi.spyOn(kimiOAuth, "getKimiCommonHeaders").mockResolvedValue({});
		const refreshSpy = vi.spyOn(kimiOAuth, "refreshKimiToken").mockResolvedValue({
			access: "renewed-access",
			refresh: "renewed-refresh",
			expires: Date.now() + 600_000,
		});
		const captured = { authorization: "" };
		const stubFetch = (async (_u: string | URL, init?: RequestInit) => {
			captured.authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			return new Response(JSON.stringify({ usage: { used: 1, limit: 10 } }), { status: 200 });
		}) as unknown as typeof fetch;

		const out = await kimiUsageProvider.fetchUsage(
			{
				provider: "kimi-code",
				credential: makeCredential({ expiresAt: Date.now() - 1_000 }),
			},
			makeFetchContext(stubFetch),
		);

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(captured.authorization).toBe("Bearer renewed-access");
		expect(out?.limits).toHaveLength(1);
	});

	it("returns null when token is expired and no refresh token is available", async () => {
		vi.spyOn(kimiOAuth, "getKimiCommonHeaders").mockResolvedValue({});
		const ctx = makeFetchContext(() => Promise.reject(new Error("should not be called")));
		const out = await kimiUsageProvider.fetchUsage(
			{
				provider: "kimi-code",
				credential: makeCredential({ expiresAt: Date.now() - 1_000, refreshToken: "" }),
			},
			ctx,
		);
		expect(out).toBeNull();
	});
});
