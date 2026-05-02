import { type OAuthCredentials } from "./types";
import { getTokenProfile } from "./token-profile";

const TOKEN_URL = "https://api.openai.com/v1/auth/token";
const CLIENT_ID = "openai-codex";
const TOKEN_REQUEST_TIMEOUT_MS = 30000;

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

	const { accountId, email } = getTokenProfile(tokenData.access_token!);

	return {
		access: tokenData.access_token!,
		refresh: tokenData.refresh_token || refreshToken,
		expires: Date.now() + tokenData.expires_in! * 1000,
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
