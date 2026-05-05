import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthCredential, OAuthCredential, StoredAuthCredential } from "./auth-types";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

const AUTH_SCHEMA_VERSION = 4;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

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

function normalizeStoredAccountId(acc: string | null | undefined): string | null {
	const n = acc?.trim();
	return n !== undefined && n !== "" ? n : null;
}

function normalizeStoredEmail(em: string | null | undefined): string | null {
	const n = em?.trim().toLowerCase();
	return n !== undefined && n !== "" ? n : null;
}

function normalizeStoredIdentityKey(idk: string | null | undefined): string | null {
	const n = idk?.trim();
	return n !== undefined && n !== "" ? n : null;
}

function parseTokenAccountId(payload: Record<string, unknown>, auth: unknown): string | undefined {
	if (typeof payload.account_id === "string") return payload.account_id;
	if (typeof payload.accountId === "string") return payload.accountId;
	if (typeof payload.user_id === "string") return payload.user_id;
	if (typeof payload.sub === "string") return payload.sub;
	if (auth !== null && auth !== undefined && typeof auth === "object" && !Array.isArray(auth)) {
		const claims = auth as Record<string, unknown>;
		if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
	}
	return undefined;
}

function extractOpenAiIdentifiers(payload: Record<string, unknown>, ids: Set<string>): void {
	const profile = payload["https://api.openai.com/profile"];
	if (profile !== null && profile !== undefined && typeof profile === "object" && !Array.isArray(profile)) {
		const claims = profile as Record<string, unknown>;
		const em = normalizeStoredEmail(typeof claims.email === "string" ? claims.email : undefined);
		if (em !== null) ids.add(`email:${em}`);
	}
}

function extractOAuthTokenPayload(t: string): Record<string, unknown> | undefined {
	const parts = t.split(".");
	if (parts.length !== 3) return undefined;
	try {
		return JSON.parse(
			new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })),
		) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function extractOAuthTokenIdentifiers(t: string | undefined): string[] | undefined {
	if (t === undefined || t === null || t === "") return undefined;
	const payload = extractOAuthTokenPayload(t);
	if (payload === undefined) return undefined;
	const ids = new Set<string>();
	const em = normalizeStoredEmail(typeof payload.email === "string" ? payload.email : undefined);
	if (em !== null) ids.add(`email:${em}`);
	extractOpenAiIdentifiers(payload, ids);
	const auth = payload["https://api.openai.com/auth"];
	const acc = normalizeStoredAccountId(parseTokenAccountId(payload, auth));
	if (acc !== null) ids.add(`account:${acc}`);
	return ids.size > 0 ? Array.from(ids) : undefined;
}

function extractOAuthCredentialIdentifiers(c: OAuthCredential): string[] {
	const ids = new Set<string>();
	const acc = normalizeStoredAccountId(c.accountId);
	if (acc !== null) ids.add(`account:${acc}`);
	const em = normalizeStoredEmail(c.email);
	if (em !== null) ids.add(`email:${em}`);
	const aIds = extractOAuthTokenIdentifiers(c.access);
	if (aIds) for (const id of aIds) ids.add(id);
	const rIds = extractOAuthTokenIdentifiers(c.refresh);
	if (rIds) for (const id of rIds) ids.add(id);
	return Array.from(ids);
}

function resolveProviderCredentialIdentityKey(p: string, ids: string[]): string | null {
	const em = ids.find(i => i.startsWith("email:"));
	if (p === "openai-codex" && em !== undefined) return em;
	return ids.find(i => i.startsWith("account:")) ?? em ?? null;
}

export function resolveCredentialIdentityKey(p: string, c: AuthCredential): string | null {
	if (c.type === "api_key") return null;
	return resolveProviderCredentialIdentityKey(p, extractOAuthCredentialIdentifiers(c));
}

