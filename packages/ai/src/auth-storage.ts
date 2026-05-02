/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, refreshing credentials, and usage tracking.
 *
 * This module defines:
 * - `AuthCredentialStore` interface: abstracting persistence (SQLite, memory, etc.)
 * - `AuthStorage` class: credential management with round-robin, usage limits, OAuth refresh
 * - `AuthCredentialStore`: concrete SQLite-backed implementation
 */
import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "./stream";
import type { Provider } from "./types";
import type {
	CredentialRankingStrategy,
	UsageCredential,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "./usage";
import { kimiUsageProvider } from "./usage/kimi";
import { minimaxCodeUsageProvider } from "./usage/minimax-code";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./usage/openai-codex";
import { zaiUsageProvider } from "./usage/zai";
import { getOAuthApiKey, getOAuthProvider, refreshOAuthToken } from "./utils/oauth";
// Re-export login functions so consumers of AuthStorage.login() have access
// (these are used inside the login() switch-case)
import { loginKimi } from "./utils/oauth/kimi";
import { loginMiniMaxCode } from "./utils/oauth/minimax-code";
import { loginMoonshot } from "./utils/oauth/moonshot";
import { loginOpenAICodex } from "./utils/oauth/openai-codex";
import type { OAuthController, OAuthCredentials, OAuthProvider, OAuthProviderId } from "./utils/oauth/types";
import { loginZai } from "./utils/oauth/zai";

// ─────────────────────────────────────────────────────────────────────────────
// Credential Types
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthCredentialEntry = AuthCredential | AuthCredential[];

export type AuthStorageData = Record<string, AuthCredentialEntry>;

/**
 * Serialized representation of AuthStorage for passing to subagent workers.
 * Contains only the essential credential data, not runtime state.
 */
export interface SerializedAuthStorage {
	credentials: Record<
		string,
		Array<{
			id: number;
			type: "api_key" | "oauth";
			data: Record<string, unknown>;
		}>
	>;
	runtimeOverrides?: Record<string, string>;
	dbPath?: string;
}

/**
 * Auth credential with database row ID for updates/deletes.
 * Wraps AuthCredential with storage metadata.
 */
export interface StoredAuthCredential {
	id: number;
	provider: string;
	credential: AuthCredential;
	disabledCause: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Options
// ─────────────────────────────────────────────────────────────────────────────

export type AuthStorageOptions = {
	usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	usageFetch?: typeof fetch;
	usageRequestTimeoutMs?: number;
	usageLogger?: UsageLogger;
	/**
	 * Resolve a config value (API key, header value, etc.) to an actual value.
	 * - coding-agent injects its resolveConfigValue (supports "!command" syntax via pi-natives)
	 * - Default: checks environment variable first, then treats as literal
	 */
	configValueResolver?: (config: string) => Promise<string | undefined>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default Config Value Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default config value resolver that checks env vars and treats as literal.
 * Does NOT support "!command" syntax (that requires pi-natives).
 */
async function defaultConfigValueResolver(config: string): Promise<string | undefined> {
	const envValue = process.env[config];
	return envValue ?? config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Providers (defaults)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	zaiUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

const USAGE_CACHE_PREFIX = "usage_cache:";
const USAGE_REPORT_TTL_MS = 30_000;
const DEFAULT_USAGE_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 10_000;

type UsageCacheEntry<T> = {
	value: T;
	expiresAt: number;
};

interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

type UsageRequestDescriptor = {
	provider: Provider;
	credential: UsageCredential;
	baseUrl?: string;
};

type AuthApiKeyOptions = {
	baseUrl?: string;
	modelId?: string;
};

function requiresOpenAICodexProModel(provider: string, modelId: string | undefined): boolean {
	return provider === "openai-codex" && typeof modelId === "string" && modelId.includes("-spark");
}

function getUsagePlanType(report: UsageReport | null): string | undefined {
	const metadata = report?.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const planType = (metadata as { planType?: unknown }).planType;
	return typeof planType === "string" ? planType.toLowerCase() : undefined;
}

function getOpenAICodexPlanPriority(report: UsageReport | null): number {
	const planType = getUsagePlanType(report);
	if (planType === null || planType === undefined || planType === "") return 1;
	return planType.includes("pro") ? 0 : 2;
}

function hasOpenAICodexProPlan(report: UsageReport | null): boolean {
	return getUsagePlanType(report)?.includes("pro") === true;
}

function resolveDefaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["openai-codex", codexRankingStrategy],
]);

function resolveDefaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

function parseUsageCacheEntry<T>(raw: string): UsageCacheEntry<T> | undefined {
	try {
		const parsed = JSON.parse(raw) as { value?: T; expiresAt?: unknown };
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;
		if (expiresAt === null || expiresAt === undefined || expiresAt === 0 || !Number.isFinite(expiresAt))
			return undefined;
		return { value: parsed.value as T, expiresAt };
	} catch {
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Cache (backed by AuthCredentialStore)
// ─────────────────────────────────────────────────────────────────────────────

class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}

	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (raw === null || raw === undefined || raw === "") return undefined;
		return parseUsageCacheEntry<T>(raw);
	}

	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		const payload = JSON.stringify({ value: entry.value, expiresAt: entry.expiresAt });
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, payload, Math.floor(entry.expiresAt / 1000));
	}

	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory representation
// ─────────────────────────────────────────────────────────────────────────────

type StoredCredential = { id: number; credential: AuthCredential };

// ─────────────────────────────────────────────────────────────────────────────
// AuthStorage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential storage backed by an AuthCredentialStore.
 * Reads from storage on reload(), manages round-robin credential selection,
 * usage limit tracking, and OAuth token refresh.
 */
export class AuthStorage {
	static readonly #defaultBackoffMs = 60_000; // Default backoff when no reset time available

