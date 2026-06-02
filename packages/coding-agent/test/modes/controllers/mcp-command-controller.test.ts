import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { getAgentDir, getMCPConfigPath, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import { MCPCommandController } from "../../../src/modes/controllers/mcp-command-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import * as smitheryAuth from "../../../src/mcp/smithery-auth";
import * as smitheryRegistry from "../../../src/mcp/smithery-registry";
import type { SmitherySearchResult } from "../../../src/mcp/smithery-registry";
import * as mcpClient from "../../../src/mcp/client";
import { MCPOAuthFlow } from "../../../src/mcp/oauth-flow";
import type { InteractiveModeContext } from "../../../src/modes/types";
import type { MCPConfigFile, MCPServerConfig, MCPServerConnection } from "../../../src/mcp/types";
import * as openUtils from "../../../src/utils/open";

let originalProjectDir: string;
let originalAgentDir: string;
let tempRoot: string;

function renderChat(chatContainer: Container): string {
	return sanitizeText(Bun.stripANSI(chatContainer.render(180).join("\n")));
}

function submitWizardInput(wizard: Container | undefined, value: string): void {
	if (!wizard?.handleInput) throw new Error("expected wizard input handler");
	for (const char of value) wizard.handleInput(char);
	wizard.handleInput("\n");
}

async function writeConfig(scope: "user" | "project", config: MCPConfigFile): Promise<string> {
	const filePath = getMCPConfigPath(scope, getProjectDir());
	await Bun.write(filePath, JSON.stringify(config, null, 2));
	return filePath;
}

async function readConfig(scope: "user" | "project"): Promise<MCPConfigFile> {
	return await Bun.file(getMCPConfigPath(scope, getProjectDir())).json();
}

function stdioConfig(command = "bunx", args: string[] = ["server"]): MCPServerConfig {
	return { type: "stdio", command, args };
}

function httpConfig(url = "https://example.com/mcp"): MCPServerConfig {
	return { type: "http", url };
}

function smitheryResult(overrides: Partial<SmitherySearchResult> = {}): SmitherySearchResult {
	return {
		id: "server-one",
		name: "@scope/server-one",
		title: "Server One",
		description: "Demo server",
		score: 1,
		useCount: 42,
		display: {
			displayName: "Server One",
			description: "Demo server",
			useCount: 42,
			verified: true,
			deployed: false,
			transport: "stdio",
			connectionType: "package",
			tools: [{ name: "echo", description: "Echoes", params: ["message"] }],
		},
		sourceType: "package",
		config: { type: "stdio", command: "bunx", args: ["server-one", "--config"], enabled: false },
		warnings: [],
		requiredInputs: [
			{
				key: "token",
				label: "Token",
				type: "string",
				required: true,
				description: "API token",
				sensitive: true,
			},
			{
				key: "region",
				label: "Region",
				type: "string",
				required: false,
				defaultValue: "us",
				description: "Region",
				sensitive: false,
			},
		],
		...overrides,
	};
}

function createMCPManager() {
	const statuses = new Map<string, "connected" | "connecting" | "disconnected">();
	const sources = new Map<string, { providerName: string; path: string }>();
	const resources = new Map<string, unknown>();
	const prompts = new Map<string, unknown[]>();
	const connections = new Map<string, unknown>();
	const tools: Array<{ name: string; mcpServerName: string }> = [];
	const manager = {
		statuses,
		sources,
		resources,
		prompts,
		connections,
		tools,
		prepareConfig: vi.fn(async (config: MCPServerConfig) => config),
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async () => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => tools),
		waitForConnection: vi.fn(async (_name: string) => {}),
		getConnectionStatus: vi.fn((name: string) => statuses.get(name) ?? "disconnected"),
		connectServers: vi.fn(async (configs: Record<string, MCPServerConfig>) => {
			for (const name of Object.keys(configs)) statuses.set(name, "connected");
		}),
		getAllServerNames: vi.fn(() => Array.from(new Set([...statuses.keys(), ...sources.keys()]))),
		getSource: vi.fn((name: string) => sources.get(name)),
		getConnection: vi.fn((name: string) => connections.get(name)),
		disconnectServer: vi.fn(async (name: string) => {
			statuses.set(name, "disconnected");
			connections.delete(name);
		}),
		getConnectedServers: vi.fn(() =>
			[...statuses.entries()].filter(([, status]) => status === "connected").map(([name]) => name),
		),
		getServerResources: vi.fn((name: string) => resources.get(name)),
		getServerPrompts: vi.fn((name: string) => prompts.get(name)),
		getNotificationState: vi.fn(() => ({
			enabled: true,
			subscriptions: new Map([["notify", new Set(["file://watched"])]]),
		})),
		reconnectServer: vi.fn(async (name: string) => {
			statuses.set(name, "connected");
			return connections.get(name) ?? { name };
		}),
	};
	return manager;
}

function createSession() {
	const authStorage = {
		set: vi.fn(async () => {}),
		remove: vi.fn(async () => {}),
	};
	return {
		modelRegistry: { authStorage },
		refreshMCPTools: vi.fn(async () => {}),
		getActiveToolNames: vi.fn(() => ["bash"]),
		getToolByName: vi.fn((name: string) => ({ name })),
		setActiveToolsByName: vi.fn(async (_names: string[]) => {}),
		authStorage,
	};
}

