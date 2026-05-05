/**
 * Extract profile information from a JWT access token by decoding the payload.
 */
export interface TokenProfile {
	accountId?: string;
	email?: string;
}

/**
 * Decode a JWT payload into a plain object.
 */
export function decodeJwt(accessToken: string): Record<string, unknown> | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) {
			return null;
		}
		const payload = parts[1];
		if (payload === undefined) {
			return null;
		}
		// Base64url decode
		const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
		const decoded = atob(padded);
		return JSON.parse(decoded) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Decode a JWT payload and extract account identity fields.
 */
export function getTokenProfile(accessToken: string): TokenProfile {
	const data = decodeJwt(accessToken);
	if (!data) return {};

	const accountId =
		typeof data["sub"] === "string" ? data["sub"] : typeof data["oid"] === "string" ? data["oid"] : undefined;
	const email = typeof data["email"] === "string" ? data["email"] : undefined;
	return { accountId, email };
}
