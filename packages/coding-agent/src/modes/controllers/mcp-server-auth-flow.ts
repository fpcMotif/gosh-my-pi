/**
 * `/mcp unauth <name>` and `/mcp reauth <name>` subcommands.
 *
 * Per-server OAuth lifecycle: strip cached credentials (unauth) or strip-and-
 * redo the OAuth dance with the same endpoints (reauth). Both reload the MCP
 * runtime after writing the config so the live connections reflect the new
 * auth state.
 *
 * The Context advertises the shared helpers this flow depends on. Several
 * (`findConfiguredServer`, `stripOAuthAuth`, `resolveOAuthEndpointsFromServer`,
 * `waitForServerConnection`, `runOAuthFlow`) are also used by the Add flow and
 * inventory's `setEnabled` path; they stay on the parent controller until
 * those flows are extracted, then can move to a shared helpers Module.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import type { MCPAuthConfig, MCPServerConfig } from "../../mcp/types";
import { DynamicBorder } from "../components/dynamic-border";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export interface MCPServerAuthFlowContext {
	ctx: InteractiveModeContext;
	reloadMCP(): Promise<void>;
	findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user" | "project"; config: MCPServerConfig } | null>;
	removeManagedOAuthCredential(credentialId: string | undefined): Promise<void>;
	stripOAuthAuth(config: MCPServerConfig): MCPServerConfig;
	resolveOAuthEndpointsFromServer(config: MCPServerConfig): Promise<{
		authorizationUrl: string;
		tokenUrl: string;
		clientId?: string;
		scopes?: string;
	}>;
	runOAuthFlow(
		authorizationUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		callbackPort?: number,
		callbackPath?: string,
		redirectUri?: string,
	): Promise<string>;
	waitForServerConnection(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected">;
	updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void>;
}

export class MCPServerAuthFlow {
	#ctx: MCPServerAuthFlowContext;

	constructor(ctx: MCPServerAuthFlowContext) {
		this.#ctx = ctx;
	}

	async handleUnauth(name: string | undefined): Promise<void> {
		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#ctx.findConfiguredServer(name);
			if (!found) {
				this.#ctx.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			if (currentAuth?.type === "oauth") {
				await this.#ctx.removeManagedOAuthCredential(currentAuth.credentialId);
			}

			const updated = this.#ctx.stripOAuthAuth(found.config);
			await this.#ctx.updateMCPServer(found.filePath, name, updated);
			await this.#ctx.reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `✓ Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.#ctx.ctx.showError(`Failed to clear auth: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async handleReauth(name: string | undefined): Promise<void> {
		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError("Server name required. Usage: /mcp reauth <name>");
			return;
		}

		try {
			const found = await this.#ctx.findConfiguredServer(name);
			if (!found) {
				this.#ctx.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			if (found.config.enabled === false) {
				this.#ctx.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			if (currentAuth?.type === "oauth") {
				await this.#ctx.removeManagedOAuthCredential(currentAuth.credentialId);
			}

			const baseConfig = this.#ctx.stripOAuthAuth(found.config);
			const oauth = await this.#ctx.resolveOAuthEndpointsFromServer(baseConfig);
			const oauthClientSecret = found.config.oauth?.clientSecret ?? currentAuth?.clientSecret ?? "";

			this.#showMessage(["", theme.fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));

			const credentialId = await this.#ctx.runOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				oauth.clientId ?? found.config.oauth?.clientId ?? "",
				oauthClientSecret,
				oauth.scopes ?? "",
				found.config.oauth?.callbackPort,
				found.config.oauth?.callbackPath,
				found.config.oauth?.redirectUri,
			);

			const updated: MCPServerConfig = {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId,
					tokenUrl: oauth.tokenUrl,
					clientId: oauth.clientId ?? found.config.oauth?.clientId,
					clientSecret: oauthClientSecret || undefined,
				},
			};
			await this.#ctx.updateMCPServer(found.filePath, name, updated);
			await this.#ctx.reloadMCP();
			const state = await this.#ctx.waitForServerConnection(name);

			const lines = [
				"",
				theme.fg("success", `✓ Reauthorized "${name}" (${found.scope} config)`),
				"",
				`  Status: ${
					state === "connected"
						? theme.fg("success", "connected")
						: state === "connecting"
							? theme.fg("muted", "connecting")
							: theme.fg("warning", "not connected")
				}`,
				"",
			];
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.#ctx.ctx.showError(
				`Failed to reauthorize server: ${error instanceof Error ? error.message : String(error)}`,
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