function serializeCredential(p: string, c: AuthCredential): SerializedCredentialRecord | null {
	if (c.type === "api_key")
		return { credentialType: "api_key", data: JSON.stringify({ key: c.key }), identityKey: null };
	if (c.type === "oauth") {
		const { type: _, ...rest } = c;
		return { credentialType: "oauth", data: JSON.stringify(rest), identityKey: resolveCredentialIdentityKey(p, c) };
	}
	return null;
}

function deserializeCredential(row: AuthRow): AuthCredential | null {
	try {
		const p = JSON.parse(row.data) as Record<string, unknown>;
		if (row.credential_type === "api_key" && typeof p.key === "string") return { type: "api_key", key: p.key };
		if (row.credential_type === "oauth") return { type: "oauth", ...p } as AuthCredential;
	} catch {
		/* ignore */
	}
	return null;
}

function resolveRowCredentialIdentityKey(p: string, row: AuthRow): string | null {
	const k = normalizeStoredIdentityKey(row.identity_key);
	if (k !== null) return k;
	const c = deserializeCredential(row);
	return c?.type === "oauth" ? resolveCredentialIdentityKey(p, c) : null;
}

export class AuthCredentialStore {
	#db: Database;
	#listActiveStmt: Statement;
	#listActiveByProviderStmt: Statement;
	#listDisabledByProviderStmt: Statement;
	#insertStmt: Statement;
	#updateStmt: Statement;
	#deleteStmt: Statement;
	#getCacheStmt: Statement;
	#setCacheStmt: Statement;
	#cleanCacheStmt: Statement;

