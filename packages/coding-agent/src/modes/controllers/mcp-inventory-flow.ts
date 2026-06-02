/**
 * `/mcp list`, `/mcp remove`, `/mcp test`, `/mcp enable`, `/mcp disable`
 * subcommands.
 *
 * Inventory operations on the configured-server set: rendering the listing,
 * removing entries, testing a single connection, and toggling enabled state
 * (which for discovered-but-not-configured servers writes to the disabled-set
 * file, while for configured servers updates the config's `enabled` field).
 *
 * Shared helpers (`findConfiguredServer`, `waitForServerConnection`,
 * `syncManagerConnection`, `reloadMCP`) are passed via Context — same callbacks
 * the server-auth flow uses.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../../capability/types";
import { MCPManager } from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "../components/dynamic-border";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export interface MCPInventoryFlowContext {
	ctx: InteractiveModeContext;
	reloadMCP(): Promise<void>;
	findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null>;
	waitForServerConnection(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected">;
	syncManagerConnection(name: string, config: MCPServerConfig): Promise<void>;
}

export class MCPInventoryFlow {
	#ctx: MCPInventoryFlowContext;

	constructor(ctx: MCPInventoryFlowContext) {
		this.#ctx = ctx;
	}

	async handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const userPathLabel = shortenPath(userPath);
			const projectPathLabel = shortenPath(projectPath);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(await readDisabledServers(userPath));
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.#ctx.ctx.mcpManager) {
				for (const name of this.#ctx.ctx.mcpManager.getAllServerNames()) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.#ctx.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			if (
				userServers.length === 0 &&
				projectServers.length === 0 &&
				discoveredServers.length === 0 &&
				disabledServerNames.size === 0
			) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No MCP servers configured."),
						"",
						`Use ${theme.fg("accent", "/mcp add")} to add a server.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured MCP Servers"), ""];

			if (userServers.length > 0) {
				lines.push(theme.fg("accent", "User level") + theme.fg("muted", ` (${userPathLabel}):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.#ctx.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			if (projectServers.length > 0) {
				lines.push(theme.fg("accent", "Project level") + theme.fg("muted", ` (${projectPathLabel}):`));
				for (const name of projectServers) {
					const config = projectConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.#ctx.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? theme.fg("warning", " ◌ inactive")
							: state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
					lines.push(`  ${theme.fg("accent", name)}${status} ${theme.fg("dim", `[${type}]`)}`);
				}
				lines.push("");
			}

			if (discoveredServers.length > 0) {
				const bySource = new Map<string, typeof discoveredServers>();
				for (const entry of discoveredServers) {
					const key = `${entry.source.providerName}|${entry.source.path}`;
					let group = bySource.get(key);
					if (!group) {
						group = [];
						bySource.set(key, group);
					}
					group.push(entry);
				}

				for (const [key, entries] of bySource) {
					const sepIdx = key.indexOf("|");
					const providerName = key.slice(0, sepIdx);
					const sourcePath = key.slice(sepIdx + 1);
					const shortPath = shortenPath(sourcePath);
					lines.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.#ctx.ctx.mcpManager!.getConnectionStatus(name);
						const status =
							state === "connected"
								? theme.fg("success", " ● connected")
								: state === "connecting"
									? theme.fg("muted", " ◌ connecting")
									: theme.fg("muted", " ○ not connected");
						lines.push(`  ${theme.fg("accent", name)}${status}`);
					}
					lines.push("");
				}
			}

			const relevantDisabled = [...disabledServerNames].filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(theme.fg("accent", "Disabled") + theme.fg("muted", " (discovered servers):"));
				for (const name of relevantDisabled) {
					lines.push(`  ${theme.fg("accent", name)}${theme.fg("warning", " ◌ disabled")}`);
				}
				lines.push("");
			}
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.#ctx.ctx.showError(`Failed to list servers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);

		let name: string | undefined;
		let scope: "project" | "user" = "project";
		let i = 0;

		if (tokens.length > 0 && !tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					this.#ctx.ctx.showError("Invalid --scope value. Use project or user.");
					return;
				}
				scope = value;
				i += 2;
				continue;
			}
			this.#ctx.ctx.showError(`Unknown option: ${token}`);
			return;
		}

		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError("Server name required. Usage: /mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.#ctx.ctx.showError(`Server "${name}" not found in ${scope} config.`);
				return;
			}

			if (this.#ctx.ctx.mcpManager?.getConnection(name)) {
				await this.#ctx.ctx.mcpManager.disconnectServer(name);
			}

			await removeMCPServer(filePath, name);

			await this.#ctx.reloadMCP();

			this.#showMessage(["", theme.fg("success", `✓ Removed server "${name}" from ${scope} config`), ""].join("\n"));
		} catch (error) {
			this.#ctx.ctx.showError(`Failed to remove server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async handleTest(name: string | undefined): Promise<void> {
		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const originalOnEscape = this.#ctx.ctx.editor.onEscape;
		const abortController = new AbortController();
		this.#ctx.ctx.editor.onEscape = () => {
			abortController.abort();
		};

		let connection: MCPServerConnection | undefined;
		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const config = userConfig.mcpServers?.[name] ?? projectConfig.mcpServers?.[name];

			if (!config) {
				this.#ctx.ctx.showError(
					`Server "${name}" not found.\n\nTip: Run ${theme.fg("accent", "/mcp list")} to see available servers.`,
				);
				return;
			}
			if (config.enabled === false) {
				this.#ctx.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			this.#showMessage(
				["", theme.fg("muted", `Testing connection to "${name}"... (esc to cancel)`), ""].join("\n"),
			);

			let resolvedConfig: MCPServerConfig;
			if (this.#ctx.ctx.mcpManager) {
				resolvedConfig = await this.#ctx.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.#ctx.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });
			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				theme.fg("success", `✓ Successfully connected to "${name}"`),
				"",
				`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  Tools: ${tools.length}`,
			];

			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#ctx.syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				this.#ctx.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			this.#ctx.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			this.#ctx.ctx.editor.onEscape = originalOnEscape;
			if (connection) {
				void disconnectServer(connection);
			}
		}
	}

	async handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#ctx.findConfiguredServer(name);
			if (!found) {
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.#ctx.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.#ctx.ctx.showError(`Server "${name}" not found.`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
							"\n",
						),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#ctx.reloadMCP();
					const state = await this.#ctx.waitForServerConnection(name);
					const status =
						state === "connected"
							? theme.fg("success", "Connected")
							: state === "connecting"
								? theme.fg("muted", "Connecting")
								: theme.fg("warning", "Not connected yet");
					this.#showMessage(
						["", theme.fg("success", `✓ Enabled "${name}"`), "", `  Status: ${status}`, ""].join("\n"),
					);
				} else {
					await this.#ctx.ctx.mcpManager?.disconnectServer(name);
					await this.#ctx.ctx.session.refreshMCPTools(this.#ctx.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(["", theme.fg("success", `✓ Disabled "${name}"`), ""].join("\n"));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.#showMessage(
					["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			await this.#ctx.reloadMCP();

			let status = "";
			if (enabled) {
				const state = await this.#ctx.waitForServerConnection(name);
				status =
					state === "connected"
						? theme.fg("success", "Connected")
						: state === "connecting"
							? theme.fg("muted", "Connecting")
							: theme.fg("warning", "Not connected yet");
			}

			const lines = [
				"",
				theme.fg("success", `✓ ${enabled ? "Enabled" : "Disabled"} "${name}" (${found.scope} config)`),
			];
			if (status) {
				lines.push("");
				lines.push(`  Status: ${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.#ctx.ctx.showError(
				`Failed to ${enabled ? "enable" : "disable"} server: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#showMessage(text: string): void {
		this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.ui.requestRender();
	}
}