	/** Provider -> credentials cache, populated from store on reload(). */
	#data: Map<string, StoredCredential[]> = new Map();
	#runtimeOverrides: Map<string, string> = new Map();
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, Map<string, { type: AuthCredential["type"]; index: number }>> = new Map();
	/** Maps provider:type -> credentialIndex -> blockedUntilMs for temporary backoff. */
	#credentialBackoff: Map<string, Map<number, number>> = new Map();
	#usageProviderResolver?: (provider: Provider) => UsageProvider | undefined;
	#rankingStrategyResolver?: (provider: Provider) => CredentialRankingStrategy | undefined;
	#usageCache: UsageCache;
	#usageRequestInFlight: Map<string, Promise<UsageReport | null>> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[]>> = new Map();
	#usageFetch: typeof fetch;
	#usageRequestTimeoutMs: number;
	#usageLogger?: UsageLogger;
	#fallbackResolver?: (provider: string) => string | undefined;
	#store: AuthCredentialStore;
	#configValueResolver: (config: string) => Promise<string | undefined>;
	#closed = false;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#store = store;
		this.#configValueResolver = options.configValueResolver ?? defaultConfigValueResolver;
		this.#usageProviderResolver = options.usageProviderResolver ?? resolveDefaultUsageProvider;
		this.#rankingStrategyResolver = options.rankingStrategyResolver ?? resolveDefaultRankingStrategy;
		this.#usageCache = new AuthStorageUsageCache(this.#store);
		this.#usageFetch = options.usageFetch ?? fetch;
		this.#usageRequestTimeoutMs = options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS;
		this.#usageLogger =
			options.usageLogger ??
			({
				debug: (message, meta) => logger.debug(message, meta),
				warn: (message, meta) => logger.warn(message, meta),
			} satisfies UsageLogger);
	}

	/**
	 * Create an AuthStorage instance backed by a AuthCredentialStore.
	 * Convenience factory for standalone use (e.g., pi-ai CLI).
	 * @param dbPath - Path to SQLite database
	 */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await AuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/**
	 * Close the underlying credential store.
	 *
	 * After calling this, the instance must not be reused.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#store.close();
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.#runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.#runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in storage or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.#fallbackResolver = resolver;
	}

	/**
	 * Reload credentials from storage.
	 */
	async reload(): Promise<void> {
		const records = this.#store.listAuthCredentials();
		const grouped = new Map<string, StoredCredential[]>();
		for (const record of records) {
			const list = grouped.get(record.provider) ?? [];
			list.push({ id: record.id, credential: record.credential });
			grouped.set(record.provider, list);
		}

		const dedupedGrouped = new Map<string, StoredCredential[]>();
		for (const [provider, entries] of grouped.entries()) {
			const deduped = this.#pruneDuplicateStoredCredentials(provider, entries);
			if (deduped.length > 0) {
				dedupedGrouped.set(provider, deduped);
			}
		}
		this.#data = dedupedGrouped;
	}

	/**
	 * Gets cached credentials for a provider.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @returns Array of stored credentials, empty if none exist
	 */
	#getStoredCredentials(provider: string): StoredCredential[] {
		return this.#data.get(provider) ?? [];
	}

	/**
	 * Updates in-memory credential cache for a provider.
	 * Removes the provider entry entirely if credentials array is empty.
	 * @param provider - Provider name (e.g., "anthropic", "openai")
	 * @param credentials - Array of stored credentials to cache
	 */
	#setStoredCredentials(provider: string, credentials: StoredCredential[]): void {
		if (credentials.length === 0) {
			this.#data.delete(provider);
		} else {
			this.#data.set(provider, credentials);
		}
	}

	#resolveOAuthDedupeIdentityKey(provider: string, credential: OAuthCredential): string | null {
		return resolveCredentialIdentityKey(provider, credential);
	}

	#dedupeOAuthCredentials(provider: string, credentials: AuthCredential[]): AuthCredential[] {
		const seen = new Set<string>();
		const deduped: AuthCredential[] = [];
		for (let index = credentials.length - 1; index >= 0; index -= 1) {
			const credential = credentials[index];
			if (credential.type !== "oauth") {
				deduped.push(credential);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (identityKey === null || identityKey === undefined || identityKey === "") {
				deduped.push(credential);
				continue;
			}
			if (seen.has(identityKey)) {
				continue;
			}
			seen.add(identityKey);
			deduped.push(credential);
		}
		return deduped.reverse();
	}

	#pruneDuplicateStoredCredentials(provider: string, entries: StoredCredential[]): StoredCredential[] {
		const seen = new Set<string>();
		const kept: StoredCredential[] = [];
		const removed: StoredCredential[] = [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			const credential = entry.credential;
			if (credential.type !== "oauth") {
				kept.push(entry);
				continue;
			}
			const identityKey = this.#resolveOAuthDedupeIdentityKey(provider, credential);
			if (identityKey === null || identityKey === undefined || identityKey === "") {
				kept.push(entry);
				continue;
			}
			if (seen.has(identityKey)) {
				removed.push(entry);
				continue;
			}
			seen.add(identityKey);
			kept.push(entry);
		}
		if (removed.length > 0) {
			for (const entry of removed) {
				this.#store.deleteAuthCredential(entry.id, "deduplicated duplicate credential");
			}
			this.#resetProviderAssignments(provider);
		}
		return kept.reverse();
	}

	/** Returns all credentials for a provider as an array */
	#getCredentialsForProvider(provider: string): AuthCredential[] {
		return this.#getStoredCredentials(provider).map(entry => entry.credential);
	}

	/** Composite key for round-robin tracking: "anthropic:oauth" or "openai:api_key" */
	#getProviderTypeKey(provider: string, type: AuthCredential["type"]): string {
		return `${provider}:${type}`;
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start =
			sessionId !== null && sessionId !== undefined && sessionId !== ""
				? this.#getHashedIndex(sessionId, total)
				: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/** Returns block expiry timestamp for a credential, cleaning up expired entries. */
	#getCredentialBlockedUntil(providerKey: string, credentialIndex: number): number | undefined {
		const backoffMap = this.#credentialBackoff.get(providerKey);
		if (!backoffMap) return undefined;
		const blockedUntil = backoffMap.get(credentialIndex);
		if (blockedUntil === null || blockedUntil === undefined || blockedUntil === 0) return undefined;
		if (blockedUntil <= Date.now()) {
			backoffMap.delete(credentialIndex);
			if (backoffMap.size === 0) {
				this.#credentialBackoff.delete(providerKey);
			}
			return undefined;
		}
		return blockedUntil;
	}

	/** Checks if a credential is temporarily blocked due to usage limits. */
	#isCredentialBlocked(providerKey: string, credentialIndex: number): boolean {
		return this.#getCredentialBlockedUntil(providerKey, credentialIndex) !== undefined;
	}

	/** Marks a credential as blocked until the specified time. */
	#markCredentialBlocked(providerKey: string, credentialIndex: number, blockedUntilMs: number): void {
		const backoffMap = this.#credentialBackoff.get(providerKey) ?? new Map<number, number>();
		const existing = backoffMap.get(credentialIndex) ?? 0;
		backoffMap.set(credentialIndex, Math.max(existing, blockedUntilMs));
		this.#credentialBackoff.set(providerKey, backoffMap);
	}

	/** Records which credential was used for a session (for rate-limit switching). */
	#recordSessionCredential(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
	): void {
		if (sessionId === null || sessionId === undefined || sessionId === "") return;
		const sessionMap = this.#sessionLastCredential.get(provider) ?? new Map();
		sessionMap.set(sessionId, { type, index });
		this.#sessionLastCredential.set(provider, sessionMap);
	}

	/** Retrieves the last credential used by a session. */
	#getSessionCredential(
		provider: string,
		sessionId: string | undefined,
	): { type: AuthCredential["type"]; index: number } | undefined {
		if (sessionId === null || sessionId === undefined || sessionId === "") return undefined;
		return this.#sessionLastCredential.get(provider)?.get(sessionId);
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	#selectCredentialByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: Extract<AuthCredential, { type: T }>; index: number } =>
					entry.credential.type === type,
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = this.#getProviderTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#isCredentialBlocked(providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	/**
	 * Clears round-robin and session assignment state for a provider.
	 * Called when credentials are added/removed to prevent stale index references.
	 */
	#resetProviderAssignments(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
		this.#sessionLastCredential.delete(provider);
		for (const key of this.#credentialBackoff.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#credentialBackoff.delete(key);
			}
		}
	}

	/** Updates credential at index in-place (used for OAuth token refresh) */
	#replaceCredentialAt(provider: string, index: number, credential: AuthCredential): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		const target = entries[index];
		this.#store.updateAuthCredential(target.id, credential);
		const updated = [...entries];
		updated[index] = { id: target.id, credential };
		this.#setStoredCredentials(provider, updated);
	}

	/**
	 * Disables credential at index (used when OAuth refresh fails).
	 * The credential remains in the database but is excluded from active queries.
	 * Cleans up provider entry if last credential disabled.
	 */
	#disableCredentialAt(provider: string, index: number, disabledCause: string): void {
		const entries = this.#getStoredCredentials(provider);
		if (index < 0 || index >= entries.length) return;
		this.#store.deleteAuthCredential(entries[index].id, disabledCause);
		const updated = entries.filter((_value, idx) => idx !== index);
		this.#setStoredCredentials(provider, updated);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * Get credential for a provider (first entry if multiple).
	 */
	get(provider: string): AuthCredential | undefined {
		return this.#getCredentialsForProvider(provider)[0];
	}

	/**
	 * Set credential for a provider.
	 */
	async set(provider: string, credential: AuthCredentialEntry): Promise<void> {
		const normalized = Array.isArray(credential) ? credential : [credential];
		const deduped = this.#dedupeOAuthCredentials(provider, normalized);
		const stored = this.#store.replaceAuthCredentialsForProvider(provider, deduped);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	async #upsertOAuthCredential(provider: string, credential: OAuthCredential): Promise<void> {
		const stored = this.#store.upsertAuthCredentialForProvider(provider, credential);
		this.#setStoredCredentials(
			provider,
			stored.map(record => ({ id: record.id, credential: record.credential })),
		);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * Remove credential for a provider.
	 */
	async remove(provider: string): Promise<void> {
		this.#store.deleteAuthCredentialsForProvider(provider, "deleted by user");
		this.#data.delete(provider);
		this.#resetProviderAssignments(provider);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return [...this.#data.keys()];
	}

	/**
	 * Check if credentials exist for a provider in storage.
	 */
	has(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).length > 0;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.#runtimeOverrides.has(provider)) return true;
		if (this.#getCredentialsForProvider(provider).length > 0) return true;
		if (getEnvApiKey(provider) !== undefined && getEnvApiKey(provider) !== "") return true;
		if (this.#fallbackResolver?.(provider) !== undefined && this.#fallbackResolver?.(provider) !== "") return true;
		return false;
	}

	/**
	 * Check if OAuth credentials are configured for a provider.
	 */
	hasOAuth(provider: string): boolean {
		return this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth");
	}

	/**
	 * Get OAuth credentials for a provider.
	 */
	getOAuthCredential(provider: string): OAuthCredential | undefined {
		return this.#getCredentialsForProvider(provider).find(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
	}

	/**
	 * Get all credentials.
	 */
	getAll(): AuthStorageData {
		const result: AuthStorageData = {};
		for (const [provider, entries] of this.#data.entries()) {
			const credentials = entries.map(entry => entry.credential);
			if (credentials.length === 1) {
				result[provider] = credentials[0];
			} else if (credentials.length > 1) {
				result[provider] = credentials;
			}
		}
		return result;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(
		provider: OAuthProviderId,
		ctrl: OAuthController & {
			/** onAuth is required by auth-storage but optional in OAuthController */
			onAuth: (info: { url: string; instructions?: string }) => void;
			/** onPrompt is required for some providers (github-copilot, openai-codex) */
			onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
		},
	): Promise<void> {
		let credentials: OAuthCredentials;
		const manualCodeInput = () => ctrl.onPrompt({ message: "Paste the authorization code (or full redirect URL):" });
		switch (provider) {
			case "openai-codex":
				credentials = await loginOpenAICodex({
					...ctrl,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
				});
				break;
			case "kimi":
				credentials = await loginKimi(ctrl);
				break;
			case "moonshot":
				credentials = await loginMoonshot(ctrl);
				break;
			case "zai": {
				const apiKey = await loginZai(ctrl);
				await this.set(provider, { type: "api_key", key: apiKey });
				return;
			}
			case "minimax-code": {
				const apiKey = await loginMiniMaxCode(ctrl);
				await this.set(provider, { type: "api_key", key: apiKey });
				return;
			}
			default: {
				const customProvider = getOAuthProvider(provider);
				if (customProvider === null || customProvider === undefined) {
					throw new Error(`Unknown OAuth provider: ${provider}`);
				}
				const customLoginResult = await customProvider.login({
					onAuth: info => ctrl.onAuth(info),
					onProgress: ctrl.onProgress,
					onPrompt: ctrl.onPrompt,
					onManualCodeInput: ctrl.onManualCodeInput ?? manualCodeInput,
					signal: ctrl.signal,
				});
				if (typeof customLoginResult === "string") {
					await this.set(provider, { type: "api_key", key: customLoginResult });
					return;
				}
				credentials = customLoginResult;
				break;
			}
		}
		const newCredential: OAuthCredential = { type: "oauth", ...credentials };
		await this.#upsertOAuthCredential(provider, newCredential);
	}

	/**
	 * Logout from a provider.
	 */
	async logout(provider: string): Promise<void> {
		await this.remove(provider);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Usage API Integration
	// Queries provider usage endpoints to detect rate limits before they occur.
	// ─────────────────────────────────────────────────────────────────────────────

	#buildUsageCredential(credential: OAuthCredential): UsageCredential {
		return {
			type: "oauth",
			accessToken: credential.access,
			refreshToken: credential.refresh,
			expiresAt: credential.expires,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
		};
	}

	#buildUsageCacheIdentity(credential: UsageCredential): string {
		const parts: string[] = [credential.type];
		const accountId = credential.accountId?.trim();
		if (accountId !== null && accountId !== undefined && accountId !== "") parts.push(`account:${accountId}`);
		const email = credential.email?.trim().toLowerCase();
		if (email !== null && email !== undefined && email !== "") parts.push(`email:${email}`);
		const projectId = credential.projectId?.trim();
		if (projectId !== null && projectId !== undefined && projectId !== "") parts.push(`project:${projectId}`);
		const enterpriseUrl = credential.enterpriseUrl?.trim().toLowerCase();
		if (enterpriseUrl !== null && enterpriseUrl !== undefined && enterpriseUrl !== "")
			parts.push(`enterprise:${enterpriseUrl}`);
		// Only fall back to a secret-derived key when a stable account identifier is unavailable.
		// Including the token hash when accountId/email are present causes cache misses on
		// every OAuth refresh — usage data is per-account, not per-token.
		const hasStableIdentifier = Boolean(accountId ?? email);
		if (!hasStableIdentifier) {
			const secret = credential.apiKey?.trim() ?? credential.refreshToken?.trim() ?? credential.accessToken?.trim();
			if (secret !== null && secret !== undefined && secret !== "") {
				parts.push(`secret:${Bun.hash(secret).toString(16)}`);
			} else {
				parts.push("anonymous");
			}
		}
		return parts.join("|");
	}

	#normalizeUsageBaseUrl(baseUrl?: string): string {
		return baseUrl?.trim().replace(/\/+$/, "") ?? "";
	}

	#buildUsageReportCacheKey(request: UsageRequestDescriptor): string {
		const baseUrl = this.#normalizeUsageBaseUrl(request.baseUrl) || "default";
		const identity = this.#buildUsageCacheIdentity(request.credential);
		return `report:${request.provider}:${baseUrl}:${identity}`;
	}

	#buildUsageReportsCacheKey(requests: ReadonlyArray<UsageRequestDescriptor>): string {
		const snapshot = requests
			.map(
				request =>
					`${request.provider}:${this.#normalizeUsageBaseUrl(request.baseUrl) || "default"}:${this.#buildUsageCacheIdentity(request.credential)}`,
			)
			.sort()
			.join("\n");
		return `reports:${Bun.hash(snapshot).toString(16)}`;
	}

	#buildUsageRequest(provider: Provider, credential: UsageCredential, baseUrl?: string): UsageRequestDescriptor {
		return { provider, credential, baseUrl };
	}

	#buildUsageRequestForOauth(
		provider: Provider,
		credential: OAuthCredential,
		baseUrl?: string,
	): UsageRequestDescriptor {
		return this.#buildUsageRequest(provider, this.#buildUsageCredential(credential), baseUrl);
	}

	#buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
		if (
			credential.accessToken === null ||
			credential.accessToken === undefined ||
			credential.accessToken === "" ||
			credential.refreshToken === null ||
			credential.refreshToken === undefined ||
			credential.refreshToken === "" ||
			credential.expiresAt === undefined
		) {
			return null;
		}
		return {
			type: "oauth",
			access: credential.accessToken,
			refresh: credential.refreshToken,
			expires: credential.expiresAt,
			accountId: credential.accountId,
			projectId: credential.projectId,
			email: credential.email,
			enterpriseUrl: credential.enterpriseUrl,
		};
	}

	#mergeRefreshedUsageCredential(credential: UsageCredential, refreshed: OAuthCredentials): UsageCredential {
		return {
			...credential,
			accessToken: refreshed.access,
			refreshToken: refreshed.refresh,
			expiresAt: refreshed.expires,
			accountId: refreshed.accountId ?? credential.accountId,
			projectId: refreshed.projectId ?? credential.projectId,
			email: refreshed.email ?? credential.email,
			enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
		};
	}

	#persistRefreshedUsageCredential(provider: Provider, previous: UsageCredential, next: UsageCredential): void {
		const entries = this.#getStoredCredentials(provider);
		const index = entries.findIndex(entry => {
			if (entry.credential.type !== "oauth") return false;
			if (
				previous.refreshToken !== null &&
				previous.refreshToken !== undefined &&
				previous.refreshToken !== "" &&
				entry.credential.refresh === previous.refreshToken
			)
				return true;
			if (
				previous.accessToken !== null &&
				previous.accessToken !== undefined &&
				previous.accessToken !== "" &&
				entry.credential.access === previous.accessToken
			)
				return true;
			return (
				entry.credential.accountId === previous.accountId &&
				entry.credential.email === previous.email &&
				entry.credential.projectId === previous.projectId
			);
		});
		if (index === -1) return;
		const existing = entries[index]?.credential;
		if (existing.type !== "oauth") return;
		this.#replaceCredentialAt(provider, index, {
			type: "oauth",
			access: next.accessToken ?? existing.access,
			refresh: next.refreshToken ?? existing.refresh,
			expires: next.expiresAt ?? existing.expires,
			accountId: next.accountId,
			projectId: next.projectId,
			email: next.email,
			enterpriseUrl: next.enterpriseUrl,
		});
	}

	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return null;

		const providerImpl = resolver(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageRequestDescriptor & { signal?: AbortSignal } = { ...request, signal: timeoutSignal };

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() >= request.credential.expiresAt
		) {
			const refreshableCredential = this.#buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshed = await this.#refreshOAuthCredential(request.provider, refreshableCredential);
					const refreshedCredential = this.#mergeRefreshedUsageCredential(request.credential, refreshed);
					this.#persistRefreshedUsageCredential(request.provider, request.credential, refreshedCredential);
					params = {
						...params,
						credential: refreshedCredential,
					};
				} catch (error) {
					this.#usageLogger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: String(error),
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			return await providerImpl.fetchUsage(params, {
				fetch: this.#usageFetch,
				logger: this.#usageLogger,
			});
		} catch (error) {
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	async #fetchUsageCached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const cacheKey = this.#buildUsageReportCacheKey(request);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport | null>(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			if (report !== null) {
				this.#usageCache.set(cacheKey, { value: report, expiresAt: Date.now() + USAGE_REPORT_TTL_MS });
				return report;
			}
			return cached?.value ?? null;
		})().finally(() => {
			this.#usageRequestInFlight.delete(cacheKey);
		});

		this.#usageRequestInFlight.set(cacheKey, promise);
		return promise;
	}

	#collectUsageRequests(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): UsageRequestDescriptor[] {
		const resolver = this.#usageProviderResolver;
		if (!resolver) return [];

		const requests: UsageRequestDescriptor[] = [];
		const providers = new Set<string>([
			...this.#data.keys(),
			...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
		]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = resolver(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#getStoredCredentials(providerId);
			if (entries.length > 0) {
				const dedupedEntries = this.#pruneDuplicateStoredCredentials(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#setStoredCredentials(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#runtimeOverrides.get(providerId);
				const envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? envKey;
				if (apiKey === null || apiKey === undefined || apiKey === "") continue;
				const request = this.#buildUsageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				const request =
					credential.type === "api_key"
						? this.#buildUsageRequest(provider, { type: "api_key", apiKey: credential.key }, baseUrl)
						: this.#buildUsageRequestForOauth(provider, credential, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	#getUsageReportMetadataValue(report: UsageReport, key: string): string | undefined {
		const metadata = report.metadata;
		if (!metadata || typeof metadata !== "object") return undefined;
		const value = metadata[key];
		return typeof value === "string" ? value.trim() : undefined;
	}

	#getUsageReportScopeAccountId(report: UsageReport): string | undefined {
		const ids = new Set<string>();
		for (const limit of report.limits) {
			const accountId = limit.scope.accountId?.trim();
			if (accountId !== null && accountId !== undefined && accountId !== "") ids.add(accountId);
		}
		if (ids.size === 1) return [...ids][0];
		return undefined;
	}

	#getUsageReportIdentifiers(report: UsageReport): string[] {
		const identifiers: string[] = [];
		const email = this.#getUsageReportMetadataValue(report, "email");
		if (email !== null && email !== undefined && email !== "") identifiers.push(`email:${email.toLowerCase()}`);
		if (report.provider === "openai-codex") {
			return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
		}
		const accountId = this.#getUsageReportMetadataValue(report, "accountId");
		if (accountId !== null && accountId !== undefined && accountId !== "") identifiers.push(`account:${accountId}`);
		const account = this.#getUsageReportMetadataValue(report, "account");
		if (account !== null && account !== undefined && account !== "") identifiers.push(`account:${account}`);
		const user = this.#getUsageReportMetadataValue(report, "user");
		if (user !== null && user !== undefined && user !== "") identifiers.push(`account:${user}`);
		const username = this.#getUsageReportMetadataValue(report, "username");
		if (username !== null && username !== undefined && username !== "") identifiers.push(`account:${username}`);
		const scopeAccountId = this.#getUsageReportScopeAccountId(report);
		if (scopeAccountId !== null && scopeAccountId !== undefined && scopeAccountId !== "")
			identifiers.push(`account:${scopeAccountId}`);
		return identifiers.map(identifier => `${report.provider}:${identifier.toLowerCase()}`);
	}

	#mergeUsageReportGroup(reports: UsageReport[]): UsageReport {
		if (reports.length === 1) return reports[0];
		const sorted = [...reports].sort((a, b) => {
			const limitDiff = b.limits.length - a.limits.length;
			if (limitDiff !== 0) return limitDiff;
			return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
		});
		const base = sorted[0];
		const mergedLimits = [...base.limits];
		const limitIds = new Set(mergedLimits.map(limit => limit.id));
		const mergedMetadata: Record<string, unknown> = { ...base.metadata };
		let fetchedAt = base.fetchedAt;

		for (const report of sorted.slice(1)) {
			fetchedAt = Math.max(fetchedAt, report.fetchedAt);
			for (const limit of report.limits) {
				if (!limitIds.has(limit.id)) {
					limitIds.add(limit.id);
					mergedLimits.push(limit);
				}
			}
			if (report.metadata) {
				for (const [key, value] of Object.entries(report.metadata)) {
					if (mergedMetadata[key] === undefined) {
						mergedMetadata[key] = value;
					}
				}
			}
		}

		return {
			...base,
			fetchedAt,
			limits: mergedLimits,
			metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
		};
	}

	#dedupeUsageReports(reports: UsageReport[]): UsageReport[] {
		const groups: UsageReport[][] = [];
		const idToGroup = new Map<string, number>();

		for (const report of reports) {
			const identifiers = this.#getUsageReportIdentifiers(report);
			let groupIndex: number | undefined;
			for (const identifier of identifiers) {
				const existing = idToGroup.get(identifier);
				if (existing !== undefined) {
					groupIndex = existing;
					break;
				}
			}
			if (groupIndex === undefined) {
				groupIndex = groups.length;
				groups.push([]);
			}
			groups[groupIndex].push(report);
			for (const identifier of identifiers) {
				idToGroup.set(identifier, groupIndex);
			}
		}

		const deduped = groups.map(group => this.#mergeUsageReportGroup(group));
		if (deduped.length !== reports.length) {
			this.#usageLogger?.debug("Usage reports deduped", {
				before: reports.length,
				after: deduped.length,
			});
		}
		return deduped;
	}

	#isUsageLimitExhausted(limit: UsageLimit): boolean {
		if (limit.status === "exhausted") return true;
		const amount = limit.amount;
		if (amount.usedFraction !== undefined && amount.usedFraction >= 1) return true;
		if (amount.remainingFraction !== undefined && amount.remainingFraction <= 0) return true;
		if (amount.used !== undefined && amount.limit !== undefined && amount.used >= amount.limit) return true;
		if (amount.remaining !== undefined && amount.remaining <= 0) return true;
		if (amount.unit === "percent" && amount.used !== undefined && amount.used >= 100) return true;
		return false;
	}

	/** Returns true if usage indicates rate limit has been reached. */
	#isUsageLimitReached(report: UsageReport): boolean {
		return report.limits.some(limit => this.#isUsageLimitExhausted(limit));
	}

	/** Extracts the earliest reset timestamp from exhausted windows (in ms). */
	#getUsageResetAtMs(report: UsageReport, nowMs: number): number | undefined {
		const candidates: number[] = [];
		for (const limit of report.limits) {
			if (!this.#isUsageLimitExhausted(limit)) continue;
			const window = limit.window;
			if (
				window?.resetsAt !== null &&
				window?.resetsAt !== undefined &&
				window?.resetsAt !== 0 &&
				window.resetsAt > nowMs
			) {
				candidates.push(window.resetsAt);
			}
		}
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	async #getUsageReport(
		provider: Provider,
		credential: OAuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number },
	): Promise<UsageReport | null> {
		return this.#fetchUsageCached(
			this.#buildUsageRequestForOauth(provider, credential, options?.baseUrl),
			options?.timeoutMs ?? this.#usageRequestTimeoutMs,
		);
	}

	async fetchUsageReports(options?: {
		baseUrlResolver?: (provider: Provider) => string | undefined;
	}): Promise<UsageReport[] | null> {
		if (!this.#usageProviderResolver) return null;

		const requests = this.#collectUsageRequests(options);
		if (requests.length === 0) return [];

		this.#usageLogger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		const cacheKey = this.#buildUsageReportsCacheKey(requests);
		const now = Date.now();
		const cached = this.#usageCache.get<UsageReport[]>(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const promise = (async () => {
			for (const request of requests) {
				this.#usageLogger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await Promise.all(
				requests.map(request => this.#fetchUsageCached(request, this.#usageRequestTimeoutMs)),
			);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = this.#dedupeUsageReports(reports);
			if (deduped.length > 0) {
				this.#usageCache.set(cacheKey, { value: deduped, expiresAt: Date.now() + USAGE_REPORT_TTL_MS });
			}
			const resolved = deduped.length > 0 ? deduped : (cached?.value ?? []);
			this.#usageLogger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						this.#getUsageReportMetadataValue(report, "email") ??
						this.#getUsageReportMetadataValue(report, "accountId") ??
						this.#getUsageReportMetadataValue(report, "account") ??
						this.#getUsageReportMetadataValue(report, "user") ??
						this.#getUsageReportMetadataValue(report, "username") ??
						this.#getUsageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return promise;
	}

	/**
	 * Marks the current session's credential as temporarily blocked due to usage limits.
	 * Uses usage reports to determine accurate reset time when available.
	 * Returns true if a credential was blocked, enabling automatic fallback to the next credential.
	 */
	async markUsageLimitReached(
		provider: string,
		sessionId: string | undefined,
		options?: { retryAfterMs?: number; baseUrl?: string },
	): Promise<boolean> {
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		if (!sessionCredential) return false;

		const providerKey = this.#getProviderTypeKey(provider, sessionCredential.type);
		const now = Date.now();
		let blockedUntil = now + (options?.retryAfterMs ?? AuthStorage.#defaultBackoffMs);

		if (sessionCredential.type === "oauth" && this.#rankingStrategyResolver?.(provider)) {
			const credential = this.#getCredentialsForProvider(provider)[sessionCredential.index];
			if (credential?.type === "oauth") {
				const report = await this.#getUsageReport(provider, credential, options);
				if (report && this.#isUsageLimitReached(report)) {
					const resetAtMs = this.#getUsageResetAtMs(report, Date.now());
					if (resetAtMs !== null && resetAtMs !== undefined && resetAtMs !== 0 && resetAtMs > blockedUntil) {
						blockedUntil = resetAtMs;
					}
				}
			}
		}

		this.#markCredentialBlocked(providerKey, sessionCredential.index, blockedUntil);

		const remainingCredentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(entry): entry is { credential: AuthCredential; index: number } =>
					entry.credential.type === sessionCredential.type && entry.index !== sessionCredential.index,
			);

		return remainingCredentials.some(candidate => !this.#isCredentialBlocked(providerKey, candidate.index));
	}

	#resolveWindowResetAt(window: UsageLimit["window"]): number | undefined {
		if (!window) return undefined;
		if (typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)) {
			return window.resetsAt;
		}
		return undefined;
	}

	#normalizeUsageFraction(limit: UsageLimit | undefined): number {
		const usedFraction = limit?.amount.usedFraction;
		if (typeof usedFraction !== "number" || !Number.isFinite(usedFraction)) {
			return 0.5;
		}
		return Math.min(Math.max(usedFraction, 0), 1);
	}

	/** Computes `usedFraction / elapsedHours` — consumption rate per hour within the current window. Lower drain rate = less pressure = preferred. */
	#computeWindowDrainRate(limit: UsageLimit | undefined, nowMs: number, fallbackDurationMs: number): number {
		const usedFraction = this.#normalizeUsageFraction(limit);
		const durationMs = limit?.window?.durationMs ?? fallbackDurationMs;
		if (!Number.isFinite(durationMs) || durationMs <= 0) {
			return usedFraction;
		}
		const resetAt = this.#resolveWindowResetAt(limit?.window);
		if (!Number.isFinite(resetAt)) {
			return usedFraction;
		}
		const remainingWindowMs = (resetAt as number) - nowMs;
		const clampedRemainingWindowMs = Math.min(Math.max(remainingWindowMs, 0), durationMs);
		const elapsedMs = durationMs - clampedRemainingWindowMs;
		if (elapsedMs <= 0) {
			return usedFraction;
		}
		const elapsedHours = elapsedMs / (60 * 60 * 1000);
		if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
			return usedFraction;
		}
		return usedFraction / elapsedHours;
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: Array<{ credential: OAuthCredential; index: number }>;
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
	}): Promise<
		Array<{
			selection: { credential: OAuthCredential; index: number };
			usage: UsageReport | null;
			usageChecked: boolean;
		}>
	> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: Array<{
			selection: { credential: OAuthCredential; index: number };
			usage: UsageReport | null;
			usageChecked: boolean;
			blocked: boolean;
			blockedUntil?: number;
			hasPriorityBoost: boolean;
			secondaryUsed: number;
			secondaryDrainRate: number;
			primaryUsed: number;
			primaryDrainRate: number;
			orderPos: number;
		}> = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials
		const usageResults = await Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (selection === undefined) return null;
				const blockedUntil = this.#getCredentialBlockedUntil(args.providerKey, selection.index);
				if (blockedUntil !== undefined) return { selection, usage: null, usageChecked: false, blockedUntil };
				const usage = await this.#getUsageReport(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
				return { selection, usage, usageChecked: true, blockedUntil: undefined as number | undefined };
			}),
		);

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			if (!blocked && usage && this.#isUsageLimitReached(usage)) {
				const resetAtMs = this.#getUsageResetAtMs(usage, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs;
				this.#markCredentialBlocked(args.providerKey, selection.index, blockedUntil);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const secondaryTarget = secondary ?? primary;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary) ?? false,
				secondaryUsed: this.#normalizeUsageFraction(secondaryTarget),
				secondaryDrainRate: this.#computeWindowDrainRate(
					secondaryTarget,
					nowMs,
					strategy.windowDefaults.secondaryMs,
				),
				primaryUsed: this.#normalizeUsageFraction(primary),
				primaryDrainRate: this.#computeWindowDrainRate(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		ranked.sort((left, right) => {
			if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
			if (left.blocked && right.blocked) {
				const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
				const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
				if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
				return left.orderPos - right.orderPos;
			}
			if (requiresOpenAICodexProModel(args.provider, args.options?.modelId)) {
				const leftPlanPriority = getOpenAICodexPlanPriority(left.usage);
				const rightPlanPriority = getOpenAICodexPlanPriority(right.usage);
				if (leftPlanPriority !== rightPlanPriority) return leftPlanPriority - rightPlanPriority;
			}
			if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
			if (left.secondaryDrainRate !== right.secondaryDrainRate)
				return left.secondaryDrainRate - right.secondaryDrainRate;
			if (left.secondaryUsed !== right.secondaryUsed) return left.secondaryUsed - right.secondaryUsed;
			if (left.primaryDrainRate !== right.primaryDrainRate) return left.primaryDrainRate - right.primaryDrainRate;
			if (left.primaryUsed !== right.primaryUsed) return left.primaryUsed - right.primaryUsed;
			return left.orderPos - right.orderPos;
		});
		return ranked.map(candidate => ({
			selection: candidate.selection,
			usage: candidate.usage,
			usageChecked: candidate.usageChecked,
		}));
	}

	/**
	 * Resolves an OAuth API key, trying credentials in priority order.
	 * Skips blocked credentials and checks usage limits for providers with usage data.
	 * Falls back to earliest-unblocking credential if all are blocked.
	 */
	async #resolveOAuthApiKey(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<string | undefined> {
		const credentials = this.#getCredentialsForProvider(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");

		if (credentials.length === 0) return undefined;

		const providerKey = this.#getProviderTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#rankingStrategyResolver?.(provider);
		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const checkUsage = strategy !== undefined && (credentials.length > 1 || requiresProModel);
		const sessionCredential = this.#getSessionCredential(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		// Skip ranking only when the session already has a working preferred credential — re-ranking
		// mid-session causes account switches that cold-start the server-side prompt cache. New sessions
		// (no preference) and sessions whose preferred is blocked still rank, so we pick the account
		// with the most headroom proactively and fall back intelligently when rate-limited.
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined && !this.#isCredentialBlocked(providerKey, sessionPreferredIndex);
		const shouldRank = checkUsage && (!sessionPreferredIsAvailable || requiresProModel);
		const candidates = shouldRank
			? await this.#rankOAuthSelections({ providerKey, provider, order, credentials, options, strategy: strategy! })
			: order
					.map(idx => credentials[idx])
					.filter((selection): selection is { credential: OAuthCredential; index: number } => Boolean(selection))
					.map(selection => ({ selection, usage: null, usageChecked: false }));

		if (sessionPreferredIndex !== undefined && !requiresProModel) {
			const sessionPreferredCandidate = candidates.findIndex(
				candidate =>
					!this.#isCredentialBlocked(providerKey, candidate.selection.index) &&
					candidate.selection.index === sessionPreferredIndex,
			);
			if (sessionPreferredCandidate > 0) {
				const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}
		await Promise.all(
			candidates.map(async candidate => {
				if (Date.now() < candidate.selection.credential.expires) return;
				const latestCredential = this.#getCredentialsForProvider(provider)[candidate.selection.index];
				if (latestCredential?.type === "oauth" && Date.now() < latestCredential.expires) {
					candidate.selection.credential = latestCredential;
					return;
				}
				try {
					const refreshedCredentials = await this.#refreshOAuthCredential(
						provider,
						candidate.selection.credential,
					);
					candidate.selection.credential = {
						...candidate.selection.credential,
						...refreshedCredentials,
						type: "oauth",
					};
				} catch {}
			}),
		);

		// Skip the Pro-plan filter when no candidate is confirmed Pro, so users with only
		// non-Pro accounts can still attempt Spark requests (e.g. trial/grandfathered access).
		const enforceProRequirement =
			requiresProModel && candidates.some(candidate => hasOpenAICodexProPlan(candidate.usage));

		const fallback = candidates[0];

		for (const candidate of candidates) {
			const apiKey = await this.#tryOAuthCredential(provider, candidate.selection, providerKey, sessionId, options, {
				checkUsage,
				allowBlocked: false,
				prefetchedUsage: candidate.usage,
				usagePrechecked: candidate.usageChecked,
				enforceProRequirement,
			});
			if (apiKey !== null && apiKey !== undefined && apiKey !== "") return apiKey;
		}

		if (fallback !== undefined && this.#isCredentialBlocked(providerKey, fallback.selection.index)) {
			return this.#tryOAuthCredential(provider, fallback.selection, providerKey, sessionId, options, {
				checkUsage,
				allowBlocked: true,
				prefetchedUsage: fallback.usage,
				usagePrechecked: fallback.usageChecked,
				enforceProRequirement,
			});
		}

		return undefined;
	}

	async #refreshOAuthCredential(provider: Provider, credential: OAuthCredential): Promise<OAuthCredentials> {
		if (Date.now() < credential.expires) return credential;
		const customProvider = getOAuthProvider(provider);
		let refreshPromise: Promise<OAuthCredentials>;
		if (customProvider !== null && customProvider !== undefined) {
			if (customProvider.refreshToken === null || customProvider.refreshToken === undefined) {
				throw new Error(`OAuth provider "${provider}" does not support token refresh`);
			}
			refreshPromise = customProvider.refreshToken(credential);
		} else {
			refreshPromise = refreshOAuthToken(provider as OAuthProvider, credential);
		}
		// Bound the refresh so a slow/hanging token endpoint cannot stall credential selection.
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error(`OAuth token refresh timed out for provider: ${provider}`)),
				DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
			);
		});
		try {
			return await Promise.race([refreshPromise, timeoutPromise]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async #tryOAuthCredential(
		provider: Provider,
		selection: { credential: OAuthCredential; index: number },
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: {
			checkUsage: boolean;
			allowBlocked: boolean;
			prefetchedUsage?: UsageReport | null;
			usagePrechecked?: boolean;
			enforceProRequirement?: boolean;
		},
	): Promise<string | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			enforceProRequirement,
		} = usageOptions;
		if (!allowBlocked && this.#isCredentialBlocked(providerKey, selection.index)) {
			return undefined;
		}

		const requiresProModel = requiresOpenAICodexProModel(provider, options?.modelId);
		const applyProFilter = enforceProRequirement ?? requiresProModel;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || requiresProModel) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
			} else {
				usage = await this.#getUsageReport(provider, selection.credential, {
					...options,
					timeoutMs: this.#usageRequestTimeoutMs,
				});
			}
			usageChecked = true;

			if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && this.#isUsageLimitReached(usage)) {
				const resetAtMs = this.#getUsageResetAtMs(usage, Date.now());
				this.#markCredentialBlocked(
					providerKey,
					selection.index,
					resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
				);
				return undefined;
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider !== null && customProvider !== undefined) {
				const refreshedCredentials = await this.#refreshOAuthCredential(provider, selection.credential);
				const apiKey =
					customProvider.getApiKey === null || customProvider.getApiKey === undefined
						? refreshedCredentials.access
						: customProvider.getApiKey(refreshedCredentials);
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: selection.credential,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated: OAuthCredential = {
				type: "oauth",
				access: result.newCredentials.access,
				refresh: result.newCredentials.refresh,
				expires: result.newCredentials.expires,
				accountId: result.newCredentials.accountId ?? selection.credential.accountId,
				email: result.newCredentials.email ?? selection.credential.email,
				projectId: result.newCredentials.projectId ?? selection.credential.projectId,
				enterpriseUrl: result.newCredentials.enterpriseUrl ?? selection.credential.enterpriseUrl,
			};
			this.#replaceCredentialAt(provider, selection.index, updated);
			if ((checkUsage && !allowBlocked) || requiresProModel) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#getUsageReport(provider, updated, {
						...options,
						timeoutMs: this.#usageRequestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyProFilter && !hasOpenAICodexProPlan(usage)) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && this.#isUsageLimitReached(usage)) {
					const resetAtMs = this.#getUsageResetAtMs(usage, Date.now());
					this.#markCredentialBlocked(
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + AuthStorage.#defaultBackoffMs,
					);
					return undefined;
				}
			}
			this.#recordSessionCredential(provider, sessionId, "oauth", selection.index);
			return result.apiKey;
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure =
				/invalid_grant|invalid_token|revoked|unauthorized|expired.*refresh|refresh.*expired/i.test(errorMsg) ||
				(/\b(401|403)\b/.test(errorMsg) && !/timeout|network|fetch failed|ECONNREFUSED/i.test(errorMsg));

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				// Permanently disable invalid credentials with an explicit cause for inspection/debugging
				this.#disableCredentialAt(provider, selection.index, `oauth refresh failed: ${errorMsg}`);
				if (this.#getCredentialsForProvider(provider).some(credential => credential.type === "oauth")) {
					return this.getApiKey(provider, sessionId, options);
				}
			} else {
				// Block temporarily for transient failures (5 minutes)
				this.#markCredentialBlocked(providerKey, selection.index, Date.now() + 5 * 60 * 1000);
			}
		}

		return undefined;
	}

	/**
	 * Peek at API key for a provider without refreshing OAuth tokens.
	 * Used for model discovery where we only need to know if credentials exist
	 * and get a best-effort token.
	 */
	async peekApiKey(provider: string): Promise<string | undefined> {
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey !== null && runtimeKey !== undefined && runtimeKey !== "") {
			return runtimeKey;
		}

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key");
		if (apiKeySelection) {
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		// Return current OAuth access token only if it is not already expired.
		const oauthSelection = this.#selectCredentialByType(provider, "oauth");
		if (oauthSelection) {
			const expiresAt = oauthSelection.credential.expires;
			if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				return oauthSelection.credential.access;
			}
		}

		const envKey = getEnvApiKey(provider);
		if (envKey !== null && envKey !== undefined && envKey !== "") return envKey;

		return this.#fallbackResolver?.(provider) ?? undefined;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from storage
	 * 3. OAuth token from storage (auto-refreshed)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.#runtimeOverrides.get(provider);
		if (runtimeKey !== null && runtimeKey !== undefined && runtimeKey !== "") {
			return runtimeKey;
		}

		const apiKeySelection = this.#selectCredentialByType(provider, "api_key", sessionId);
		if (apiKeySelection) {
			this.#recordSessionCredential(provider, sessionId, "api_key", apiKeySelection.index);
			return this.#configValueResolver(apiKeySelection.credential.key);
		}

		const oauthKey = await this.#resolveOAuthApiKey(provider, sessionId, options);
		if (oauthKey !== null && oauthKey !== undefined && oauthKey !== "") {
			return oauthKey;
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(provider);
		if (envKey !== null && envKey !== undefined && envKey !== "") return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		return this.#fallbackResolver?.(provider) ?? undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCredentialStore
// ─────────────────────────────────────────────────────────────────────────────

/** Row shape for auth_credentials table queries */
type AuthRow = {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	identity_key: string | null;
};

type SerializedCredentialRecord = {
	credentialType: AuthCredential["type"];
	data: string;
	identityKey: string | null;
};

const AUTH_SCHEMA_VERSION = 4;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

function normalizeStoredAccountId(accountId: string | null | undefined): string | null {
	const normalized = accountId?.trim();
	return normalized !== null && normalized !== undefined && normalized !== "" && normalized.length > 0
		? normalized
		: null;
}

function normalizeStoredEmail(email: string | null | undefined): string | null {
	const normalized = email?.trim().toLowerCase();
	return normalized !== null && normalized !== undefined && normalized !== "" && normalized.length > 0
		? normalized
		: null;
}

function normalizeStoredIdentityKey(identityKey: string | null | undefined): string | null {
	const normalized = identityKey?.trim();
	return normalized !== null && normalized !== undefined && normalized !== "" && normalized.length > 0
		? normalized
		: null;
}

function serializeCredential(provider: string, credential: AuthCredential): SerializedCredentialRecord | null {
	if (credential.type === "api_key") {
		return {
			credentialType: "api_key",
			data: JSON.stringify({ key: credential.key }),
			identityKey: null,
		};
	}
	if (credential.type === "oauth") {
		const { type: _type, ...rest } = credential;
		return {
			credentialType: "oauth",
			data: JSON.stringify(rest),
			identityKey: resolveCredentialIdentityKey(provider, credential),
		};
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.data);
	} catch {
		return null;
	}
	if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	if (row.credential_type === "api_key") {
		const data = parsed as Record<string, unknown>;
		if (typeof data.key === "string") {
			return { type: "api_key", key: data.key };
		}
	}
	if (row.credential_type === "oauth") {
		return { type: "oauth", ...(parsed as Record<string, unknown>) } as AuthCredential;
	}
	return null;
}

