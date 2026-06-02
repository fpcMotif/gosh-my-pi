/**
 * `/mcp reload` and `/mcp reconnect <name>` subcommands.
 *
 * These mutate live MCP runtime state (disconnect + rediscover + reconnect)
 * without touching config files. Distinct from add/remove/setEnabled which
 * mutate the user's MCP config.
 *
 * Takes `reloadMCP` as a Context callback because the full reload pipeline
 * (disconnect all, rediscover, refresh tools, surface errors) is also used by
 * the Add / Inventory / ServerAuth flows to apply config changes — it stays
 * on the parent controller until those flows are extracted, then can move to
 * a shared helper.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "../components/dynamic-border";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export interface MCPLifecycleFlowContext {
	ctx: InteractiveModeContext;
	reloadMCP(): Promise<void>;
}

export class MCPLifecycleFlow {
	#ctx: MCPLifecycleFlowContext;

	constructor(ctx: MCPLifecycleFlowContext) {
		this.#ctx = ctx;
	}

	async handleReload(): Promise<void> {
		try {
			this.#showMessage(["", theme.fg("muted", "Reloading MCP servers and runtime tools..."), ""].join("\n"));
			await this.#ctx.reloadMCP();
			const connectedCount = this.#ctx.ctx.mcpManager?.getConnectedServers().length ?? 0;
			this.#showMessage(
				["", theme.fg("success", "✓ MCP reload complete"), `  Connected servers: ${connectedCount}`, ""].join("\n"),
			);
		} catch (error) {
			this.#ctx.ctx.showError(`Failed to reload MCP: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async handleReconnect(name: string | undefined): Promise<void> {
		if (name === null || name === undefined || name === "") {
			this.#ctx.ctx.showError("Server name required. Usage: /mcp reconnect <name>");
			return;
		}
		if (!this.#ctx.ctx.mcpManager) {
			this.#ctx.ctx.showError("MCP manager not available.");
			return;
		}

		this.#showMessage(["", theme.fg("muted", `Reconnecting to "${name}"...`), ""].join("\n"));

		try {
			const connection = await this.#ctx.ctx.mcpManager.reconnectServer(name);
			if (connection) {
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
				await this.#ctx.ctx.session.refreshMCPTools(this.#ctx.ctx.mcpManager.getTools());
				const serverTools = this.#ctx.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.#showMessage(
					["\n", theme.fg("success", `✓ Reconnected to "${name}"`), `  Tools: ${serverTools.length}`, "\n"].join(
						"\n",
					),
				);
			} else {
				this.#ctx.ctx.showError(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
		} catch (error) {
			this.#ctx.ctx.showError(
				`Failed to reconnect to "${name}": ${error instanceof Error ? error.message : String(error)}`,
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
