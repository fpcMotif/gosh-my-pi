import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";

describe("AuthStorage credential probes", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		unregisterOAuthProviders();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-storage-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		unregisterOAuthProviders();
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("distinguishes OAuth credentials from API key credentials", async () => {
		await authStorage.set("openai", { type: "api_key", key: "api-key" });

		expect(authStorage.has("openai")).toBe(true);
		expect(authStorage.hasOAuth("openai")).toBe(false);
		expect(await authStorage.peekApiKey("openai")).toBe("api-key");

		await authStorage.set("openai-codex", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
		});

		expect(authStorage.has("openai-codex")).toBe(true);
		expect(authStorage.hasOAuth("openai-codex")).toBe(true);
		expect(await authStorage.peekApiKey("openai-codex")).toBe("oauth-access");
	});

	test("does not treat expired OAuth access tokens as peekable API keys", async () => {
		await authStorage.set("openai-codex", {
			type: "oauth",
			access: "expired-access",
			refresh: "oauth-refresh",
			expires: Date.now() - 1,
		});

		expect(authStorage.hasOAuth("openai-codex")).toBe(true);
		expect(await authStorage.peekApiKey("openai-codex")).toBeUndefined();
	});

	test("applies custom OAuth API-key projection without refreshing", async () => {
		registerOAuthProvider({
			id: "custom-oauth",
			name: "Custom OAuth",
			async login() {
				throw new Error("not used");
			},
			async refreshToken() {
				throw new Error("peekApiKey must not refresh OAuth tokens");
			},
			getApiKey(credentials) {
				return `projected:${credentials.access}`;
			},
		});

		await authStorage.set("custom-oauth", {
			type: "oauth",
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 120_000,
		});

		expect(await authStorage.peekApiKey("custom-oauth")).toBe("projected:oauth-access");
	});
});