function normalizeDisabledCause(disabledCause: string): string {
	const normalized = disabledCause.trim();
	return normalized.length > 0 ? normalized : "disabled";
}

function toStoredAuthCredential(row: AuthRow, credential: AuthCredential): StoredAuthCredential {
	return { id: row.id, provider: row.provider, credential, disabledCause: row.disabled_cause };
}

function resolveProviderCredentialIdentityKey(provider: string, identifiers: string[]): string | null {
	const emailIdentifier = identifiers.find(identifier => identifier.startsWith("email:"));
	if (
		provider === "openai-codex" &&
		emailIdentifier !== null &&
		emailIdentifier !== undefined &&
		emailIdentifier !== ""
	)
		return emailIdentifier;
	const accountIdentifier = identifiers.find(identifier => identifier.startsWith("account:"));
	if (accountIdentifier !== null && accountIdentifier !== undefined && accountIdentifier !== "")
		return accountIdentifier;
	if (emailIdentifier !== null && emailIdentifier !== undefined && emailIdentifier !== "") return emailIdentifier;
	return null;
}

function resolveCredentialIdentityKey(provider: string, credential: AuthCredential): string | null {
	if (credential.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

function resolveRowCredentialIdentityKey(provider: string, row: AuthRow): string | null {
	const identityKey = normalizeStoredIdentityKey(row.identity_key);
	if (identityKey !== null && identityKey !== undefined && identityKey !== "") return identityKey;
	const credential = deserializeCredential(row);
	return credential?.type === "oauth" ? resolveCredentialIdentityKey(provider, credential) : null;
}

function matchesReplacementCredential(
	provider: string,
	existing: AuthCredential | null,
	existingIdentityKey: string | null,
	incoming: AuthCredential,
): boolean {
	if (!existing || existing.type !== incoming.type) return false;
	if (incoming.type === "api_key") {
		return existing.type === "api_key" && existing.key === incoming.key;
	}
	const incomingIdentityKey = resolveCredentialIdentityKey(provider, incoming);
	return incomingIdentityKey !== null && incomingIdentityKey === existingIdentityKey;
}

function extractOAuthCredentialIdentifiers(credential: OAuthCredential): string[] {
	const identifiers = new Set<string>();
	const accountId = normalizeStoredAccountId(credential.accountId);
	if (accountId !== null && accountId !== undefined && accountId !== "") identifiers.add(`account:${accountId}`);
	const email = normalizeStoredEmail(credential.email);
	if (email !== null && email !== undefined && email !== "") identifiers.add(`email:${email}`);
	const accessIdentifiers = extractOAuthTokenIdentifiers(credential.access) ?? [];
	for (const identifier of accessIdentifiers) {
		identifiers.add(identifier);
	}
	const refreshIdentifiers = extractOAuthTokenIdentifiers(credential.refresh) ?? [];
	for (const identifier of refreshIdentifiers) {
		identifiers.add(identifier);
	}
	return [...identifiers];
}

function extractOAuthTokenIdentifiers(token: string | undefined): string[] | undefined {
	if (token === null || token === undefined || token === "") return undefined;
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
		const identifiers = new Set<string>();
		const directEmail = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
		if (directEmail !== null && directEmail !== undefined && directEmail !== "")
			identifiers.add(`email:${directEmail}`);
		const openAiProfile = payload["https://api.openai.com/profile"];
		if (typeof openAiProfile === "object" && openAiProfile !== null && !Array.isArray(openAiProfile)) {
			const claimEmail = normalizeStoredEmail(
				(openAiProfile as Record<string, unknown>).email as string | undefined,
			);
			if (claimEmail !== null && claimEmail !== undefined && claimEmail !== "")
				identifiers.add(`email:${claimEmail}`);
		}
		const openAiAuth = payload["https://api.openai.com/auth"];
		const authClaims =
			typeof openAiAuth === "object" && openAiAuth !== null && !Array.isArray(openAiAuth)
				? (openAiAuth as Record<string, unknown>)
				: undefined;
		const accountId = normalizeStoredAccountId(
			typeof payload.account_id === "string"
				? payload.account_id
				: typeof payload.accountId === "string"
					? payload.accountId
					: typeof payload.user_id === "string"
						? payload.user_id
						: typeof payload.sub === "string"
							? payload.sub
							: typeof authClaims?.chatgpt_account_id === "string"
								? authClaims.chatgpt_account_id
								: undefined,
		);
		if (accountId !== null && accountId !== undefined && accountId !== "") identifiers.add(`account:${accountId}`);
		return identifiers.size > 0 ? [...identifiers] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Standalone SQLite-backed implementation of AuthCredentialStore interface.
 * Used by the pi-ai CLI and as the default store for AuthStorage.create().
 * Also has convenience methods for simple CRUD (saveOAuth, getOAuth, etc.).
 */
export class AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#deleteByProviderStmt: Statement;
	#hardDeleteStmt: Statement;
	#getCacheStmt: Statement;
	#setCacheStmt: Statement;
	#cleanCacheStmt: Statement;

	private constructor(db: Database) {
		this.#db = db;
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA synchronous = NORMAL");
		this.#migrate();

		this.#listActiveStmt = this.#db.prepare(`
			SELECT id, provider, credential_type, data, disabled_cause, identity_key
			FROM auth_credentials
			WHERE disabled_cause IS NULL
			ORDER BY id ASC
		`);
		this.#listActiveByProviderStmt = this.#db.prepare(`
			SELECT id, provider, credential_type, data, disabled_cause, identity_key
			FROM auth_credentials
			WHERE provider = ? AND disabled_cause IS NULL
			ORDER BY id ASC
		`);
		this.#listDisabledByProviderStmt = this.#db.prepare(`
			SELECT id, provider, credential_type, data, disabled_cause, identity_key
			FROM auth_credentials
			WHERE provider = ? AND disabled_cause IS NOT NULL
			ORDER BY id ASC
		`);
		this.#insertStmt = this.#db.prepare(`
			INSERT INTO auth_credentials (provider, credential_type, data, identity_key)
			VALUES (?, ?, ?, ?)
		`);
		this.#updateStmt = this.#db.prepare(`
			UPDATE auth_credentials SET data = ?, identity_key = ? WHERE id = ?
		`);
		this.#deleteStmt = this.#db.prepare(`
			UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?
		`);
		this.#deleteByProviderStmt = this.#db.prepare(`
			UPDATE auth_credentials SET disabled_cause = ? WHERE provider = ?
		`);
		this.#hardDeleteStmt = this.#db.prepare(`
			DELETE FROM auth_credentials WHERE provider = ?
		`);
		this.#getCacheStmt = this.#db.prepare(`
			SELECT value FROM auth_cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}
		`);
		this.#setCacheStmt = this.#db.prepare(`
			INSERT OR REPLACE INTO auth_cache (key, value, expires_at)
			VALUES (?, ?, ?)
		`);
		this.#cleanCacheStmt = this.#db.prepare(`
			DELETE FROM auth_cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}
		`);
	}

	static async open(dbPath: string): Promise<AuthCredentialStore> {
		const dir = path.dirname(dbPath);
		await fs.mkdir(dir, { recursive: true });
		const db = new Database(dbPath);
		return new AuthCredentialStore(db);
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT,
				identity_key TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_auth_credentials_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_credentials_identity ON auth_credentials(identity_key);

			CREATE TABLE IF NOT EXISTS auth_cache (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_auth_cache_expires ON auth_cache(expires_at);

			CREATE TABLE IF NOT EXISTS auth_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);

		const currentVersion = this.#getVersion();
		if (currentVersion < AUTH_SCHEMA_VERSION) {
			this.#db.transaction(() => {
				if (currentVersion < 1) {
					// Schema already created above
				}
				// Future migrations go here
				this.#setVersion(AUTH_SCHEMA_VERSION);
			})();
		}
	}

	#getVersion(): number {
		const row = this.#db.prepare("SELECT value FROM auth_meta WHERE key = 'version'").get() as
			| { value: string }
			| undefined;
		return row ? parseInt(row.value, 10) : 0;
	}

	#setVersion(version: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO auth_meta (key, value) VALUES ('version', ?)").run(version.toString());
	}

	listAuthCredentials(): StoredAuthCredential[] {
		const rows = this.#listActiveStmt.all() as AuthRow[];
		return rows
			.map(row => {
				const credential = deserializeCredential(row);
				return credential ? toStoredAuthCredential(row, credential) : null;
			})
			.filter((entry): entry is StoredAuthCredential => entry !== null);
	}

	getAuthCredentialsForProvider(provider: string): StoredAuthCredential[] {
		const rows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
		return rows
			.map(row => {
				const credential = deserializeCredential(row);
				return credential ? toStoredAuthCredential(row, credential) : null;
			})
			.filter((entry): entry is StoredAuthCredential => entry !== null);
	}

	getDisabledAuthCredentialsForProvider(provider: string): StoredAuthCredential[] {
		const rows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];
		return rows
			.map(row => {
				const credential = deserializeCredential(row);
				return credential ? toStoredAuthCredential(row, credential) : null;
			})
			.filter((entry): entry is StoredAuthCredential => entry !== null);
	}

	saveAuthCredential(provider: string, credential: AuthCredential): StoredAuthCredential {
		const serialized = serializeCredential(provider, credential);
		if (!serialized) throw new Error("Invalid credential type");
		const result = this.#insertStmt.run(provider, serialized.credentialType, serialized.data, serialized.identityKey);
		return { id: result.lastInsertRowid as number, provider, credential, disabledCause: null };
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		// We need provider for identity key resolution.
		const row = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?").get(id) as
			| { provider: string }
			| undefined;
		if (!row) return;
		const serialized = serializeCredential(row.provider, credential);
		if (!serialized) throw new Error("Invalid credential type");
		this.#updateStmt.run(serialized.data, serialized.identityKey, id);
	}

	deleteAuthCredential(id: number, cause: string): void {
		this.#deleteStmt.run(normalizeDisabledCause(cause), id);
	}

	deleteAuthCredentialsForProvider(provider: string, cause: string): void {
		this.#deleteByProviderStmt.run(normalizeDisabledCause(cause), provider);
	}

	/**
	 * Atomically replaces all credentials for a provider.
	 * Returns the newly stored records.
	 */
	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		return this.#db.transaction(() => {
			this.#hardDeleteStmt.run(provider);
			return credentials.map(credential => this.saveAuthCredential(provider, credential));
		})();
	}

	/**
	 * Atomically upserts an OAuth credential for a provider based on its stable identity.
	 * If a credential with the same accountId/email already exists (even if disabled),
	 * it is updated and re-enabled. Otherwise, a new record is inserted.
	 */
	upsertAuthCredentialForProvider(provider: string, credential: OAuthCredential): StoredAuthCredential[] {
		const identityKey = resolveCredentialIdentityKey(provider, credential);
		if (identityKey === null || identityKey === undefined || identityKey === "") {
			return this.#db.transaction(() => {
				this.saveAuthCredential(provider, credential);
				return this.getAuthCredentialsForProvider(provider);
			})();
		}

		return this.#db.transaction(() => {
			const activeRows = this.#listActiveByProviderStmt.all(provider) as AuthRow[];
			const disabledRows = this.#listDisabledByProviderStmt.all(provider) as AuthRow[];

			const matchingActive = activeRows.find(row => resolveRowCredentialIdentityKey(provider, row) === identityKey);
			const matchingDisabled = disabledRows.find(
				row => resolveRowCredentialIdentityKey(provider, row) === identityKey,
			);

			const serialized = serializeCredential(provider, credential);
			if (!serialized) throw new Error("Invalid credential type");

			if (matchingActive) {
				this.#updateStmt.run(serialized.data, serialized.identityKey, matchingActive.id);
			} else if (matchingDisabled) {
				this.#updateStmt.run(serialized.data, serialized.identityKey, matchingDisabled.id);
				this.#db.prepare("UPDATE auth_credentials SET disabled_cause = NULL WHERE id = ?").run(matchingDisabled.id);
			} else {
				this.saveAuthCredential(provider, credential);
			}

			return this.getAuthCredentialsForProvider(provider);
		})();
	}

	getCache(key: string): string | undefined {
		const row = this.#getCacheStmt.get(key) as { value: string } | undefined;
		return row?.value;
	}

	setCache(key: string, value: string, expiresAt: number): void {
		this.#setCacheStmt.run(key, value, expiresAt);
	}

	cleanExpiredCache(): void {
		this.#cleanCacheStmt.run();
	}
}

/**
 * Standard database path for agent persistent storage.
 */
export async function getAuthDbPath(): Promise<string> {
	return getAgentDbPath();
}
