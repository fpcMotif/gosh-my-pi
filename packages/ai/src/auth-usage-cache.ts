import type { AuthCredentialStore } from "./auth-credential-store";

const USAGE_CACHE_PREFIX = "usage_cache:";

export type UsageCacheEntry<T> = { value: T; expiresAt: number };

export interface UsageCache {
	get<T>(key: string): UsageCacheEntry<T> | undefined;
	set<T>(key: string, entry: UsageCacheEntry<T>): void;
	cleanup?(): void;
}

export class AuthStorageUsageCache implements UsageCache {
	constructor(private store: AuthCredentialStore) {}
	get<T>(key: string): UsageCacheEntry<T> | undefined {
		const raw = this.store.getCache(`${USAGE_CACHE_PREFIX}${key}`);
		if (raw === undefined || raw === null || raw === "") return undefined;
		try {
			const p = JSON.parse(raw) as UsageCacheEntry<T>;
			return p.expiresAt > 0 ? p : undefined;
		} catch {
			return undefined;
		}
	}
	set<T>(key: string, entry: UsageCacheEntry<T>): void {
		this.store.setCache(`${USAGE_CACHE_PREFIX}${key}`, JSON.stringify(entry), Math.floor(entry.expiresAt / 1000));
	}
	cleanup(): void {
		this.store.cleanExpiredCache();
	}
}