	private constructor(db: Database) {
		this.#db = db;
		this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		this.#migrate();
		this.#listActiveStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listActiveByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id ASC",
		);
		this.#listDisabledByProviderStmt = this.#db.prepare(
			"SELECT id, provider, credential_type, data, disabled_cause, identity_key FROM auth_credentials WHERE provider = ? AND disabled_cause IS NOT NULL ORDER BY id ASC",
		);
		this.#insertStmt = this.#db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)",
		);
		this.#updateStmt = this.#db.prepare("UPDATE auth_credentials SET data = ?, identity_key = ? WHERE id = ?");
		this.#deleteStmt = this.#db.prepare("UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?");
		this.#getCacheStmt = this.#db.prepare(
			`SELECT value FROM auth_cache WHERE key = ? AND expires_at > ${SQLITE_NOW_EPOCH}`,
		);
		this.#setCacheStmt = this.#db.prepare(
			"INSERT OR REPLACE INTO auth_cache (key, value, expires_at) VALUES (?, ?, ?)",
		);
		this.#cleanCacheStmt = this.#db.prepare(`DELETE FROM auth_cache WHERE expires_at <= ${SQLITE_NOW_EPOCH}`);
	}

	static async open(dbPath?: string): Promise<AuthCredentialStore> {
		const res = dbPath ?? getAgentDbPath();
		await fs.mkdir(path.dirname(res), { recursive: true });
		return new AuthCredentialStore(new Database(res));
	}

	close(): void {
		this.#db.close();
	}

	#migrate(): void {
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT);
			CREATE INDEX IF NOT EXISTS idx_auth_credentials_provider ON auth_credentials(provider);
			CREATE INDEX IF NOT EXISTS idx_auth_credentials_identity ON auth_credentials(identity_key);
			CREATE TABLE IF NOT EXISTS auth_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS idx_auth_cache_expires ON auth_cache(expires_at);
			CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		if (this.#getVersion() < AUTH_SCHEMA_VERSION) this.#db.transaction(() => this.#setVersion(AUTH_SCHEMA_VERSION))();
	}

	#getVersion(): number {
		const row = this.#db.prepare("SELECT value FROM auth_meta WHERE key = 'version'").get() as
			| { value: string }
			| undefined;
		return row ? parseInt(row.value, 10) : 0;
	}

	#setVersion(v: number): void {
		this.#db.prepare("INSERT OR REPLACE INTO auth_meta (key, value) VALUES ('version', ?)").run(v.toString());
	}

	listAuthCredentials(): StoredAuthCredential[] {
		return (this.#listActiveStmt.all() as AuthRow[])
			.map(r => {
				const c = deserializeCredential(r);
				return c ? { id: r.id, provider: r.provider, credential: c, disabledCause: r.disabled_cause } : null;
			})
			.filter((e): e is StoredAuthCredential => e !== null);
	}

	saveAuthCredential(p: string, c: AuthCredential): StoredAuthCredential {
		const s = serializeCredential(p, c);
		if (!s) throw new Error("Invalid");
		const r = this.#insertStmt.run(p, s.credentialType, s.data, s.identityKey);
		return { id: r.lastInsertRowid as number, provider: p, credential: c, disabledCause: null };
	}

	updateAuthCredential(id: number, c: AuthCredential): void {
		const row = this.#db.prepare("SELECT provider FROM auth_credentials WHERE id = ?").get(id) as
			| { provider: string }
			| undefined;
		if (!row) return;
		const s = serializeCredential(row.provider, c);
		if (!s) throw new Error("Invalid");
		this.#updateStmt.run(s.data, s.identityKey, id);
	}

	deleteAuthCredential(id: number, cause: string): void {
		this.#deleteStmt.run(cause.trim() || "disabled", id);
	}

	deleteAuthCredentialsForProvider(p: string, cause: string): void {
		this.#db
			.prepare("UPDATE auth_credentials SET disabled_cause = ? WHERE provider = ?")
			.run(cause.trim() || "disabled", p);
	}

	replaceAuthCredentialsForProvider(p: string, cs: AuthCredential[]): StoredAuthCredential[] {
		return this.#db.transaction(() => {
			this.#db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(p);
			return cs.map(c => this.saveAuthCredential(p, c));
		})();
	}

	upsertAuthCredentialForProvider(p: string, c: OAuthCredential): StoredAuthCredential[] {
		const idKey = resolveCredentialIdentityKey(p, c);
		if (idKey === null)
			return this.#db.transaction(() => {
				this.saveAuthCredential(p, c);
				return this.getAuthCredentialsForProvider(p);
			})();
		return this.#db.transaction(() => {
			const active = this.#listActiveByProviderStmt.all(p) as AuthRow[];
			const disabled = this.#listDisabledByProviderStmt.all(p) as AuthRow[];
			const match =
				active.find(r => resolveRowCredentialIdentityKey(p, r) === idKey) ||
				disabled.find(r => resolveRowCredentialIdentityKey(p, r) === idKey);
			const s = serializeCredential(p, c);
			if (!s) throw new Error("Invalid");
			if (match) {
				this.#updateStmt.run(s.data, s.identityKey, match.id);
				this.#db.prepare("UPDATE auth_credentials SET disabled_cause = NULL WHERE id = ?").run(match.id);
			} else {
				this.saveAuthCredential(p, c);
			}
			return this.getAuthCredentialsForProvider(p);
		})();
	}

	getAuthCredentialsForProvider(p: string): StoredAuthCredential[] {
		return (this.#listActiveByProviderStmt.all(p) as AuthRow[])
			.map(r => {
				const c = deserializeCredential(r);
				return c ? { id: r.id, provider: r.provider, credential: c, disabledCause: r.disabled_cause } : null;
			})
			.filter((e): e is StoredAuthCredential => e !== null);
	}

	getCache(k: string): string | undefined {
		return (this.#getCacheStmt.get(k) as { value: string } | undefined)?.value;
	}
	setCache(k: string, v: string, exp: number): void {
		this.#setCacheStmt.run(k, v, exp);
	}
	cleanExpiredCache(): void {
		this.#cleanCacheStmt.run();
	}
}

export async function getAuthDbPath(): Promise<string> {
	return getAgentDbPath();
}
