/**
 * MCP OAuth Auto-Discovery
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 */

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	scopes?: string;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	message?: string;
}

function isNonEmpty(value: string | undefined | null): value is string {
	return typeof value === "string" && value.length > 0;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = getString(obj, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

const AUTH_URL_KEYS = [
	"authorization_url",
	"authorizationUrl",
	"authorization_endpoint",
	"authorizationEndpoint",
	"authorization_uri",
	"authorizationUri",
] as const;

const TOKEN_URL_KEYS = ["token_url", "tokenUrl", "token_endpoint", "tokenEndpoint", "token_uri", "tokenUri"] as const;

const CLIENT_ID_KEYS = ["client_id", "clientId", "default_client_id", "public_client_id"] as const;

const SCOPE_KEYS = ["scopes", "scope"] as const;

function parseMcpAuthServerUrl(errorMessage: string): string | undefined {
	const match = errorMessage.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i);
	const candidate = match?.[1];
	if (!isNonEmpty(candidate)) return undefined;

	try {
		return new URL(candidate).toString();
	} catch {
		return undefined;
	}
}

export function extractMcpAuthServerUrl(error: Error): string | undefined {
	return parseMcpAuthServerUrl(error.message);
}

const AUTH_ERROR_PATTERNS = [
	"401",
	"403",
	"unauthorized",
	"forbidden",
	"authentication required",
	"authentication failed",
] as const;

/**
 * Detect if an error indicates authentication is required.
 * Checks for common auth error patterns.
 */
export function detectAuthError(error: Error): boolean {
	const errorMsg = error.message.toLowerCase();
	return AUTH_ERROR_PATTERNS.some(pattern => errorMsg.includes(pattern));
}

function readScopesFromArray(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const scopes = (value as unknown[]).filter((v): v is string => typeof v === "string");
	return scopes.length > 0 ? scopes.join(" ") : undefined;
}

function readEndpointsFromObject(obj: Record<string, unknown>): OAuthEndpoints | null {
	const authorizationUrl = pickString(obj, AUTH_URL_KEYS);
	const tokenUrl = pickString(obj, TOKEN_URL_KEYS);
	if (authorizationUrl === undefined || tokenUrl === undefined) return null;

	const scopes = pickString(obj, SCOPE_KEYS) ?? readScopesFromArray(obj.scopes_supported);
	const clientId = pickString(obj, CLIENT_ID_KEYS);

	return { authorizationUrl, tokenUrl, clientId, scopes };
}

function clientIdFromAuthUrl(authorizationUrl: string): string | undefined {
	try {
		return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
	} catch {
		return undefined;
	}
}

function scopeFromAuthUrl(authorizationUrl: string): string | undefined {
	try {
		return new URL(authorizationUrl).searchParams.get("scope") ?? undefined;
	} catch {
		return undefined;
	}
}

function fillMissingFromAuthUrl(endpoints: OAuthEndpoints): OAuthEndpoints {
	return {
		...endpoints,
		clientId: endpoints.clientId ?? clientIdFromAuthUrl(endpoints.authorizationUrl),
		scopes: endpoints.scopes ?? scopeFromAuthUrl(endpoints.authorizationUrl),
	};
}

function getNestedAuthObject(errorBody: Record<string, unknown>): Record<string, unknown> | undefined {
	const candidate = errorBody.oauth ?? errorBody.authorization ?? errorBody.auth;
	if (candidate !== null && typeof candidate === "object") {
		return candidate as Record<string, unknown>;
	}
	return undefined;
}

function tryExtractFromJson(errorMsg: string): OAuthEndpoints | null {
	const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;

	let errorBody: Record<string, unknown>;
	try {
		errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
	} catch {
		return null;
	}

	const nestedAuth = getNestedAuthObject(errorBody);
	if (nestedAuth) {
		const endpoints = readEndpointsFromObject(nestedAuth);
		if (endpoints) return fillMissingFromAuthUrl(endpoints);
	}

	const topLevelEndpoints = readEndpointsFromObject(errorBody);
	if (topLevelEndpoints) return fillMissingFromAuthUrl(topLevelEndpoints);

	return null;
}

const CHALLENGE_AUTH_URL_KEYS = [
	"authorization_uri",
	"authorization_url",
	"authorization_endpoint",
	"authorize_url",
	"realm",
] as const;

const CHALLENGE_TOKEN_URL_KEYS = ["token_url", "token_uri", "token_endpoint"] as const;

const CHALLENGE_SCOPE_KEYS = ["scope", "scopes"] as const;

function pickFromMap(map: Map<string, string>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = map.get(key);
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}

function tryExtractFromChallenge(errorMsg: string): OAuthEndpoints | null {
	const challengeEntries = Array.from(errorMsg.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]+)"/g));
	if (challengeEntries.length === 0) return null;

	const challengeValues = new Map<string, string>();
	for (const [, rawKey, value] of challengeEntries) {
		challengeValues.set(rawKey.toLowerCase(), value);
	}

	const authorizationUrl = pickFromMap(challengeValues, CHALLENGE_AUTH_URL_KEYS);
	const tokenUrl = pickFromMap(challengeValues, CHALLENGE_TOKEN_URL_KEYS);

	if (!isNonEmpty(authorizationUrl) || !isNonEmpty(tokenUrl)) return null;

	return {
		authorizationUrl,
		tokenUrl,
		clientId: challengeValues.get("client_id") ?? clientIdFromAuthUrl(authorizationUrl),
		scopes: pickFromMap(challengeValues, CHALLENGE_SCOPE_KEYS) ?? scopeFromAuthUrl(authorizationUrl),
	};
}

