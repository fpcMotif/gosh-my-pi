import { logger } from "@oh-my-pi/pi-utils";
import type { Provider } from "./types";
import type { AuthCredential, OAuthCredential } from "./auth-types";
import type { CredentialRankingStrategy, UsageReport } from "./usage";
import { getOAuthApiKey, getOAuthProvider } from "./utils/oauth";
import type { OAuthProvider, OAuthCredentials } from "./utils/oauth/types";
import { isUsageLimitReached, getUsageResetAtMs } from "./auth-usage-utils";

const DEFAULT_BACKOFF_MS = 60_000;

export interface ResolverContext {
	getUsageReport(provider: Provider, credential: AuthCredential, options?: unknown): Promise<UsageReport | null>;
	isUsageLimitReached(report: UsageReport): boolean;
	getUsageResetAtMs(report: UsageReport, now: number): number | undefined;
	markCredentialBlocked(providerKey: string, index: number, until: number): void;
	replaceCredentialAt(provider: string, index: number, updated: AuthCredential): void;
	recordSessionCredential(provider: string, sessionId: string | undefined, type: string, index: number): void;
	getCredentialBlockedUntil(providerKey: string, index: number): number | undefined;
	getCredentialsForProvider(provider: string): AuthCredential[];
	usageRequestTimeoutMs: number;
	rawCtrlChar: (letter: string) => string;
}

export function requiresOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return provider === "openai-codex" && typeof modelId === "string" && modelId.includes("-spark");
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (metadata === undefined || metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
		return undefined;
	const claims = metadata as Record<string, unknown>;
	const planType = claims.planType;
	return typeof planType === "string" ? planType.toLowerCase() : undefined;
}

function getOpenAICodexPlanPriority(report: UsageReport | null): number {
	const planType = getUsagePlanType(report);
	if (planType === undefined) return 1;
	return planType.includes("pro") ? 0 : 2;
}

function hasOpenAICodexProPlan(report: UsageReport | null): boolean {
	const planType = getUsagePlanType(report);
	return planType !== undefined && planType.includes("pro");
}

function normalizeUsageFraction(limit?: { used: number; total: number }): number {
	if (limit === undefined || limit.total <= 0) return 0;
	return limit.used / limit.total;
}

function computeWindowDrainRate(
	limit: { used: number; resetAt?: number } | undefined,
	nowMs: number,
	defaultWindowMs: number,
): number {
	if (limit === undefined || limit.used === 0) return 0;
	const resetAt = limit.resetAt;
	const windowMs = resetAt === undefined ? defaultWindowMs : resetAt - nowMs;
	const elapsedMs = Math.max(1, defaultWindowMs - windowMs);
	return limit.used / (elapsedMs / 3600000);
}

function getCandidateBlockedStatus(
	args: { providerKey: string; ctx: ResolverContext; strategy: CredentialRankingStrategy; now: number },
	r: { selection: { index: number }; usage: UsageReport | null; blockedUntil?: number },
) {
	const { providerKey, ctx, now } = args;
	let blockedUntil = r.blockedUntil;
	let blocked = blockedUntil !== undefined;
	const usage = r.usage;
	if (blocked === false && usage !== null && isUsageLimitReached(usage)) {
		blockedUntil = getUsageResetAtMs(usage, now) ?? Date.now() + DEFAULT_BACKOFF_MS;
		ctx.markCredentialBlocked(providerKey, r.selection.index, blockedUntil);
		blocked = true;
	}
	return { blocked, blockedUntil };
}

type Candidate = {
	blocked: boolean;
	blockedUntil?: number;
	orderPos: number;
	usage: UsageReport | null;
	hasPriorityBoost: boolean;
	secondaryDrainRate: number;
	secondaryUsed: number;
	primaryDrainRate: number;
	primaryUsed: number;
};

function compareCandidateBlocking(l: Candidate, r: Candidate): number | undefined {
	if (l.blocked !== r.blocked) return l.blocked ? 1 : -1;
	if (l.blocked === true && r.blocked === true) {
		const lu = l.blockedUntil === undefined ? Number.POSITIVE_INFINITY : l.blockedUntil;
		const ru = r.blockedUntil === undefined ? Number.POSITIVE_INFINITY : r.blockedUntil;
		return lu === ru ? l.orderPos - r.orderPos : lu - ru;
	}
	return undefined;
}

function compareCandidatePerformance(l: Candidate, r: Candidate): number {
	if (l.hasPriorityBoost !== r.hasPriorityBoost) return l.hasPriorityBoost ? -1 : 1;
	if (l.secondaryDrainRate !== r.secondaryDrainRate) return l.secondaryDrainRate - r.secondaryDrainRate;
	if (l.secondaryUsed !== r.secondaryUsed) return l.secondaryUsed - r.secondaryUsed;
	if (l.primaryDrainRate !== r.primaryDrainRate) return l.primaryDrainRate - r.primaryDrainRate;
	if (l.primaryUsed !== r.primaryUsed) return l.primaryUsed - r.primaryUsed;
	return l.orderPos - r.orderPos;
}