function createHarness() {
	const chatContainer = new Container();
	const editorContainer = new Container();
	const mcpManager = createMCPManager();
	const session = createSession();
	const errors: string[] = [];
	const statuses: string[] = [];
	const warnings: string[] = [];
	const ctx = fromAny<InteractiveModeContext>({
		chatContainer,
		editorContainer,
		editor: { onEscape: undefined },
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
		},
		session,
		mcpManager,
		showError: (message: string) => errors.push(message),
		showStatus: (message: string) => statuses.push(message),
		showWarning: (message: string) => warnings.push(message),
		showHookInput: vi.fn(async () => undefined),
		showHookSelector: vi.fn(async () => undefined),
	});
	return { ctx, chatContainer, editorContainer, errors, statuses, warnings, mcpManager, session };
}

describe("MCPCommandController", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		originalProjectDir = getProjectDir();
		originalAgentDir = getAgentDir();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-command-controller-"));
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		setProjectDir(projectDir);
		setAgentDir(path.join(tempRoot, "agent"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		setProjectDir(originalProjectDir);
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("shows help, unknown subcommand errors, and quick-add argument validation", async () => {
		const harness = createHarness();
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp");
		expect(renderChat(harness.chatContainer)).toContain("MCP Server Management");

		await controller.handle("/mcp nope");
		expect(harness.errors.at(-1)).toBe("Unknown subcommand: nope. Type /mcp help for usage.");

		await controller.handle("/mcp add server --scope bad");
		expect(harness.errors.at(-1)).toBe("Invalid --scope value. Use project or user.");

		await controller.handle("/mcp add named --url");
		expect(harness.errors.at(-1)).toBe("Missing value for --url.");

		await controller.handle("/mcp add named --transport websocket");
		expect(harness.errors.at(-1)).toBe("Invalid --transport value. Use http or sse.");

		await controller.handle("/mcp add named --token");
		expect(harness.errors.at(-1)).toBe("Missing value for --token.");

		await controller.handle("/mcp add named --unknown");
		expect(harness.errors.at(-1)).toBe("Unknown option: --unknown");

		await controller.handle("/mcp add --url example.com");
		expect(harness.errors.at(-1)).toBe("Server name required for quick add. Usage: /mcp add <name> ...");

		await controller.handle("/mcp add server --url example.com -- --stdio");
		expect(harness.errors.at(-1)).toBe("Use either --url or -- <command...>, not both.");

		await controller.handle("/mcp add server --token secret");
		expect(harness.errors.at(-1)).toBe("--token requires --url (HTTP/SSE transport).");

		await controller.handle("/mcp smithery-search");
		expect(harness.errors.at(-1)).toContain("Keyword required.");

		await controller.handle("/mcp smithery-search mcp --limit 0");
		expect(harness.errors.at(-1)).toBe("Invalid --limit value. Use an integer between 1 and 100.");

		await controller.handle("/mcp smithery-search mcp --scope bad");
		expect(harness.errors.at(-1)).toBe("Invalid --scope value. Use project or user.");

		await controller.handle("/mcp smithery-search mcp --limit");
		expect(harness.errors.at(-1)).toBe("Missing value for --limit.");

		await controller.handle("/mcp smithery-search mcp --bogus");
		expect(harness.errors.at(-1)).toBe("Unknown option: --bogus");
	});

	it("quick-adds a stdio server, reloads MCP, and activates the new server tools", async () => {
		const harness = createHarness();
		// Have the mocked discovery/reconnect surface the new server's status + tool as a side effect,
		// so the success assertions reflect actual command-driven state instead of pre-staged fixtures.
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("quick", "connected");
			harness.mcpManager.tools.push({ name: "mcp__quick_echo", mcpServerName: "quick" });
			return { errors: new Map<string, string>() };
		});
		const controller = new MCPCommandController(harness.ctx);
		expect(harness.mcpManager.statuses.has("quick")).toBe(false);
		expect(harness.mcpManager.tools).toHaveLength(0);

		await controller.handle('/mcp add quick --scope project -- bunx server --flag "two words"');

		const projectConfig = await readConfig("project");
		expect(projectConfig.mcpServers?.quick).toEqual({
			type: "stdio",
			command: "bunx",
			args: ["server", "--flag", "two words"],
		});
		expect(harness.mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(harness.mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(harness.session.refreshMCPTools).toHaveBeenCalled();
		expect(harness.session.setActiveToolsByName).toHaveBeenCalledWith(["bash", "mcp__quick_echo"]);
		expect(renderChat(harness.chatContainer)).toContain('Added server "quick" to project config');
		expect(renderChat(harness.chatContainer)).toContain("Successfully connected to server");

		await controller.handle("/mcp add quick -- bunx duplicate");
		expect(harness.errors.at(-1)).toContain('Server "quick" already exists');
	});

	it("opens the interactive add wizard and restores the editor when cancelled", async () => {
		const harness = createHarness();
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add draft");
		const wizard = harness.editorContainer.children[0];

		expect(renderChat(harness.editorContainer)).toContain("Step 2: Transport Type");
		expect(harness.ctx.ui.setFocus).toHaveBeenCalledWith(wizard);

		wizard?.handleInput?.("\x03");

		// Ctrl-C swaps the wizard back out for the original editor (the test stub at ctx.editor).
		expect(harness.editorContainer.children[0]).toBe(harness.ctx.editor);
		expect(renderChat(harness.chatContainer)).toContain("Server creation cancelled.");
	});

	it("completes the interactive add wizard with manual auth after auth-required detection", async () => {
		const harness = createHarness();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("401 api key required"));
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add secured");
		const wizard = harness.editorContainer.children[0];

		wizard?.handleInput?.("\n");
		submitWizardInput(wizard, "bunx");
		submitWizardInput(wizard, "secured-server");
		for (let attempt = 0; attempt < 20 && !renderChat(harness.editorContainer).includes("API Key"); attempt++) {
			await Bun.sleep(1);
		}
		submitWizardInput(wizard, "secret-token");
		wizard?.handleInput?.("\n");
		wizard?.handleInput?.("\n");
		wizard?.handleInput?.("\n");
		for (
			let attempt = 0;
			attempt < 50 && !renderChat(harness.chatContainer).includes('Added server "secured"');
			attempt++
		) {
			await Bun.sleep(1);
		}

		const config = await readConfig("user");
		expect(config.mcpServers?.secured).toEqual({
			type: "stdio",
			command: "bunx",
			args: ["secured-server"],
			env: { API_KEY: "secret-token" },
		});
		expect(harness.ctx.ui.requestRender).toHaveBeenCalled();
		expect(renderChat(harness.chatContainer)).toContain('Added server "secured" to user config');
	});

	it("renders animated pending connection state when a newly added server keeps connecting", async () => {
		const harness = createHarness();
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("pending", "connecting");
			return { errors: new Map<string, string>() };
		});
		harness.mcpManager.waitForConnection.mockImplementationOnce(async () => {
			await Bun.sleep(140);
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add pending --scope project -- bunx server");

		expect(renderChat(harness.chatContainer)).toContain('"pending" is still connecting');
		expect(harness.ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("reports a pending connection when the connection wait times out", async () => {
		const harness = createHarness();
		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
			return originalSetTimeout(handler, timeout === 10_000 ? 1 : timeout, ...args);
		});
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("timeoutPending", "connecting");
			return { errors: new Map<string, string>() };
		});
		harness.mcpManager.waitForConnection.mockImplementationOnce(async () => {
			await new Promise(() => {});
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add timeoutPending --scope project -- bunx server");

		expect(renderChat(harness.chatContainer)).toContain('"timeoutPending" is still connecting');
		expect(harness.ctx.ui.requestRender).toHaveBeenCalled();
	});

	it("quick-adds OAuth HTTP servers when auth metadata is returned", async () => {
		const harness = createHarness();
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("oauthQuick", "connected");
			harness.mcpManager.tools.push({ name: "mcp__oauthQuick_tool", mcpServerName: "oauthQuick" });
			return { errors: new Map<string, string>() };
		});
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValueOnce(
			new Error(
				'401 {"oauth":{"authorization_url":"https://auth.example/authorize?client_id=metadata-client&scope=read%20write","token_url":"https://auth.example/token"}}',
			),
		);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		vi.spyOn(Math, "random").mockReturnValue(0.123456789);
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		vi.spyOn(MCPOAuthFlow.prototype, "login").mockImplementation(async function (this: MCPOAuthFlow) {
			this.ctrl.onAuth?.({ url: "https://auth.example/authorize?manual=1" });
			this.ctrl.onProgress?.("Waiting for fake OAuth");
			return { access: "access-token", refresh: "refresh-token", expires: 1_700_000_003_600 };
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add oauthQuick --scope project --url https://mcp.example/mcp");

		const config = await readConfig("project");
		const credentialId = config.mcpServers?.oauthQuick?.auth?.credentialId;
		expect(config.mcpServers?.oauthQuick).toEqual({
			type: "http",
			url: "https://mcp.example/mcp",
			auth: {
				type: "oauth",
				credentialId,
				tokenUrl: "https://auth.example/token",
				clientId: "metadata-client",
			},
		});
		expect(credentialId).toStartWith("mcp_oauth_1700000000000_");
		expect(harness.session.authStorage.set).toHaveBeenCalledWith(credentialId, {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_700_000_003_600,
		});
		expect(openUtils.openPath).toHaveBeenCalledWith("https://auth.example/authorize?manual=1");
		expect(harness.session.setActiveToolsByName).toHaveBeenCalledWith(["bash", "mcp__oauthQuick_tool"]);
		expect(renderChat(harness.chatContainer)).toContain("OAuth Authorization Required");
		expect(renderChat(harness.chatContainer)).toContain("Authorization completed in browser");
		expect(renderChat(harness.chatContainer)).toContain('Added server "oauthQuick" to project config');
	});

	it("completes the interactive add wizard with OAuth auth", async () => {
		const harness = createHarness();
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("wizardOauth", "connected");
			return { errors: new Map<string, string>() };
		});
		vi.spyOn(mcpClient, "connectToServer")
			.mockRejectedValueOnce(
				new Error(
					'401 {"oauth":{"authorization_url":"https://auth.example/authorize","token_url":"https://auth.example/token","client_id":"wizard-client","scopes":"read"}}',
				),
			)
			.mockResolvedValueOnce(
				fromAny<MCPServerConnection>({ serverInfo: { name: "wizardOauth", version: "1.0.0" } }),
			);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_050_000);
		vi.spyOn(Math, "random").mockReturnValue(0.246813579);
		vi.spyOn(MCPOAuthFlow.prototype, "login").mockImplementation(async function (this: MCPOAuthFlow) {
			this.ctrl.onAuth?.({ url: "https://auth.example/authorize?wizard=1" });
			return { access: "wizard-access", refresh: "wizard-refresh", expires: 1_700_000_053_600 };
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp add wizardOauth");
		const wizard = harness.editorContainer.children[0];
		wizard?.handleInput?.("\x1b[B");
		wizard?.handleInput?.("\n");
		submitWizardInput(wizard, "https://mcp.example/wizard");
		for (let attempt = 0; attempt < 30 && !renderChat(harness.editorContainer).includes("Config Scope"); attempt++) {
			await Bun.sleep(50);
		}
		wizard?.handleInput?.("\n");
		wizard?.handleInput?.("\n");
		for (
			let attempt = 0;
			attempt < 50 && !renderChat(harness.chatContainer).includes('Added server "wizardOauth"');
			attempt++
		) {
			await Bun.sleep(1);
		}

		const config = await readConfig("user");
		const credentialId = config.mcpServers?.wizardOauth?.auth?.credentialId;
		expect(config.mcpServers?.wizardOauth).toEqual({
			type: "http",
			url: "https://mcp.example/wizard",
			auth: {
				type: "oauth",
				credentialId,
				tokenUrl: "https://auth.example/token",
				clientId: "wizard-client",
			},
		});
		expect(harness.session.authStorage.set).toHaveBeenCalledWith(credentialId, {
			type: "oauth",
			access: "wizard-access",
			refresh: "wizard-refresh",
			expires: 1_700_000_053_600,
		});
		expect(renderChat(harness.chatContainer)).toContain('Added server "wizardOauth" to user config');
	});

	it("maps OAuth login failures during quick-add without writing config", async () => {
		const harness = createHarness();
		await writeConfig("project", { mcpServers: {} });
		const oauthMetadataError = new Error(
			'401 {"oauth":{"authorization_url":"https://auth.example/authorize","token_url":"https://auth.example/token"}}',
		);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(oauthMetadataError);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {
			throw new Error("browser unavailable");
		});
		const failures = [
			{
				name: "timeoutCase",
				message: "timed out waiting",
				expected: "OAuth flow timed out. Please try again.",
			},
			{
				name: "deniedCase",
				message: "403 unauthorized",
				expected: "OAuth authorization failed. Please check your client credentials.",
			},
			{
				name: "grantCase",
				message: "invalid_grant",
				expected: "OAuth authorization code is invalid or expired. Please try again.",
			},
			{
				name: "networkCase",
				message: "fetch failed",
				expected: "Could not connect to OAuth server. Please check the URLs and your network connection.",
			},
			{
				name: "genericCase",
				message: "provider unavailable",
				expected: "OAuth authentication failed: provider unavailable",
			},
		];
		let attempt = 0;
		vi.spyOn(MCPOAuthFlow.prototype, "login").mockImplementation(async function (this: MCPOAuthFlow) {
			this.ctrl.onAuth?.({ url: `https://auth.example/failure/${failures[attempt]!.name}` });
			this.ctrl.onProgress?.("Fake OAuth failure");
			throw new Error(failures[attempt++]!.message);
		});
		const controller = new MCPCommandController(harness.ctx);

		for (const failure of failures) {
			await controller.handle(`/mcp add ${failure.name} --url https://mcp.example/${failure.name}`);
			expect(harness.errors.at(-1)).toBe(`OAuth flow failed for "${failure.name}": ${failure.expected}`);
		}

		const config = await readConfig("project");
		expect(config.mcpServers).toEqual({});
		expect(renderChat(harness.chatContainer)).toContain("Could not open browser automatically");
	});

	it("lists configured, discovered, and disabled servers with runtime status", async () => {
		const harness = createHarness();
		await writeConfig("user", {
			mcpServers: {
				"user-http": { ...httpConfig(), enabled: false },
			},
			disabledServers: ["third-party-disabled"],
		});
		await writeConfig("project", {
			mcpServers: {
				"project-stdio": stdioConfig("bunx", ["project-server"]),
			},
		});
		harness.mcpManager.statuses.set("user-http", "connected");
		harness.mcpManager.statuses.set("project-stdio", "connecting");
		harness.mcpManager.statuses.set("third-party-live", "connected");
		harness.mcpManager.statuses.set("third-party-disabled", "connected");
		harness.mcpManager.sources.set("third-party-live", {
			providerName: "Cursor",
			path: path.join(getProjectDir(), ".cursor", "mcp.json"),
		});
		harness.mcpManager.sources.set("third-party-disabled", {
			providerName: "Cursor",
			path: path.join(getProjectDir(), ".cursor", "mcp.json"),
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp list");

		const output = renderChat(harness.chatContainer);
		expect(output).toContain("Configured MCP Servers");
		expect(output).toContain("User level");
		expect(output).toContain("user-http ◌ inactive [http]");
		expect(output).toContain("Project level");
		expect(output).toContain("project-stdio ◌ connecting [stdio]");
		expect(output).toContain("Cursor");
		expect(output).toContain("third-party-live ● connected");
		expect(output).toContain("Disabled");
		expect(output).toContain("third-party-disabled ◌ disabled");
	});

	it("renders resources, prompts, and notification capability summaries", async () => {
		const harness = createHarness();
		harness.mcpManager.statuses.set("resources", "connected");
		harness.mcpManager.statuses.set("notify", "connected");
		harness.mcpManager.resources.set("resources", {
			resources: [{ uri: "file://notes", mimeType: "text/plain", description: "Notes" }],
			templates: [{ uriTemplate: "file://{path}", description: "File by path" }],
		});
		harness.mcpManager.prompts.set("resources", [
			{
				name: "summarize",
				description: "Summarize input",
				arguments: [{ name: "topic", required: true, description: "Topic name" }],
			},
		]);
		harness.mcpManager.connections.set("notify", {
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true, subscribe: true },
				prompts: { listChanged: true },
			},
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp resources");
		await controller.handle("/mcp prompts");
		await controller.handle("/mcp notifications");

		const output = renderChat(harness.chatContainer);
		expect(output).toContain("MCP Resources");
		expect(output).toContain("file://notes [text/plain] Notes");
		expect(output).toContain("file://{path} File by path");
		expect(output).toContain("MCP Prompts");
		expect(output).toContain("/resources:summarize Summarize input");
		expect(output).toContain("topic= * - Topic name");
		expect(output).toContain("MCP Notifications");
		expect(output).toContain("tools/list_changed");
		expect(output).toContain("resources/subscribe  subscribed (1 URI)");
		expect(output).toContain("file://watched");
	});

	it("renders MCP empty states and missing-manager errors", async () => {
		const noManagerHarness = createHarness();
		noManagerHarness.ctx.mcpManager = undefined;
		const noManagerController = new MCPCommandController(noManagerHarness.ctx);

		await noManagerController.handle("/mcp resources");
		await noManagerController.handle("/mcp prompts");
		await noManagerController.handle("/mcp notifications");
		expect(noManagerHarness.errors).toEqual([
			"No MCP manager available.",
			"No MCP manager available.",
			"No MCP manager available.",
		]);

		const emptyHarness = createHarness();
		emptyHarness.mcpManager.statuses.set("empty", "connected");
		emptyHarness.mcpManager.resources.set("empty", { resources: [], templates: [] });
		emptyHarness.mcpManager.prompts.set("empty", []);
		emptyHarness.mcpManager.connections.set("empty", {
			capabilities: {
				resources: { listChanged: true },
			},
		});
		emptyHarness.mcpManager.getNotificationState.mockReturnValueOnce({
			enabled: false,
			subscriptions: new Map(),
		});
		const emptyController = new MCPCommandController(emptyHarness.ctx);

		await emptyController.handle("/mcp resources");
		await emptyController.handle("/mcp prompts");
		await emptyController.handle("/mcp notifications");

		const emptyOutput = renderChat(emptyHarness.chatContainer);
		expect(emptyOutput).toContain("No resources available on connected servers.");
		expect(emptyOutput).toContain("No prompts available on connected servers.");
		expect(emptyOutput).toContain("Status: disabled");
		expect(emptyOutput).toContain("resources/list_changed");
		expect(emptyOutput).toContain("resources/subscribe  not supported");

		const noSupportHarness = createHarness();
		noSupportHarness.mcpManager.statuses.set("plain", "connected");
		noSupportHarness.mcpManager.connections.set("plain", { capabilities: {} });
		const noSupportController = new MCPCommandController(noSupportHarness.ctx);
		await noSupportController.handle("/mcp notifications");
		expect(renderChat(noSupportHarness.chatContainer)).toContain("No servers support notifications.");
	});

	it("handles discovered-server enable and disable through the user disabled list", async () => {
		const harness = createHarness();
		await writeConfig("user", { mcpServers: {}, disabledServers: ["discovered"] });
		harness.mcpManager.statuses.set("discovered", "connected");
		harness.mcpManager.sources.set("discovered", {
			providerName: "Cursor",
			path: path.join(getProjectDir(), ".cursor", "mcp.json"),
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp enable discovered");
		let userConfig = await readConfig("user");
		expect(userConfig.disabledServers).toBeUndefined();
		expect(renderChat(harness.chatContainer)).toContain('Enabled "discovered"');

		await controller.handle("/mcp disable discovered");
		userConfig = await readConfig("user");
		expect(userConfig.disabledServers).toEqual(["discovered"]);
		expect(harness.mcpManager.disconnectServer).toHaveBeenCalledWith("discovered");
		expect(renderChat(harness.chatContainer)).toContain('Disabled "discovered"');
	});

	it("reports config-only test command validation errors without opening transports", async () => {
		const harness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				off: { ...stdioConfig(), enabled: false },
			},
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp test");
		expect(harness.errors.at(-1)).toBe("Server name required. Usage: /mcp test <name>");

		await controller.handle("/mcp test missing");
		expect(harness.errors.at(-1)).toContain('Server "missing" not found.');

		await controller.handle("/mcp test off");
		expect(harness.errors.at(-1)).toBe('Server "off" is disabled. Run /mcp enable off first.');
	});

	it("tests configured MCP servers, syncs manager connections, and lets escape cancel a slow test", async () => {
		const harness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				ok: stdioConfig("bunx", ["ok-server"]),
				slow: stdioConfig("bunx", ["slow-server"]),
			},
		});
		const connection = fromAny<MCPServerConnection>({
			name: "ok",
			config: stdioConfig("bunx", ["ok-server"]),
			serverInfo: { name: "mock-server", version: "1.2.3" },
			capabilities: {},
			transport: { close: vi.fn(async () => {}) },
		});
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValueOnce(connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValueOnce([
			{ name: "echo", inputSchema: { type: "object" }, description: "Echo" },
		]);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined);
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp test ok");

		expect(harness.mcpManager.connectServers).toHaveBeenCalledWith({ ok: stdioConfig("bunx", ["ok-server"]) }, {});
		expect(harness.session.refreshMCPTools).toHaveBeenCalledWith(harness.mcpManager.getTools());
		expect(renderChat(harness.chatContainer)).toContain('Successfully connected to "ok"');
		expect(renderChat(harness.chatContainer)).toContain("mock-server v1.2.3");
		expect(renderChat(harness.chatContainer)).toContain("echo");

		vi.restoreAllMocks();
		const slowHarness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				slow: stdioConfig("bunx", ["slow-server"]),
			},
		});
		let capturedSignal: AbortSignal | undefined;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (_name, _config, options) => {
			capturedSignal = options?.signal;
			const { promise, reject } = Promise.withResolvers<MCPServerConnection>();
			if (capturedSignal?.aborted === true) {
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}
			capturedSignal?.addEventListener(
				"abort",
				() => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				},
				{ once: true },
			);
			return await promise;
		});
		const slowController = new MCPCommandController(slowHarness.ctx);
		const originalOnEscape = slowHarness.ctx.editor.onEscape;

		const pending = slowController.handle("/mcp test slow");
		for (let attempt = 0; attempt < 20 && capturedSignal === undefined; attempt++) {
			await Bun.sleep(1);
		}
		slowHarness.ctx.editor.onEscape?.();
		await pending;

		expect(capturedSignal?.aborted).toBe(true);
		expect(slowHarness.statuses.at(-1)).toBe('Cancelled MCP test for "slow"');
		expect(slowHarness.ctx.editor.onEscape).toBe(originalOnEscape);
	});

	it("updates config-backed server lifecycle commands and reloads runtime tools", async () => {
		const harness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				managed: { ...stdioConfig(), enabled: false },
				oauth: {
					...httpConfig("https://example.com/oauth"),
					auth: { type: "oauth", credentialId: "mcp_oauth_old" },
				},
				removeMe: stdioConfig("bunx", ["remove-me"]),
			},
		});
		harness.mcpManager.statuses.set("managed", "connected");
		harness.mcpManager.statuses.set("removeMe", "connected");
		harness.mcpManager.connections.set("removeMe", { name: "removeMe" });
		harness.mcpManager.tools.push({ name: "mcp__managed_tool", mcpServerName: "managed" });
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp enable managed");
		let config = await readConfig("project");
		expect(config.mcpServers?.managed?.enabled).toBe(true);
		expect(renderChat(harness.chatContainer)).toContain('Enabled "managed" (project config)');

		await controller.handle("/mcp disable managed");
		config = await readConfig("project");
		expect(config.mcpServers?.managed?.enabled).toBe(false);
		expect(renderChat(harness.chatContainer)).toContain('Disabled "managed" (project config)');

		await controller.handle("/mcp unauth oauth");
		config = await readConfig("project");
		expect(config.mcpServers?.oauth?.auth).toBeUndefined();
		expect(harness.session.authStorage.remove).toHaveBeenCalledWith("mcp_oauth_old");
		expect(renderChat(harness.chatContainer)).toContain('Cleared auth for "oauth"');

		await controller.handle("/mcp remove removeMe --scope project");
		config = await readConfig("project");
		expect(config.mcpServers?.removeMe).toBeUndefined();
		expect(harness.mcpManager.disconnectServer).toHaveBeenCalledWith("removeMe");
		expect(renderChat(harness.chatContainer)).toContain('Removed server "removeMe" from project config');

		await controller.handle("/mcp reconnect managed");
		expect(harness.mcpManager.reconnectServer).toHaveBeenCalledWith("managed");
		expect(renderChat(harness.chatContainer)).toContain('Reconnected to "managed"');

		await controller.handle("/mcp reload");
		expect(renderChat(harness.chatContainer)).toContain("MCP reload complete");
		expect(harness.session.refreshMCPTools).toHaveBeenCalled();
	});

	it("reports lifecycle validation errors and already-set states", async () => {
		const harness = createHarness();
		await Promise.all([
			writeConfig("user", { mcpServers: {}, disabledServers: ["already-disabled"] }),
			writeConfig("project", {
				mcpServers: {
					alreadyEnabled: stdioConfig(),
					disabledOAuth: { ...httpConfig("https://example.com/oauth"), enabled: false },
				},
			}),
		]);
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp enable missing");
		expect(harness.errors.at(-1)).toBe('Server "missing" not found.');

		await controller.handle("/mcp disable already-disabled");
		expect(renderChat(harness.chatContainer)).toContain('Server "already-disabled" is already disabled.');

		await controller.handle("/mcp enable alreadyEnabled");
		expect(renderChat(harness.chatContainer)).toContain('Server "alreadyEnabled" is already enabled.');

		await controller.handle("/mcp unauth");
		expect(harness.errors.at(-1)).toBe("Server name required. Usage: /mcp unauth <name>");

		await controller.handle("/mcp unauth missing");
		expect(harness.errors.at(-1)).toBe('Server "missing" not found.');

		await controller.handle("/mcp reauth");
		expect(harness.errors.at(-1)).toBe("Server name required. Usage: /mcp reauth <name>");

		await controller.handle("/mcp reauth missing");
		expect(harness.errors.at(-1)).toBe('Server "missing" not found.');

		await controller.handle("/mcp reauth disabledOAuth");
		expect(harness.errors.at(-1)).toBe('Server "disabledOAuth" is disabled. Run /mcp enable disabledOAuth first.');
	});

	it("reauthorizes OAuth servers through discovered metadata", async () => {
		const harness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				reauthMe: {
					...httpConfig("https://mcp.example/mcp"),
					oauth: {
						clientId: "configured-client",
						clientSecret: "configured-secret",
						redirectUri: "http://localhost:3030/oauth/callback",
					},
					auth: {
						type: "oauth",
						credentialId: "mcp_oauth_old",
						tokenUrl: "https://old.example/token",
						clientSecret: "old-secret",
					},
				},
			},
		});
		harness.mcpManager.discoverAndConnect.mockImplementationOnce(async () => {
			harness.mcpManager.statuses.set("reauthMe", "connected");
			return { errors: new Map<string, string>() };
		});
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValueOnce(
			new Error("401 unauthorized Mcp-Auth-Server: https://auth.example"),
		);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
			const url = String(input);
			if (url.includes("/.well-known/oauth-authorization-server")) {
				return Response.json({
					authorization_endpoint: "https://auth.example/authorize",
					token_endpoint: "https://auth.example/token",
					scopes_supported: ["read", "write"],
				});
			}
			return new Response("{}", { status: 404 });
		});
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
		vi.spyOn(Math, "random").mockReturnValue(0.987654321);
		vi.spyOn(MCPOAuthFlow.prototype, "login").mockImplementation(async function (this: MCPOAuthFlow) {
			this.ctrl.onAuth?.({ url: "https://auth.example/authorize?reauth=1" });
			return { access: "new-access", refresh: "new-refresh", expires: 1_700_000_103_600 };
		});
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp reauth reauthMe");

		const config = await readConfig("project");
		const credentialId = config.mcpServers?.reauthMe?.auth?.credentialId;
		expect(harness.session.authStorage.remove).toHaveBeenCalledWith("mcp_oauth_old");
		expect(harness.session.authStorage.set).toHaveBeenCalledWith(credentialId, {
			type: "oauth",
			access: "new-access",
			refresh: "new-refresh",
			expires: 1_700_000_103_600,
		});
		expect(config.mcpServers?.reauthMe?.auth).toEqual({
			type: "oauth",
			credentialId,
			tokenUrl: "https://auth.example/token",
			clientId: "configured-client",
			clientSecret: "configured-secret",
		});
		expect(renderChat(harness.chatContainer)).toContain('Reauthorized "reauthMe"');
		expect(renderChat(harness.chatContainer)).toContain("Status: connected");
	});

	it("reports when reauth is unnecessary because the server connects without OAuth", async () => {
		const harness = createHarness();
		await writeConfig("project", {
			mcpServers: {
				openServer: {
					...httpConfig("https://mcp.example/open"),
					auth: { type: "oauth", credentialId: "mcp_oauth_open" },
				},
			},
		});
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(
			fromAny<MCPServerConnection>({ serverInfo: { name: "openServer", version: "1.0.0" } }),
		);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined);
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp reauth openServer");

		expect(harness.errors.at(-1)).toBe(
			"Failed to reauthorize server: Server connection succeeded without OAuth; reauthorization is not required.",
		);
		expect(harness.session.authStorage.remove).toHaveBeenCalledWith("mcp_oauth_open");
	});

	it("handles Smithery browser login, API-key fallback, and logout statuses without live network", async () => {
		const harness = createHarness();
		const controller = new MCPCommandController(harness.ctx);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		vi.spyOn(smitheryAuth, "createSmitheryCliAuthSession").mockResolvedValueOnce({
			sessionId: "browser-session",
			authUrl: "https://smithery.test/auth",
		});
		vi.spyOn(smitheryAuth, "pollSmitheryCliAuthSession").mockResolvedValueOnce({
			status: "success",
			apiKey: "browser-key",
		});
		const saveSpy = vi.spyOn(smitheryAuth, "saveSmitheryApiKey").mockResolvedValue(undefined);
		const searchSpy = vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockResolvedValue([]);

		await controller.handle("/mcp smithery-login");

		expect(searchSpy).toHaveBeenCalledWith("mcp", { limit: 1, apiKey: "browser-key" });
		expect(saveSpy).toHaveBeenCalledWith("browser-key");
		expect(harness.statuses.at(-1)).toBe("Smithery API key saved.");
		expect(renderChat(harness.chatContainer)).toContain("Browser authorization started");

		vi.restoreAllMocks();
		const fallbackHarness = createHarness();
		const fallbackController = new MCPCommandController(fallbackHarness.ctx);
		vi.spyOn(smitheryAuth, "createSmitheryCliAuthSession").mockRejectedValueOnce(new Error("browser unavailable"));
		vi.spyOn(smitheryRegistry, "searchSmitheryRegistry")
			.mockRejectedValueOnce(new Error("bad key"))
			.mockResolvedValueOnce([]);
		vi.spyOn(smitheryAuth, "saveSmitheryApiKey").mockResolvedValue(undefined);
		const inputs = ["", "bad-key", "manual-key"];
		fallbackHarness.ctx.showHookInput = vi.fn(async () => inputs.shift());

		await fallbackController.handle("/mcp smithery-login");

		expect(fallbackHarness.warnings.at(-1)).toContain("Browser authorization failed");
		expect(fallbackHarness.errors).toContain("Smithery API key cannot be empty.");
		expect(fallbackHarness.errors.at(-1)).toContain("Smithery API key validation failed");
		expect(fallbackHarness.statuses.at(-1)).toBe("Smithery API key saved.");

		vi.spyOn(smitheryAuth, "clearSmitheryApiKey").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await fallbackController.handle("/mcp smithery-logout");
		await fallbackController.handle("/mcp smithery-logout");
		expect(fallbackHarness.statuses).toContain("Smithery API key removed.");
		expect(fallbackHarness.statuses).toContain("No cached Smithery API key found.");
	});

	it("searches Smithery, prompts for deployment inputs, and retries auth failures", async () => {
		const harness = createHarness();
		const selectedResult = smitheryResult();
		const searchSpy = vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockResolvedValue([selectedResult]);
		vi.spyOn(smitheryAuth, "getSmitheryApiKey").mockResolvedValue("cached-key");
		harness.ctx.showHookSelector = vi.fn(async () => "1. Server One (stdio, uses 42)");
		const inputs = ["", "token-value", "eu"];
		harness.ctx.showHookInput = vi.fn(async () => inputs.shift());
		const controller = new MCPCommandController(harness.ctx);

		await controller.handle("/mcp smithery-search echo --scope project --limit 2 --semantic");

		expect(searchSpy).toHaveBeenCalledWith("echo", {
			limit: 2,
			apiKey: "cached-key",
			includeSemantic: true,
		});
		const config = await readConfig("project");
		expect(config.mcpServers?.["scope-server-one"]?.enabled).toBe(false);
		expect(config.mcpServers?.["scope-server-one"]?.args).toEqual([
			"server-one",
			"--config",
			JSON.stringify({ token: "token-value", region: "eu" }),
		]);
		expect(renderChat(harness.chatContainer)).toContain('Added server "scope-server-one" to project config');

		vi.restoreAllMocks();
		const retryHarness = createHarness();
		const retryController = new MCPCommandController(retryHarness.ctx);
		vi.spyOn(openUtils, "openPath").mockImplementation(() => {
			throw new Error("browser unavailable");
		});
		vi.spyOn(smitheryAuth, "getSmitheryApiKey").mockResolvedValueOnce("expired-key").mockResolvedValue("fresh-key");
		vi.spyOn(smitheryAuth, "createSmitheryCliAuthSession").mockRejectedValueOnce(new Error("browser unavailable"));
		vi.spyOn(smitheryAuth, "saveSmitheryApiKey").mockResolvedValue(undefined);
		vi.spyOn(smitheryRegistry, "searchSmitheryRegistry")
			.mockRejectedValueOnce(new smitheryRegistry.SmitheryRegistryError("rate limited", 429))
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		retryHarness.ctx.showHookInput = vi.fn(async () => "fresh-key");

		await retryController.handle("/mcp smithery-search none");

		expect(retryHarness.warnings.at(-1)).toContain("Browser authorization failed");
		expect(renderChat(retryHarness.chatContainer)).toContain('No Smithery results found for "none"');
	});
});

// Coverage gap (deliberate, per AGENTS.md "Testing Guidance"):
//
// The OAuth and Smithery registry flows are uncovered: `#handleOAuthFlow` spawns `MCPOAuthFlow`
// and a browser; `#handleTestConnection` / `#resolveOAuthEndpointsFromServer` open live transport;
// `#handleSmitheryLoginWithApiKey` / `#pickRegistryResult` hit the real registry. Driving these
// cleanly requires mocking the upstream OAuth/registry libraries plus the browser launcher, which
// would test our wiring rather than the contract. Deferred to integration tests with real MCP
// fixtures (AGENTS.md: "intentionally untestable without bad-practice hacks").
