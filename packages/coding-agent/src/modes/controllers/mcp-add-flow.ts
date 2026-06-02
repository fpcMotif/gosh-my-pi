/**
 * `/mcp add` subcommand + the OAuth + connection-test machinery the wizard
 * needs. Also exposes the wizard-complete pipeline (config write + reload +
 * activate tools) which {@link "./mcp-smithery-flow".MCPSmitheryFlow} reaches
 * back into via its `deployServer` Context callback, and the OAuth + test
 * primitives which {@link "./mcp-server-auth-flow".MCPServerAuthFlow} uses
 * for reauth.
 *
 * The Context advertises only the truly cross-flow dependencies
 * (`reloadMCP`, `waitForServerConnection`, `syncManagerConnection`); the
 * Add-internal helpers (parseAddCommand, MCPAddWizard composition) live here.
 */
import type { OAuthCredential } from "@oh-my-pi/pi-ai";
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { analyzeAuthError, discoverOAuthEndpoints, MCPManager } from "../../mcp";
import { connectToServer, disconnectServer } from "../../mcp/client";
import { addMCPServer } from "../../mcp/config-writer";
import { MCPOAuthFlow } from "../../mcp/oauth-flow";
import type { MCPServerConfig } from "../../mcp/types";
import { openPath } from "../../utils/open";
import { DynamicBorder } from "../components/dynamic-border";
import { MCPAddWizard } from "../components/mcp-add-wizard";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export type MCPAddScope = "user" | "project";

type MCPAddTransport = "http" | "sse";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

export interface MCPAddFlowContext {
	ctx: InteractiveModeContext;
	reloadMCP(): Promise<void>;
	waitForServerConnection(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected">;
	syncManagerConnection(name: string, config: MCPServerConfig): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

export class MCPAddFlow {
	#ctx: MCPAddFlowContext;

	constructor(ctx: MCPAddFlowContext) {
		this.#ctx = ctx;
	}

	async handle(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error !== null && parsed.error !== undefined && parsed.error !== "") {
			this.#ctx.ctx.showError(parsed.error);
			return;
		}
		if (
			parsed.quickConfig &&
			parsed.initialName !== null &&
			parsed.initialName !== undefined &&
			parsed.initialName !== ""
		) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (parsed.isCommandQuickAdd !== true && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.testConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken === true) {
						this.#ctx.ctx.showError(
							`Authentication failed for "${parsed.initialName}": ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(finalConfig.url, authResult.authServerUrl);
							} catch {
								// Ignore discovery error and handle below.
							}
						}

						if (!oauth) {
							this.#ctx.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const oauthClientSecret = finalConfig.oauth?.clientSecret ?? "";
							const credentialId = await this.runOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								oauthClientSecret,
								oauth.scopes ?? "",
								finalConfig.oauth?.callbackPort,
								finalConfig.oauth?.callbackPath,
								finalConfig.oauth?.redirectUri,
							);
							finalConfig = {
								...finalConfig,
								auth: {
									type: "oauth",
									credentialId,
									tokenUrl: oauth.tokenUrl,
									clientId: oauth.clientId ?? finalConfig.oauth?.clientId,
									clientSecret: finalConfig.oauth?.clientSecret,
								},
							};
						} catch (oauthError) {
							this.#ctx.ctx.showError(
								`OAuth flow failed for "${parsed.initialName}": ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			}

			await this.completeWizard(parsed.initialName, finalConfig, parsed.scope);
			return;
		}

		// Save current editor state
		const done = (): void => {
			this.#ctx.ctx.editorContainer.clear();
			this.#ctx.ctx.editorContainer.addChild(this.#ctx.ctx.editor);
			this.#ctx.ctx.ui.setFocus(this.#ctx.ctx.editor);
		};

		// Create wizard with OAuth handler and connection test
		const wizard = new MCPAddWizard(
			async (name: string, config: MCPServerConfig, scope: "user" | "project") => {
				done();
				await this.completeWizard(name, config, scope);
			},
			() => {
				done();
				this.cancelWizard();
			},
			async (authUrl: string, tokenUrl: string, clientId: string, clientSecret: string, scopes: string) => {
				return await this.runOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes);
			},
			async (config: MCPServerConfig) => {
				return await this.testConnection(config);
			},
			() => {
				this.#ctx.ctx.ui.requestRender();
			},
			parsed.initialName,
		);

