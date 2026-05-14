import { beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { MCPAddWizard } from "../../../src/modes/components/mcp-add-wizard";
import { initTheme } from "../../../src/modes/theme/theme";
import type { MCPServerConfig } from "../../../src/mcp/types";

function render(wizard: MCPAddWizard, width = 160): string {
	return sanitizeText(Bun.stripANSI(wizard.render(width).join("\n")));
}

function typeText(wizard: MCPAddWizard, text: string): void {
	wizard.handleInput(text);
}

async function flushAsyncStep(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

async function waitForText(wizard: MCPAddWizard, expected: string): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (render(wizard).includes(expected)) return;
		await Bun.sleep(25);
	}
	expect(render(wizard)).toContain(expected);
}

describe("MCPAddWizard", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("validates server names and cancels from the name step", () => {
		const onCancel = vi.fn();
		const wizard = new MCPAddWizard(vi.fn(), onCancel);

		expect(render(wizard)).toContain("Step 1: Server Name");
		typeText(wizard, "bad name!");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("Only letters");

		wizard.handleInput("\x03");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("completes a stdio server with manual API key environment auth", async () => {
		const onComplete = vi.fn();
		const onTestConnection = vi.fn(async (_config: MCPServerConfig) => {
			throw new Error("401 api key required");
		});
		const wizard = new MCPAddWizard(onComplete, vi.fn(), undefined, onTestConnection, undefined, "stdio-server");

		expect(render(wizard)).toContain("Step 2: Transport Type");
		wizard.handleInput("\r");
		typeText(wizard, "bunx mcp-server");
		wizard.handleInput("\r");
		typeText(wizard, "--stdio --verbose");
		wizard.handleInput("\r");
		await flushAsyncStep();

		expect(render(wizard)).toContain("API Key Required");
		typeText(wizard, "secret-token");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("Environment Variable Name");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("Configuration Scope");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("Review Configuration");
		wizard.handleInput("\r");

		expect(onTestConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "stdio",
				command: "bunx mcp-server",
				args: ["--stdio", "--verbose"],
			}),
		);
		expect(onComplete).toHaveBeenCalledWith(
			"stdio-server",
			{
				type: "stdio",
				command: "bunx mcp-server",
				args: ["--stdio", "--verbose"],
				env: { API_KEY: "secret-token" },
			},
			"project",
		);
	});

	it("validates HTTP URLs and completes header-based manual auth", async () => {
		const onComplete = vi.fn();
		const onTestConnection = vi.fn(async (_config: MCPServerConfig) => {
			throw new Error("401 bearer token required");
		});
		const wizard = new MCPAddWizard(onComplete, vi.fn(), undefined, onTestConnection, undefined, "http-server");

		wizard.handleInput("\x1b[B");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("Server URL");
		typeText(wizard, "ftp://example.test/mcp");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("URL must use http:// or https:// scheme");

		typeText(wizard, "http://127.0.0.1:9/mcp");
		wizard.handleInput("\r");
		await waitForText(wizard, "API Key Required");
		typeText(wizard, "header-token");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("How to provide the key?");
		wizard.handleInput("\x1b[B");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("HTTP Header Name");
		wizard.handleInput("\r");
		wizard.handleInput("\r");
		wizard.handleInput("\r");

		expect(onComplete).toHaveBeenCalledWith(
			"http-server",
			{
				type: "http",
				url: "http://127.0.0.1:9/mcp",
				headers: { Authorization: "header-token" },
			},
			"user",
		);
	});

	it("runs OAuth, health-checks the authenticated config, and saves OAuth metadata", async () => {
		const onComplete = vi.fn();
		const onOAuth = vi.fn(async () => "credential-1");
		const onRender = vi.fn();
		const onTestConnection = vi.fn(async (config: MCPServerConfig) => {
			if ("auth" in config && config.auth?.type === "oauth") return;
			throw new Error(
				'401 {"authorization_url":"https://auth.example/authorize?client_id=client-1&scope=read","token_url":"https://auth.example/token"}',
			);
		});
		const wizard = new MCPAddWizard(onComplete, vi.fn(), onOAuth, onTestConnection, onRender, "oauth-server");

		wizard.handleInput("\x1b[B");
		wizard.handleInput("\r");
		typeText(wizard, "https://mcp.example.test/sse");
		wizard.handleInput("\r");
		await flushAsyncStep();

		expect(onOAuth).toHaveBeenCalledWith(
			"https://auth.example/authorize?client_id=client-1&scope=read",
			"https://auth.example/token",
			"client-1",
			"",
			"read",
		);
		expect(render(wizard)).toContain("Authentication successful");
		await Bun.sleep(1050);
		expect(render(wizard)).toContain("Configuration Scope");
		expect(onRender).toHaveBeenCalled();

		wizard.handleInput("\r");
		wizard.handleInput("\r");
		expect(onComplete).toHaveBeenCalledWith(
			"oauth-server",
			{
				type: "http",
				url: "https://mcp.example.test/sse",
				auth: {
					type: "oauth",
					credentialId: "credential-1",
					tokenUrl: "https://auth.example/token",
					clientId: "client-1",
				},
			},
			"user",
		);
	});

	it("lets failed OAuth flows edit settings and retry with explicit OAuth fields", async () => {
		const onOAuth = vi.fn(async () => {
			throw new Error("authorization timed out");
		});
		const onTestConnection = vi.fn(async (_config: MCPServerConfig) => {
			throw new Error(
				'401 {"authorization_url":"https://auth.example/authorize","token_url":"https://auth.example/token"}',
			);
		});
		const wizard = new MCPAddWizard(vi.fn(), vi.fn(), onOAuth, onTestConnection, undefined, "oauth-failure");

		wizard.handleInput("\x1b[B");
		wizard.handleInput("\r");
		typeText(wizard, "https://mcp.example.test/mcp");
		wizard.handleInput("\r");
		await waitForText(wizard, "OAuth authentication failed");
		expect(render(wizard)).toContain("Retry");
		expect(render(wizard)).toContain("authorization timed out");

		wizard.handleInput("\x1b[A");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("OAuth: Authorization URL");
		typeText(wizard, "https://auth2.example/authorize");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("OAuth: Token URL");
		wizard.handleInput("\x1b");
		expect(render(wizard)).toContain("OAuth: Authorization URL");
		wizard.handleInput("\r");

		typeText(wizard, "https://auth2.example/token");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("OAuth: Client ID");
		typeText(wizard, "client-2");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("OAuth: Client Secret");
		wizard.handleInput("\r");
		expect(render(wizard)).toContain("OAuth: Scopes");
		typeText(wizard, "read write");
		wizard.handleInput("\r");
		await waitForText(wizard, "OAuth authentication failed");

		const lastOAuthCall = onOAuth.mock.calls[onOAuth.mock.calls.length - 1];
		if (!lastOAuthCall) throw new Error("OAuth callback should have been called");
		expect(lastOAuthCall[0]).toStartWith("https://auth2.example/authorize");
		expect(lastOAuthCall[1]).toStartWith("https://auth2.example/token");
		expect(lastOAuthCall.slice(2)).toEqual(["client-2", "", "read write"]);
	});
});