function compareCandidates(
	l: Candidate,
	r: Candidate,
	args: { provider: string; modelId: string | undefined },
): number {
	const blockRes = compareCandidateBlocking(l, r);
	if (blockRes !== undefined) return blockRes;
	if (requiresOpenAICodexProModel(args.provider, args.modelId)) {
		const lp = getOpenAICodexPlanPriority(l.usage);
		const rp = getOpenAICodexPlanPriority(r.usage);
		if (lp !== rp) return lp - rp;
	}
	return compareCandidatePerformance(l, r);
}

export async function rankOAuthSelections(args: {
	providerKey: string;
	provider: string;
	order: number[];
	credentials: Array<{ credential: OAuthCredential; index: number }>;
	options?: unknown;
	strategy: CredentialRankingStrategy;
	ctx: ResolverContext;
}): Promise<
	Array<{
		selection: { credential: OAuthCredential; index: number };
		usage: UsageReport | null;
		usageChecked: boolean;
	}>
> {
	const now = Date.now();
	const results = await Promise.all(
		args.order.map(async idx => {
			const selection = args.credentials[idx];
			if (selection === undefined) return null;
			const until = args.ctx.getCredentialBlockedUntil(args.providerKey, selection.index);
			if (until !== undefined) return { selection, usage: null, usageChecked: false, blockedUntil: until };
			const usage = await args.ctx.getUsageReport(args.provider as Provider, selection.credential, args.options);
			return { selection, usage, usageChecked: true, blockedUntil: undefined };
		}),
	);

	const ranked = results
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.map((r, orderPos) => {
			const { usage } = r;
			const { blocked, blockedUntil } = getCandidateBlockedStatus(
				{ providerKey: args.providerKey, ctx: args.ctx, strategy: args.strategy, now },
				r,
			);
			const win = usage ? args.strategy.findWindowLimits(usage) : undefined;
			const pri = win?.primary;
			const sec = win?.secondary ?? pri;
			return {
				...r,
				blocked,
				blockedUntil,
				orderPos,
				hasPriorityBoost: args.strategy.hasPriorityBoost?.(pri) ?? false,
				secondaryUsed: normalizeUsageFraction(sec),
				secondaryDrainRate: computeWindowDrainRate(sec, now, args.strategy.windowDefaults.secondaryMs),
				primaryUsed: normalizeUsageFraction(pri),
				primaryDrainRate: computeWindowDrainRate(pri, now, args.strategy.windowDefaults.primaryMs),
			};
		});

	const opts = args.options;
	const modelId =
		opts !== null && opts !== undefined && typeof opts === "object" && !Array.isArray(opts)
			? ((opts as Record<string, unknown>).modelId as string | undefined)
			: undefined;
	ranked.sort((l, r) => compareCandidates(l, r, { provider: args.provider, modelId }));

	return ranked.map(c => ({ selection: c.selection, usage: c.usage, usageChecked: c.usageChecked }));
}

async function checkUsageBeforeTry(args: {
	provider: string;
	selection: { credential: OAuthCredential; index: number };
	providerKey: string;
	options: unknown;
	usageOptions: {
		checkUsage: boolean;
		allowBlocked: boolean;
		prefetchedUsage: UsageReport | null;
		usagePrechecked: boolean;
		applyProFilter: boolean;
	};
	ctx: ResolverContext;
}): Promise<UsageReport | null | undefined> {
	const { provider, selection, providerKey, options, usageOptions, ctx } = args;
	let usage = usageOptions.usagePrechecked ? usageOptions.prefetchedUsage : null;
	if (usageOptions.checkUsage && !usageOptions.allowBlocked) {
		if (!usageOptions.usagePrechecked)
			usage = await ctx.getUsageReport(provider as Provider, selection.credential, options);
		if (usage && isUsageLimitReached(usage)) {
			ctx.markCredentialBlocked(
				providerKey,
				selection.index,
				getUsageResetAtMs(usage, Date.now()) ?? Date.now() + DEFAULT_BACKOFF_MS,
			);
			return undefined;
		}
	} else if (usageOptions.applyProFilter) {
		if (!usageOptions.usagePrechecked)
			usage = await ctx.getUsageReport(provider as Provider, selection.credential, options);
	}
	if (usageOptions.applyProFilter && !hasOpenAICodexProPlan(usage)) return undefined;
	return usage;
}

