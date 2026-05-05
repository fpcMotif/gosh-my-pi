/**
 * Credential storage management.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "./stream";
import type { Provider } from "./types";
import type { CredentialRankingStrategy, UsageLogger, UsageProvider, UsageReport } from "./usage";
import { codexRankingStrategy } from "./usage/openai-codex";
import { getOAuthProvider } from "./utils/oauth";
import { loginKimi } from "./utils/oauth/kimi";
import { loginMiniMaxCode } from "./utils/oauth/minimax-code";
import { loginMoonshot } from "./utils/oauth/moonshot";
import { loginOpenAICodex } from "./utils/oauth/openai-codex";
import type { OAuthController, OAuthCredentials, OAuthProviderId } from "./utils/oauth/types";
import { loginZai } from "./utils/oauth/zai";

import type { AuthCredential, AuthCredentialEntry, AuthStorageData, OAuthCredential } from "./auth-types";
import { AuthCredentialStore } from "./auth-credential-store";
import { rankOAuthSelections, tryOAuthCredential, requiresOpenAICodexProModel } from "./auth-resolver";
import type { ResolverContext } from "./auth-resolver";
import { DEFAULT_USAGE_PROVIDER_MAP, isUsageLimitReached, getUsageResetAtMs } from "./auth-usage-utils";
import type { UsageRequestDescriptor } from "./auth-usage-utils";
import { dedupeUsageReports } from "./auth-usage-manager";
import { AuthStorageUsageCache } from "./auth-usage-cache";
import type { UsageCache } from "./auth-usage-cache";

const USAGE_REPORT_TTL_MS = 30_000;
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 3_000;

export type AuthStorageOptions = {
	usageProviderResolver?: (p: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (p: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	configValueResolver?: (c: string) => Promise<string | undefined>;
};

export class AuthStorage {
	#data = new Map<string, Array<{ id: number; credential: AuthCredential }>>();
	#runtimeOverrides = new Map<string, string>();
	#providerRoundRobinIndex = new Map<string, number>();
	#sessionLastCredential = new Map<string, Map<string, { type: string; index: number }>>();
	#credentialBackoff = new Map<string, Map<number, number>>();
	#usageProviderResolver: (p: Provider) => UsageProvider | undefined;
	#rankingStrategyResolver: (p: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageRequestInFlight = new Map<string, Promise<UsageReport | null>>();
	#usageReportsInFlight = new Map<string, Promise<UsageReport[]>>();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#usageLogger: UsageLogger;
	#fallbackResolver?: (p: string) => string | undefined;
	#store: AuthCredentialStore;
	#configValueResolver: (c: string) => Promise<string | undefined>;
	#closed = false;

	constructor(store: AuthCredentialStore, opts: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = opts.configValueResolver ?? (async c => process.env[c] ?? c);
		this.#usageProviderResolver = opts.usageProviderResolver ?? (p => DEFAULT_USAGE_PROVIDER_MAP.get(p));
		this.#rankingStrategyResolver =
			opts.rankingStrategyResolver ?? (p => (p === "openai-codex" ? codexRankingStrategy : undefined));
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		this.#usageFetch = opts.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = opts.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#usageLogger = opts.usageLogger ?? {
			debug: (m, mt) => logger.debug(m, mt),
			warn: (m, mt) => logger.warn(m, mt),
		};
	}

	static async create(dbPath: string, opts: AuthStorageOptions = {}): Promise<AuthStorage> {
		return new AuthStorage(await AuthCredentialStore.open(dbPath), opts);
	}

	close(): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#store.close();
		}
	}
	setRuntimeApiKey(p: string, k: string): void {
		this.#runtimeOverrides.set(p, k);
	}
	removeRuntimeApiKey(p: string): void {
		this.#runtimeOverrides.delete(p);
	}
	setFallbackResolver(r: (p: string) => string | undefined): void {
		this.#fallbackResolver = r;
	}

	async reload(): Promise<void> {
		const recs = this.#store.listAuthCredentials();
		const grouped = new Map<string, Array<{ id: number; credential: AuthCredential }>>();
		for (const r of recs) {
			const l = grouped.get(r.provider) ?? [];
			l.push({ id: r.id, credential: r.credential });
			grouped.set(r.provider, l);
		}
		this.#data = grouped;
	}

	#getStoredCredentials(p: string) {
		return this.#data.get(p) ?? [];
	}
	#setStoredCredentials(p: string, c: Array<{ id: number; credential: AuthCredential }>) {
		if (c.length === 0) this.#data.delete(p);
		else this.#data.set(p, c);
	}
	#getCredentialsForProvider(p: string) {
		return this.#getStoredCredentials(p).map(e => e.credential);
	}

	#resetProviderAssignments(p: string): void {
		for (const k of this.#providerRoundRobinIndex.keys())
			if (k.startsWith(`${p}:`)) this.#providerRoundRobinIndex.delete(k);
		this.#sessionLastCredential.delete(p);
		for (const k of this.#credentialBackoff.keys()) if (k.startsWith(`${p}:`)) this.#credentialBackoff.delete(k);
	}

	#replaceCredentialAt(p: string, i: number, c: AuthCredential): void {
		const ents = this.#getStoredCredentials(p);
		if (i < 0 || i >= ents.length) return;
		this.#store.updateAuthCredential(ents[i].id, c);
		const up = [...ents];
		up[i] = { id: ents[i].id, credential: c };
		this.#setStoredCredentials(p, up);
	}

	#disableCredentialAt(p: string, i: number, cause: string): void {
		const ents = this.#getStoredCredentials(p);
		if (i < 0 || i >= ents.length) return;
		this.#store.deleteAuthCredential(ents[i].id, cause);
		this.#setStoredCredentials(
			p,
			ents.filter((_, idx) => idx !== i),
		);
		this.#resetProviderAssignments(p);
	}

	get(p: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(p)[0];
	}

	async set(p: string, c: AuthCredentialEntry): Promise<void> {
		const norm = Array.isArray(c) ? c : [c];
		const stored = this.#store.replaceAuthCredentialsForProvider(p, norm);
		this.#setStoredCredentials(
			p,
			stored.map(r => ({ id: r.id, credential: r.credential })),
		);
		this.#resetProviderAssignments(p);
	}

	async #upsertOAuthCredential(p: string, c: OAuthCredential): Promise<void> {
		const stored = this.#store.upsertAuthCredentialForProvider(p, c);
		this.#setStoredCredentials(
			p,
			stored.map(r => ({ id: r.id, credential: r.credential })),
		);
		this.#resetProviderAssignments(p);
	}

	async remove(p: string): Promise<void> {
		this.#store.deleteAuthCredentialsForProvider(p, "deleted");
		this.#data.delete(p);
		this.#resetProviderAssignments(p);
	}
	list(): string[] {
		return Array.from(this.#data.keys());
	}
	has(p: string): boolean {
		return this.#getCredentialsForProvider(p).length > 0;
	}

	hasAuth(p: string): boolean {
		if (this.#runtimeOverrides.has(p)) return true;
		if (this.has(p)) return true;
		const env = getEnvApiKey(p);
		if (env !== undefined && env !== "") return true;
		const fallback = this.#fallbackResolver?.(p);
		return fallback !== undefined && fallback !== "";
	}

	getAll(): AuthStorageData {
		const res: AuthStorageData = {};
		for (const [p, ents] of this.#data.entries()) {
			const cs = ents.map(e => e.credential);
			res[p] = cs.length === 1 ? cs[0] : cs;
		}
		return res;
	}

	async login(
		p: OAuthProviderId,
		ctrl: OAuthController & {
			onAuth: (i: { url: string; instructions?: string }) => void;
			onPrompt: (pr: { message: string; placeholder?: string }) => Promise<string>;
		},
	): Promise<void> {
		const manual = () => ctrl.onPrompt({ message: "Paste code:" });
		const onManualCodeInput = ctrl.onManualCodeInput;
		const onManual =
			onManualCodeInput !== undefined && onManualCodeInput !== null
				? (m: string) => onManualCodeInput.call(ctrl, m)
				: manual;
		let creds: OAuthCredentials;
		switch (p) {
			case "openai-codex":
				creds = await loginOpenAICodex({ ...ctrl, onManualCodeInput: onManual });
				break;
			case "kimi":
				creds = await loginKimi(ctrl);
				break;
			case "moonshot":
				creds = await loginMoonshot(ctrl);
				break;
			case "zai":
				await this.set(p, { type: "api_key", key: await loginZai(ctrl) });
				return;
			case "minimax-code":
				await this.set(p, { type: "api_key", key: await loginMiniMaxCode(ctrl) });
				return;
			default:
				const cp = getOAuthProvider(p);
				if (!cp) throw new Error(`Unknown: ${p}`);
				const r = await cp.login({
					onAuth: i => ctrl.onAuth(i),
					onProgress: m => ctrl.onProgress?.(m),
					onPrompt: pr => ctrl.onPrompt(pr),
					onManualCodeInput: onManual,
					signal: ctrl.signal,
				});
				if (typeof r === "string") {
					await this.set(p, { type: "api_key", key: r });
					return;
				}
				creds = r;
		}
		await this.#upsertOAuthCredential(p, { type: "oauth", ...creds });
	}

	async logout(p: string): Promise<void> {
		await this.remove(p);
	}

	#getResolverCtx(): ResolverContext {
		return {
			getUsageReport: (p, c, o) => this.#getUsageReport(p, c as OAuthCredential, o),
			isUsageLimitReached,
			getUsageResetAtMs: (r, n) => getUsageResetAtMs(r, n),
			markCredentialBlocked: (pk, i, u) => {
				const map = this.#credentialBackoff.get(pk) ?? new Map();
				map.set(i, Math.max(map.get(i) ?? 0, u));
				this.#credentialBackoff.set(pk, map);
			},
			replaceCredentialAt: (p, i, c) => this.#replaceCredentialAt(p, i, c),
			recordSessionCredential: (p, s, t, i) => this.#recordSessionCredential(p, s, t, i),
			getCredentialBlockedUntil: (pk, i) => {
				const m = this.#credentialBackoff.get(pk);
				if (m === undefined) return undefined;
				const u = m.get(i);
				if (u !== undefined && u <= Date.now()) {
					m.delete(i);
					return undefined;
				}
				return u;
			},
			getCredentialsForProvider: p => this.#getCredentialsForProvider(p),
			usageRequestTimeoutMs: this.#usageRequestTimeoutMs,
			rawCtrlChar: l => {
				const cp = l.toLowerCase().codePointAt(0);
				if (cp === undefined) return "";
				return String.fromCodePoint(cp - 96);
			},
		};
	}

	async #getUsageReport(p: Provider, c: OAuthCredential, o?: unknown): Promise<UsageReport | null> {
		const opts =
			o !== undefined && o !== null && typeof o === "object" && !Array.isArray(o)
				? (o as { baseUrl?: string; timeoutMs?: number })
				: {};
		return this.#fetchUsageCached(
			{ provider: p, credential: this.#buildUsageCredential(c), baseUrl: opts.baseUrl },
			opts.timeoutMs ?? this.#usageRequestTimeoutMs,
		);
	}

	#buildUsageCredential(c: OAuthCredential) {
		return {
			type: "oauth" as const,
			accessToken: c.access,
			refreshToken: c.refresh,
			expiresAt: c.expires,
			accountId: c.accountId,
			projectId: c.projectId,
			email: c.email,
			enterpriseUrl: c.enterpriseUrl,
		};
	}

	async #fetchUsageCached(request: UsageRequestDescriptor, timeoutMs: number): Promise<UsageReport | null> {
		const bu = request.baseUrl === undefined ? "def" : request.baseUrl;
		const acc = request.credential.accountId === undefined ? "anon" : request.credential.accountId;
		const key = `report:${request.provider}:${bu}:${acc}`;
		const cached = this.#usageCache.get<UsageReport | null>(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const inFlight = this.#usageRequestInFlight.get(key);
		if (inFlight) return inFlight;
		const promise = (async () => {
			const r = await this.#fetchUsageUncached(request, timeoutMs);
			if (r) this.#usageCache.set(key, { value: r, expiresAt: Date.now() + USAGE_REPORT_TTL_MS });
			return r ?? cached?.value ?? null;
		})().finally(() => this.#usageRequestInFlight.delete(key));
		this.#usageRequestInFlight.set(key, promise);
		return promise;
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs: number): Promise<UsageReport | null> {
		const impl = this.#usageProviderResolver(request.provider);
		if (!impl) return null;
		const params = { ...request, signal: AbortSignal.timeout(timeoutMs) };
		if (impl.supports && !impl.supports(params)) return null;
		try {
			return await impl.fetchUsage(params, { fetch: this.#usageFetch, logger: this.#usageLogger });
		} catch {
			return null;
		}
	}

	async #resolveOAuthApiKey(p: string, s?: string, o?: unknown): Promise<string | undefined> {
		const cs = this.#getStoredCredentials(p)
			.map((entry, i) => ({ credential: entry.credential as OAuthCredential, index: i }))
			.filter(e => e.credential.type === "oauth");
		if (cs.length === 0) return undefined;
		const pk = `${p}:oauth`;
		const strategy = this.#rankingStrategyResolver(p as Provider);
		const optsObj =
			o !== undefined && o !== null && typeof o === "object" && !Array.isArray(o)
				? (o as Record<string, unknown>)
				: {};
		const reqPro = requiresOpenAICodexProModel(p, optsObj.modelId as string | undefined);
		const order = this.#getCredentialOrder(pk, s, cs.length);
		const candidates =
			strategy && (cs.length > 1 || reqPro)
				? await rankOAuthSelections({
						providerKey: pk,
						provider: p,
						order,
						credentials: cs,
						options: o,
						strategy,
						ctx: this.#getResolverCtx(),
					})
				: order.map(idx => ({ selection: cs[idx], usage: null, usageChecked: false }));

		for (const candidate of candidates) {
			const res = await tryOAuthCredential({
				provider: p,
				selection: candidate.selection,
				providerKey: pk,
				sessionId: s,
				options: o,
				usageOptions: {
					checkUsage: true,
					allowBlocked: false,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
				},
				ctx: this.#getResolverCtx(),
			});
			if (typeof res === "string" && res.startsWith("ERROR:DEFINITIVE_FAILURE:")) {
				this.#disableCredentialAt(p, candidate.selection.index, res);
				return this.getApiKey(p, s, o);
			}
			if (res !== undefined) return res;
		}

		const fallback = candidates[0];
		if (fallback === undefined) return undefined;
		const fallbackRes = await tryOAuthCredential({
			provider: p,
			selection: fallback.selection,
			providerKey: pk,
			sessionId: s,
			options: o,
			usageOptions: {
				checkUsage: true,
				allowBlocked: true,
				prefetchedUsage: fallback.usage,
				usagePrechecked: fallback.usageChecked,
			},
			ctx: this.#getResolverCtx(),
		});
		if (typeof fallbackRes === "string" && fallbackRes.startsWith("ERROR:DEFINITIVE_FAILURE:")) {
			this.#disableCredentialAt(p, fallback.selection.index, fallbackRes);
			return this.getApiKey(p, s, o);
		}
		return fallbackRes;
	}

	#getCredentialOrder(pk: string, s: string | undefined, total: number): number[] {
		const start =
			s === undefined || s === "" ? (this.#providerRoundRobinIndex.get(pk) ?? 0) : Bun.hash.xxHash32(s) % total;
		if (s === undefined || s === "") this.#providerRoundRobinIndex.set(pk, (start + 1) % total);
		return Array.from({ length: total }, (_, i) => (start + i) % total);
	}

	async getApiKey(p: string, s?: string, o?: unknown): Promise<string | undefined> {
		const override = this.#runtimeOverrides.get(p);
		if (override !== undefined) return override;
		const ak = this.#selectCredentialByType(p, "api_key", s);
		if (ak) {
			this.#recordSessionCredential(p, s, "api_key", ak.index);
			return this.#configValueResolver(ak.credential.key);
		}
		const ok = await this.#resolveOAuthApiKey(p, s, o);
		if (ok !== undefined) return ok;
		const env = getEnvApiKey(p);
		if (env !== undefined && env !== "") return env;
		return this.#fallbackResolver?.(p);
	}

	#selectCredentialByType<T extends "api_key" | "oauth">(p: string, t: T, s?: string) {
		const cs = this.#getStoredCredentials(p)
			.map((entry, i) => ({ credential: entry.credential as Extract<AuthCredential, { type: T }>, index: i }))
			.filter(e => e.credential.type === t);
		if (cs.length === 0) return undefined;
		const pk = `${p}:${t}`;
		const order = this.#getCredentialOrder(pk, s, cs.length);
		for (const idx of order)
			if (this.#getResolverCtx().getCredentialBlockedUntil(pk, cs[idx].index) === undefined) return cs[idx];
		return cs[order[0]];
	}

	#recordSessionCredential(p: string, s: string | undefined, t: string, i: number) {
		if (s === undefined || s === "") return;
		const sm = this.#sessionLastCredential.get(p) ?? new Map();
		sm.set(s, { type: t, index: i });
		this.#sessionLastCredential.set(p, sm);
	}

	async fetchUsageReports(opts?: {
		baseUrlResolver?: (p: Provider) => string | undefined;
	}): Promise<UsageReport[] | null> {
		const reqs = this.#gatherUsageRequests(opts);
		if (reqs.length === 0) return [];
		const reqIds = reqs
			.map(
				r =>
					`${r.provider}:${r.baseUrl === undefined ? "def" : r.baseUrl}:${r.credential.accountId === undefined ? "anon" : r.credential.accountId}`,
			)
			.sort();
		const key = `reports:${Bun.hash(JSON.stringify(reqIds)).toString(16)}`;
		const cached = this.#usageCache.get<UsageReport[]>(key);
		if (cached && cached.expiresAt > Date.now()) return cached.value;
		const inFlight = this.#usageReportsInFlight.get(key);
		if (inFlight) return inFlight;
		const promise = (async () => {
			const res = await Promise.all(reqs.map(r => this.#fetchUsageCached(r, this.#usageRequestTimeoutMs)));
			const reports = res.filter((r): r is UsageReport => r !== null);
			const deduped = dedupeUsageReports(reports, this.#usageLogger);
			if (deduped.length > 0)
				this.#usageCache.set(key, { value: deduped, expiresAt: Date.now() + USAGE_REPORT_TTL_MS });
			return deduped.length > 0 ? deduped : (cached?.value ?? []);
		})().finally(() => this.#usageReportsInFlight.delete(key));
		this.#usageReportsInFlight.set(key, promise);
		return promise;
	}

	#gatherUsageRequests(opts?: { baseUrlResolver?: (p: Provider) => string | undefined }): UsageRequestDescriptor[] {
		const providers = new Set([...this.#data.keys(), ...Array.from(DEFAULT_USAGE_PROVIDER_MAP.keys())]);
		const reqs: UsageRequestDescriptor[] = [];
		for (const pid of providers) {
			const p = pid as Provider;
			const impl = this.#usageProviderResolver(p);
			if (impl) this.#gatherProviderUsageRequests(p, impl, reqs, opts?.baseUrlResolver?.(p));
		}
		return reqs;
	}

	#gatherProviderUsageRequests(p: Provider, impl: UsageProvider, reqs: UsageRequestDescriptor[], bu?: string): void {
		const ents = this.#getStoredCredentials(p);
		if (ents.length === 0) {
			const k = this.#runtimeOverrides.get(p) ?? getEnvApiKey(p);
			if (k !== undefined && k !== "") {
				const r = { provider: p, credential: { type: "api_key" as const, apiKey: k }, baseUrl: bu };
				if (!impl.supports || impl.supports(r)) reqs.push(r);
			}
		} else {
			for (const e of ents) {
				const r =
					e.credential.type === "api_key"
						? { provider: p, credential: { type: "api_key" as const, apiKey: e.credential.key }, baseUrl: bu }
						: { provider: p, credential: this.#buildUsageCredential(e.credential), baseUrl: bu };
				if (!impl.supports || impl.supports(r)) reqs.push(r);
			}
		}
	}

	async markUsageLimitReached(
		p: string,
		s: string | undefined,
		o?: { retryAfterMs?: number; baseUrl?: string },
	): Promise<boolean> {
		const cur = this.#getSessionCredential(p, s);
		if (cur === undefined) return false;
		const backoff = o?.retryAfterMs ?? 60_000;
		this.#getResolverCtx().markCredentialBlocked(`${p}:${cur.type}`, cur.index, Date.now() + backoff);
		return true;
	}

	#getSessionCredential(p: string, s: string | undefined) {
		return s === undefined || s === "" ? undefined : this.#sessionLastCredential.get(p)?.get(s);
	}
}