		// Replace editor with wizard
		this.#ctx.ctx.editorContainer.clear();
		this.#ctx.ctx.editorContainer.addChild(wizard);
		this.#ctx.ctx.ui.setFocus(wizard);
		this.#ctx.ctx.ui.requestRender();
	}

	/**
	 * OAuth flow runner. Exposed so the server-auth flow can reuse it for reauth.
	 */
	async runOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		callbackPort?: number,
		callbackPath?: string,
		redirectUri?: string,
	): Promise<string> {
		const authStorage = this.#ctx.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		const resolvedClientId = clientId.trim() || (parsedAuthUrl.searchParams.get("client_id") ?? undefined);
		const resolvedClientSecret = clientSecret.trim() || undefined;

		try {
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl,
					clientId: resolvedClientId,
					clientSecret: resolvedClientSecret,
					scopes: scopes || undefined,
					redirectUri,
					callbackPort,
					callbackPath,
				},
				{
					onAuth: (info: { url: string; instructions?: string }) => {
						this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
						this.#ctx.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0),
						);
						this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
						this.#ctx.ctx.chatContainer.addChild(
							new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0),
						);
						this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
						this.#ctx.ctx.chatContainer.addChild(
							new Text(
								theme.fg("muted", "Waiting for authorization... (Press Ctrl+C to cancel, 5 minute timeout)"),
								1,
								0,
							),
						);
						this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
						this.#ctx.ctx.chatContainer.addChild(
							new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0),
						);
						this.#ctx.ctx.ui.requestRender();
						try {
							openPath(info.url);

							this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
							this.#ctx.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "→ Opening browser automatically..."), 1, 0),
							);
							this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
							this.#ctx.ctx.chatContainer.addChild(
								new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0),
							);
							this.#ctx.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
							);
							this.#ctx.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
							this.#ctx.ctx.ui.requestRender();
						} catch {
							this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
							this.#ctx.ctx.chatContainer.addChild(
								new Text(theme.fg("warning", "→ Could not open browser automatically"), 1, 0),
							);
							this.#ctx.ctx.chatContainer.addChild(
								new Text(theme.fg("success", "Copy this exact URL in your browser:"), 1, 0),
							);
							this.#ctx.ctx.chatContainer.addChild(new Text(theme.fg("accent", info.url), 1, 0));
							this.#ctx.ctx.ui.requestRender();
						}
					},
					onProgress: (message: string) => {
						this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
						this.#ctx.ctx.chatContainer.addChild(new Text(theme.fg("muted", message), 1, 0));
						this.#ctx.ctx.ui.requestRender();
					},
				},
			);

			const credentials = await withTimeout(flow.login(), 5 * 60 * 1000, "OAuth flow timed out after 5 minutes");

			this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
			this.#ctx.ctx.chatContainer.addChild(
				new Text(theme.fg("success", "✓ Authorization completed in browser."), 1, 0),
			);
			this.#ctx.ctx.ui.requestRender();

			const credentialId = `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

			const oauthCredential: OAuthCredential = {
				type: "oauth",
				...credentials,
			};

			await authStorage.set(credentialId, oauthCredential);

			return credentialId;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				throw new Error("OAuth flow timed out. Please try again.");
			} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
				throw new Error("OAuth authorization failed. Please check your client credentials.");
			} else if (errorMsg.includes("invalid_grant")) {
				throw new Error("OAuth authorization code is invalid or expired. Please try again.");
			} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
				throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
			} else {
				throw new Error(`OAuth authentication failed: ${errorMsg}`);
			}
		}
	}

	/**
	 * Test connection to an MCP server. Throws if it fails. Exposed so the
	 * server-auth flow's `resolveOAuthEndpointsFromServer` can use it to probe
	 * whether a server actually needs OAuth.
	 */
	async testConnection(config: MCPServerConfig): Promise<void> {
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.#ctx.ctx.mcpManager) {
			resolvedConfig = await this.#ctx.ctx.mcpManager.prepareConfig(config);
		} else {
			const tempManager = new MCPManager(getProjectDir());
			tempManager.setAuthStorage(this.#ctx.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	/**
	 * Final step of `/mcp add` (also the `deployServer` callback for the
	 * Smithery flow's registry-driven add path). Writes the server to config,
	 * reloads, waits for connection, activates the new server's tools, surfaces
	 * the result.
	 */
	async completeWizard(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			const cwd = getProjectDir();
			const filePath = getMCPConfigPath(scope, cwd);

			await addMCPServer(filePath, name, config);

			await this.#ctx.reloadMCP();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#ctx.waitForServerConnection(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.testConnection(config);
					isConnected = true;
					await this.#ctx.syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// refreshMCPTools preserves the prior MCP tool selection, so tools from
			// brand-new servers are registered in the registry but never activated.
			// Explicitly activate the newly added server's tools now.
			if (isConnected && this.#ctx.ctx.mcpManager) {
				const serverTools = this.#ctx.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.#ctx.ctx.session.getActiveToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.#ctx.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.#ctx.ctx.session.setActiveToolsByName([...new Set([...currentActive, ...toActivate])]);
					}
				}
			}

			const scopeLabel = scope === "user" ? "user" : "project";
			const lines = ["", theme.fg("success", `✓ Added server "${name}" to ${scopeLabel} config`), ""];

			if (isConnected) {
				lines.push(theme.fg("success", `✓ Successfully connected to server`));
				lines.push("");
			} else if (isConnecting) {
				lines.push(theme.fg("muted", `◌ Server is connecting in background...`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} in a few seconds.`));
				lines.push("");
			} else {
				lines.push(theme.fg("warning", `⚠ Server added but not yet connected`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} to test the connection.`));
				lines.push("");
			}

			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/mcp list")} to see all configured servers.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/mcp list")} to see existing servers.`;
			}

			this.#ctx.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	cancelWizard(): void {
		this.#showMessage(
			[
				"",
				theme.fg("muted", "Server creation cancelled."),
				"",
				theme.fg("dim", "Tip: Press Ctrl+C or Esc anytime to cancel"),
				"",
			].join("\n"),
		);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { scope, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --url." };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				const value = tokens[i + 1];
				if (!value || (value !== "http" && value !== "sse")) {
					return { scope, error: "Invalid --transport value. Use http or sse." };
				}
				transport = value;
				i += 2;
				continue;
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --token." };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `Unknown option: ${argToken}` };
		}

		if (authToken !== undefined && authToken !== "" && (url === null || url === undefined || url === "")) {
			return { scope, error: "--token requires --url (HTTP/SSE transport)." };
		}
		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (name === null || name === undefined || name === "") {
			return { scope, error: "Server name required for quick add. Usage: /mcp add <name> ..." };
		}
		if (url !== undefined && url !== "" && commandTokens !== undefined && commandTokens.length > 0) {
			return { scope, error: "Use either --url or -- <command...>, not both." };
		}

		if (commandTokens !== undefined && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers:
				authToken !== null && authToken !== undefined && authToken !== ""
					? { Authorization: `Bearer ${authToken}` }
					: undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#showMessage(text: string): void {
		this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.ui.requestRender();
	}
}
