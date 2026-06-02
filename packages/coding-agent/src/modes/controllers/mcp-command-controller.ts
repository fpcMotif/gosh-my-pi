/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { analyzeAuthError, discoverOAuthEndpoints } from "../../mcp";
import { readMCPConfigFile, updateMCPServer } from "../../mcp/config-writer";
import type { MCPAuthConfig, MCPServerConfig } from "../../mcp/types";
import { DynamicBorder } from "../components/dynamic-border";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { MCPAddFlow } from "./mcp-add-flow";
import { MCPCapabilitiesFlow } from "./mcp-capabilities-flow";
import { MCPInventoryFlow } from "./mcp-inventory-flow";
import { MCPLifecycleFlow } from "./mcp-lifecycle-flow";
import { MCPServerAuthFlow } from "./mcp-server-auth-flow";
import { MCPSmitheryFlow } from "./mcp-smithery-flow";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export class MCPCommandController {
	#smithery: MCPSmitheryFlow;
	#capabilities: MCPCapabilitiesFlow;
	#lifecycle: MCPLifecycleFlow;
	#serverAuth: MCPServerAuthFlow;
	#inventory: MCPInventoryFlow;
	#add: MCPAddFlow;

	constructor(private ctx: InteractiveModeContext) {
		this.#add = new MCPAddFlow({
			ctx,
			reloadMCP: () => this.#reloadMCP(),
			waitForServerConnection: (name, options) => this.#waitForServerConnectionWithAnimation(name, options),
			syncManagerConnection: (name, config) => this.#syncManagerConnection(name, config),
		});
		this.#smithery = new MCPSmitheryFlow({
			ctx,
			deployServer: (name, config, scope) => this.#add.completeWizard(name, config, scope),
		});
		this.#capabilities = new MCPCapabilitiesFlow({ ctx });
		this.#lifecycle = new MCPLifecycleFlow({
			ctx,
			reloadMCP: () => this.#reloadMCP(),
		});
		this.#inventory = new MCPInventoryFlow({
			ctx,
			reloadMCP: () => this.#reloadMCP(),
			findConfiguredServer: name => this.#findConfiguredServer(name),
			waitForServerConnection: (name, options) => this.#waitForServerConnectionWithAnimation(name, options),
			syncManagerConnection: (name, config) => this.#syncManagerConnection(name, config),
		});
		this.#serverAuth = new MCPServerAuthFlow({
			ctx,
			reloadMCP: () => this.#reloadMCP(),
			findConfiguredServer: name => this.#findConfiguredServer(name),
			removeManagedOAuthCredential: id => this.#removeManagedOAuthCredential(id),
			stripOAuthAuth: config => this.#stripOAuthAuth(config),
			resolveOAuthEndpointsFromServer: config => this.#resolveOAuthEndpointsFromServer(config),
			runOAuthFlow: (authUrl, tokenUrl, clientId, clientSecret, scopes, port, p, redirect) =>
				this.#add.runOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes, port, p, redirect),
			waitForServerConnection: (name, options) => this.#waitForServerConnectionWithAnimation(name, options),
			updateMCPServer: (filePath, name, config) => updateMCPServer(filePath, name, config),
		});
	}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#add.handle(text);
				break;
			case "list":
				await this.#inventory.handleList();
				break;
			case "remove":
			case "rm":
				await this.#inventory.handleRemove(text);
				break;
			case "test":
				await this.#inventory.handleTest(parts[2]);
				break;
			case "reauth":
				await this.#serverAuth.handleReauth(parts[2]);
				break;
			case "unauth":
				await this.#serverAuth.handleUnauth(parts[2]);
				break;
			case "enable":
				await this.#inventory.handleSetEnabled(parts[2], true);
				break;
			case "disable":
				await this.#inventory.handleSetEnabled(parts[2], false);
				break;
			case "resources":
				await this.#capabilities.handleResources();
				break;
			case "prompts":
				await this.#capabilities.handlePrompts();
				break;
			case "notifications":
				await this.#capabilities.handleNotifications();
				break;
			case "smithery-search":
				await this.#smithery.handleSearch(text);
				break;
			case "smithery-login":
				await this.#smithery.handleLogin();
				break;
			case "smithery-logout":
				await this.#smithery.handleLogout();
				break;
			case "reconnect":
				await this.#lifecycle.handleReconnect(parts[2]);
				break;
			case "reload":
				await this.#lifecycle.handleReload();
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("MCP Server Management"),
			"",
			"Manage Model Context Protocol (MCP) servers for external tool integrations.",
			"",
			theme.fg("accent", "Commands:"),
			"  /mcp add              Add a new MCP server (interactive wizard)",
			"  /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
			"  /mcp list             List all configured MCP servers",
			"  /mcp remove <name> [--scope project|user]    Remove an MCP server (default: project)",
			"  /mcp test <name>      Test connection to an MCP server",
			"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			"  /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			"                        Search Smithery registry and deploy from picker",
			"  /mcp smithery-login   Login to Smithery and cache API key",
			"  /mcp smithery-logout  Remove cached Smithery API key",
			"  /mcp reconnect <name> Reconnect to a specific MCP server",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
			"  /mcp resources        List available resources from connected servers",
			"  /mcp prompts          List available prompts from connected servers",
			"  /mcp notifications    Show notification capabilities and subscription state",
			"  /mcp help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null> {
		const cwd = getProjectDir();
		const userPath = getMCPConfigPath("user", cwd);
		const projectPath = getMCPConfigPath("project", cwd);

		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);

		if (userConfig.mcpServers?.[name]) {
			return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name] };
		}
		if (projectConfig.mcpServers?.[name]) {
			return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name] };
		}
		return null;
	}

	async #removeManagedOAuthCredential(credentialId: string | undefined): Promise<void> {
		if (credentialId?.startsWith("mcp_oauth_") !== true) return;
		await this.ctx.session.modelRegistry.authStorage.remove(credentialId);
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
		delete next.auth;
		return next;
	}

	async #resolveOAuthEndpointsFromServer(config: MCPServerConfig): Promise<{
		authorizationUrl: string;
		tokenUrl: string;
		clientId?: string;
		scopes?: string;
	}> {
		// First test if server actually needs auth by connecting without OAuth
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#add.testConnection(this.#stripOAuthAuth(config));
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		// Server connected fine without auth — reauth is not needed
		if (connectionSucceeded) {
			throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		}

		// Analyze the connection error to extract OAuth endpoints
		const authResult = analyzeAuthError(connectionError!);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl);
		}

		if (!oauth) {
			throw new Error("Could not discover OAuth endpoints from server response.");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		this.ctx.chatContainer.addChild(new Spacer(1));
		const statusText = new Text(theme.fg("muted", `| Connecting to "${name}"...`), 1, 0);
		this.ctx.chatContainer.addChild(statusText);
		this.ctx.ui.requestRender();

		const frames = ["|", "/", "-", "\\"];
		let frame = 0;
		const interval = setInterval(() => {
			statusText.setText(theme.fg("muted", `${frames[frame % frames.length]} Connecting to "${name}"...`));
			frame++;
			this.ctx.ui.requestRender();
		}, 120);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				statusText.setText(theme.fg("success", `✓ Connected to "${name}"`));
			} else if (state === "connecting") {
				statusText.setText(theme.fg("muted", `◌ "${name}" is still connecting...`));
			} else {
				statusText.setText(
					options?.suppressDisconnectedWarning === true
						? theme.fg("muted", `◌ Connection check complete for "${name}"`)
						: theme.fg("warning", `⚠ Could not connect to "${name}" yet`),
				);
			}
			this.ctx.ui.requestRender();
			return state;
		} finally {
			clearInterval(interval);
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	/**
	 * Reload MCP manager with new configs
	 */
	async #reloadMCP(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();

		// Rediscover and connect
		const result = await this.ctx.mcpManager.discoverAndConnect();
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		// Show any connection errors
		if (result.errors.size > 0) {
			const errorLines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
			for (const [serverName, error] of result.errors.entries()) {
				errorLines.push(`  ${serverName}: ${error}`);
			}
			errorLines.push("");
			this.#showMessage(errorLines.join("\n"));
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		this.ctx.chatContainer.addChild(new Spacer(1));
		this.ctx.chatContainer.addChild(new DynamicBorder());
		this.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.ctx.chatContainer.addChild(new DynamicBorder());
		this.ctx.ui.requestRender();
	}
}
