import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";
import { getTokenProfile, decodeJwt } from "./token-profile";

export { decodeJwt };

const AUTH_URL = "https://auth.openai.com/authorize";
const TOKEN_URL = "https://api.openai.com/v1/auth/token";
const CLIENT_ID = "openai-codex";
const TOKEN_REQUEST_TIMEOUT_MS = 30000;
const PREFERRED_PORT = 54545;

class OpenAICodexOAuthFlow extends OAuthCallbackFlow {
	readonly #pkce: { verifier: string; challenge: string };

	constructor(ctrl: OAuthController, pkce: { verifier: string; challenge: string }) {
		super(ctrl, PREFERRED_PORT);
		this.#pkce = pkce;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: "openid profile email offline_access",
			state,
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
		});
		return { url: `${AUTH_URL}?${params.toString()}` };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: CLIENT_ID,
				code_verifier: this.#pkce.verifier,
			}),
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`OpenAI Codex auth failed: ${response.status}`);
		}
		const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		validateTokenResponse(data);
		const accessToken = data.access_token as string;
		const { accountId, email } = getTokenProfile(accessToken);
		return {
			access: accessToken,
			refresh: data.refresh_token as string,
			expires: Date.now() + (data.expires_in as number) * 1000,
			accountId: accountId ?? undefined,
			email,
		};
	}
}

/**
 * Login to OpenAI Codex using PKCE OAuth flow.
 */
export async function loginOpenAICodex(ctrl: OAuthController): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const flow = new OpenAICodexOAuthFlow(ctrl, pkce);
	return flow.login();
}

/**
 * Refresh an OpenAI Codex OAuth token.
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw await createRefreshError(response);
	}

	const tokenData = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	validateTokenResponse(tokenData);

	const accessToken = tokenData.access_token as string;
	const { accountId, email } = getTokenProfile(accessToken);

	return {
		access: accessToken,
		refresh:
			tokenData.refresh_token !== null && tokenData.refresh_token !== undefined && tokenData.refresh_token !== ""
				? tokenData.refresh_token
				: refreshToken,
		expires: Date.now() + (tokenData.expires_in as number) * 1000,
		accountId: accountId ?? undefined,
		email,
	};
}

async function createRefreshError(response: Response): Promise<Error> {
	let detail = `${response.status}`;
	try {
		const body = (await response.json()) as { error?: string; error_description?: string };
		if (body.error !== null && body.error !== undefined && body.error !== "") {
			const description =
				body.error_description !== null && body.error_description !== undefined && body.error_description !== ""
					? `: ${body.error_description}`
					: "";
			detail = `${response.status} ${body.error}${description}`;
		}
	} catch {
		// Ignore parse errors
	}
	return new Error(`OpenAI Codex token refresh failed: ${detail}`);
}

function validateTokenResponse(data: unknown): void {
	if (data === null || typeof data !== "object") {
		throw new Error("Token response is not an object");
	}
	const tokenData = data as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (
		tokenData.access_token === null ||
		tokenData.access_token === undefined ||
		tokenData.access_token === "" ||
		tokenData.refresh_token === null ||
		tokenData.refresh_token === undefined ||
		tokenData.refresh_token === "" ||
		typeof tokenData.expires_in !== "number"
	) {
		throw new Error("Token response missing required fields");
	}
}
