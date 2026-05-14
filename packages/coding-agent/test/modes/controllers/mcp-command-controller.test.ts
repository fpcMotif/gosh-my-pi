import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import {
	getAgentDir,
	getMCPConfigPath,
	getProjectDir,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import { MCPCommandController } from "../../../src/modes/controllers/mcp-command-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import type { MCPConfigFile, MCPServerConfig } from "../../../src/mcp/types";

let originalProjectDir: string;
let originalAgentDir: string;
let tempRoot: string;

function renderChat(chatContainer: Container): string {
	return sanitizeText(Bun.stripANSI(chatContainer.render(180).join("\n")));
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
		getConnectedServers: vi.fn(() => [...statuses.entries()].filter(([, status]) => status === "connected").map(([name]) => name)),
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

		await controller.handle("/mcp add server --url example.com -- --stdio");
		expect(harness.errors.at(-1)).toBe("Use either --url or -- <command...>, not both.");

		await controller.handle("/mcp add server --token secret");
		expect(harness.errors.at(-1)).toBe("--token requires --url (HTTP/SSE transport).");

		await controller.handle("/mcp smithery-search");
		expect(harness.errors.at(-1)).toContain("Keyword required.");

		await controller.handle("/mcp smithery-search mcp --limit 0");
		expect(harness.errors.at(-1)).toBe("Invalid --limit value. Use an integer between 1 and 100.");
	});

	it("quick-adds a stdio server, reloads MCP, and activates the new server tools", async () => {
		const harness = createHarness();
		harness.mcpManager.statuses.set("quick", "connected");
		harness.mcpManager.tools.push({ name: "mcp__quick_echo", mcpServerName: "quick" });
		const controller = new MCPCommandController(harness.ctx);

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

		expect(harness.editorContainer.children[0]).toBe(harness.ctx.editor);
		expect(renderChat(harness.chatContainer)).toContain("Server creation cancelled.");
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
});