function tryExtractFromWwwAuthHeader(errorMsg: string): OAuthEndpoints | null {
	const wwwAuthMatch = errorMsg.match(/realm="([^"]+)".*token_url="([^"]+)"/);
	if (!wwwAuthMatch) return null;

	return {
		authorizationUrl: wwwAuthMatch[1],
		tokenUrl: wwwAuthMatch[2],
		clientId: clientIdFromAuthUrl(wwwAuthMatch[1]),
		scopes: scopeFromAuthUrl(wwwAuthMatch[1]),
	};
}

/**
 * Extract OAuth endpoints from error response.
 * Looks for WWW-Authenticate header format or JSON error bodies.
 */
export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	const errorMsg = error.message;
	return tryExtractFromJson(errorMsg) ?? tryExtractFromChallenge(errorMsg) ?? tryExtractFromWwwAuthHeader(errorMsg);
}

const APIKEY_PATTERNS = ["api key", "api_key", "token", "bearer"] as const;

/**
 * Analyze an error to determine authentication requirements.
 * Returns structured info about what auth is needed.
 */
export function analyzeAuthError(error: Error): AuthDetectionResult {
	if (!detectAuthError(error)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error);
	const oauth = extractOAuthEndpoints(error);

	if (oauth) {
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth,
			authServerUrl,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	const errorMsg = error.message.toLowerCase();
	if (APIKEY_PATTERNS.some(pattern => errorMsg.includes(pattern))) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			message: "Server requires API key authentication.",
		};
	}

	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		message: "Server requires authentication but type could not be determined.",
	};
}

function toEndpointString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function findEndpointsInStandardMetadata(metadata: Record<string, unknown>): OAuthEndpoints | null {
	const authorizationUrl = toEndpointString(metadata.authorization_endpoint);
	const tokenUrl = toEndpointString(metadata.token_endpoint);
	if (authorizationUrl === undefined || tokenUrl === undefined) return null;

	const scopesSupported = readScopesFromArray(metadata.scopes_supported);
	const clientId = pickString(metadata, CLIENT_ID_KEYS);
	const scopes = scopesSupported ?? pickString(metadata, SCOPE_KEYS);

	return {
		authorizationUrl,
		tokenUrl,
		clientId,
		scopes,
	};
}

function findEndpointsInNestedOAuth(metadata: Record<string, unknown>): OAuthEndpoints | null {
	const oauthData = getNestedAuthObject(metadata);
	if (!oauthData) return null;

	const authorizationUrl = pickString(oauthData, AUTH_URL_KEYS);
	const tokenUrl = pickString(oauthData, TOKEN_URL_KEYS);
	if (authorizationUrl === undefined || tokenUrl === undefined) return null;

	return {
		authorizationUrl,
		tokenUrl,
		clientId: pickString(oauthData, CLIENT_ID_KEYS),
		scopes: pickString(oauthData, SCOPE_KEYS),
	};
}

function findEndpoints(metadata: Record<string, unknown>): OAuthEndpoints | null {
	return findEndpointsInStandardMetadata(metadata) ?? findEndpointsInNestedOAuth(metadata);
}

const WELL_KNOWN_PATHS = [
	"/.well-known/oauth-authorization-server",
	"/.well-known/openid-configuration",
	"/.well-known/oauth-protected-resource",
	"/oauth/metadata",
	"/.mcp/auth",
	"/authorize",
] as const;

async function fetchMetadata(baseUrl: string, path: string): Promise<Record<string, unknown> | null> {
	try {
		const url = new URL(path, baseUrl);
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return null;
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function discoverFromProtectedResource(
	metadata: Record<string, unknown>,
	serverUrl: string,
	visitedAuthServers: Set<string>,
): Promise<OAuthEndpoints | null> {
	if (!Array.isArray(metadata.authorization_servers)) return null;
	const authServers = (metadata.authorization_servers as unknown[]).filter(
		(entry): entry is string => typeof entry === "string",
	);

	const candidates = authServers.filter(server => !visitedAuthServers.has(server));
	const results = await Promise.all(candidates.map(server => discoverOAuthEndpoints(serverUrl, server)));
	return results.find((result): result is OAuthEndpoints => result !== null) ?? null;
}

async function probePathOnBase(
	baseUrl: string,
	path: string,
	serverUrl: string,
	visitedAuthServers: Set<string>,
): Promise<OAuthEndpoints | null> {
	const metadata = await fetchMetadata(baseUrl, path);
	if (!metadata) return null;

	const endpoints = findEndpoints(metadata);
	if (endpoints) return endpoints;

	if (path === "/.well-known/oauth-protected-resource") {
		return discoverFromProtectedResource(metadata, serverUrl, visitedAuthServers);
	}

	return null;
}

async function probeBaseUrl(
	baseUrl: string,
	serverUrl: string,
	visitedAuthServers: Set<string>,
): Promise<OAuthEndpoints | null> {
	const probes = WELL_KNOWN_PATHS.map(path => probePathOnBase(baseUrl, path, serverUrl, visitedAuthServers));
	const results = await Promise.all(probes);
	return results.find((result): result is OAuthEndpoints => result !== null) ?? null;
}

/**
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * This is a fallback when error responses don't include OAuth metadata.
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
): Promise<OAuthEndpoints | null> {
	const urlsToQuery = [authServerUrl, serverUrl].filter((value): value is string => Boolean(value));
	const visitedAuthServers = new Set<string>(urlsToQuery);

	const probes = urlsToQuery.map(baseUrl => probeBaseUrl(baseUrl, serverUrl, visitedAuthServers));
	const results = await Promise.all(probes);
	return results.find((result): result is OAuthEndpoints => result !== null) ?? null;
}