export async function tryOAuthCredential(args: {
	provider: string;
	selection: { credential: OAuthCredential; index: number };
	providerKey: string;
	sessionId: string | undefined;
	options: unknown;
	usageOptions: {
		checkUsage: boolean;
		allowBlocked: boolean;
		prefetchedUsage?: UsageReport | null;
		usagePrechecked?: boolean;
		enforceProRequirement?: boolean;
	};
	ctx: ResolverContext;
}): Promise<string | undefined> {
	const { provider, selection, providerKey, options, usageOptions, ctx } = args;
	const {
		checkUsage,
		allowBlocked,
		prefetchedUsage = null,
		usagePrechecked = false,
		enforceProRequirement,
	} = usageOptions;
	if (!allowBlocked && ctx.getCredentialBlockedUntil(providerKey, selection.index) !== undefined) return undefined;
	const opts = options;
	const modelId =
		opts !== null && opts !== undefined && typeof opts === "object" && !Array.isArray(opts)
			? ((opts as Record<string, unknown>).modelId as string | undefined)
			: undefined;
	const applyProFilter = enforceProRequirement ?? requiresOpenAICodexProModel(provider, modelId);

	const usage = await checkUsageBeforeTry({
		provider,
		selection,
		providerKey,
		options,
		usageOptions: { checkUsage, allowBlocked, prefetchedUsage, usagePrechecked, applyProFilter },
		ctx,
	});
	if (usage === undefined) return undefined;

	return tryRefreshOAuth(args, usage, applyProFilter);
}

async function verifyUsageAfterRefresh(
	args: {
		provider: string;
		selection: { credential: OAuthCredential; index: number };
		providerKey: string;
		options: unknown;
		usageOptions: { checkUsage: boolean; allowBlocked: boolean };
		ctx: ResolverContext;
	},
	updated: OAuthCredential,
	applyProFilter: boolean,
): Promise<boolean> {
	const { provider, providerKey, selection, options, usageOptions, ctx } = args;
	if ((usageOptions.checkUsage && !usageOptions.allowBlocked) || applyProFilter) {
		const u = await ctx.getUsageReport(provider as Provider, updated, options);
		if (applyProFilter && !hasOpenAICodexProPlan(u)) return false;
		if (usageOptions.checkUsage && !usageOptions.allowBlocked && u && isUsageLimitReached(u)) {
			ctx.markCredentialBlocked(
				providerKey,
				selection.index,
				getUsageResetAtMs(u, Date.now()) ?? Date.now() + DEFAULT_BACKOFF_MS,
			);
			return false;
		}
	}
	return true;
}

async function tryRefreshOAuth(
	args: {
		provider: string;
		selection: { credential: OAuthCredential; index: number };
		providerKey: string;
		sessionId: string | undefined;
		options: unknown;
		usageOptions: { checkUsage: boolean; allowBlocked: boolean };
		ctx: ResolverContext;
	},
	initialUsage: UsageReport | null,
	applyProFilter: boolean,
): Promise<string | undefined> {
	const { provider, selection, providerKey, sessionId, ctx } = args;
	try {
		const res = await getRefreshedResult(provider, selection.credential);
		if (!res) return undefined;
		const updated: OAuthCredential = {
			type: "oauth",
			...res.newCredentials,
			accountId: res.newCredentials.accountId ?? selection.credential.accountId,
			email: res.newCredentials.email ?? selection.credential.email,
			projectId: res.newCredentials.projectId ?? selection.credential.projectId,
			enterpriseUrl: res.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
		};
		ctx.replaceCredentialAt(provider, selection.index, updated);
		if (!(await verifyUsageAfterRefresh(args, updated, applyProFilter))) return undefined;
		ctx.recordSessionCredential(provider, sessionId, "oauth", selection.index);
		return res.apiKey;
	} catch (error) {
		return handleOAuthRefreshError(error, provider, selection.index, providerKey, ctx);
	}
}

function handleOAuthRefreshError(
	error: unknown,
	provider: string,
	index: number,
	pk: string,
	ctx: ResolverContext,
): string | undefined {
	const msg = String(error);
	const isDef =
		/invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i.test(msg) ||
		(/\b(401|403)\b/.test(msg) && !/timeout|network|fetch failed|ECONNREFUSED/i.test(msg));
	logger.warn("OAuth refresh failed", { provider, index, error: msg, isDef });
	if (isDef) return `ERROR:DEFINITIVE_FAILURE:${msg}`;
	ctx.markCredentialBlocked(pk, index, Date.now() + 300_000);
	return undefined;
}

async function getRefreshedResult(
	provider: string,
	cred: OAuthCredential,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const cp = getOAuthProvider(provider);
	if (cp !== null && cp !== undefined) {
		if (typeof cp.refreshToken !== "function") throw new Error(`Provider ${provider} does not support token refresh`);
		const refreshed = await cp.refreshToken.call(cp, cred);
		return {
			newCredentials: refreshed,
			apiKey: cp.getApiKey !== undefined && cp.getApiKey !== null ? cp.getApiKey(refreshed) : refreshed.access,
		};
	}
	return getOAuthApiKey(provider as OAuthProvider, { [provider]: cred });
}
