/**
 * Read-only `/mcp resources` / `/mcp prompts` / `/mcp notifications` introspection
 * subcommands. Pure queries against {@link MCPManager} — no config mutations, no
 * outbound network calls. Each handler renders a formatted listing into the chat.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "../components/dynamic-border";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export interface MCPCapabilitiesFlowContext {
	ctx: InteractiveModeContext;
}

export class MCPCapabilitiesFlow {
	#ctx: MCPCapabilitiesFlowContext;

	constructor(ctx: MCPCapabilitiesFlowContext) {
		this.#ctx = ctx;
	}

	async handleResources(): Promise<void> {
		if (!this.#ctx.ctx.mcpManager) {
			this.#ctx.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.#ctx.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Resources"), ""];
		let hasAny = false;

		for (const name of servers) {
			const data = this.#ctx.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const r of resources) {
				const desc =
					r.description !== null && r.description !== undefined && r.description !== ""
						? ` ${theme.fg("dim", r.description)}`
						: "";
				const mime =
					r.mimeType !== null && r.mimeType !== undefined && r.mimeType !== ""
						? ` ${theme.fg("dim", `[${r.mimeType}]`)}`
						: "";
				lines.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${theme.fg("muted", "Templates:")}`);
				for (const t of templates) {
					const desc =
						t.description !== null && t.description !== undefined && t.description !== ""
							? ` ${theme.fg("dim", t.description)}`
							: "";
					lines.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No resources available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async handlePrompts(): Promise<void> {
		if (!this.#ctx.ctx.mcpManager) {
			this.#ctx.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.#ctx.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Prompts"), ""];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.#ctx.ctx.mcpManager.getServerPrompts(name);
			if (prompts?.length === null || prompts?.length === undefined || prompts?.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc =
					p.description !== null && p.description !== undefined && p.description !== ""
						? ` ${theme.fg("dim", p.description)}`
						: "";
				lines.push(`  ${theme.fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length !== null && p.arguments?.length !== undefined && p.arguments?.length !== 0) {
					for (const arg of p.arguments) {
						const required = arg.required === true ? theme.fg("warning", " *") : "";
						const argDesc =
							arg.description !== null && arg.description !== undefined && arg.description !== ""
								? ` - ${arg.description}`
								: "";
						lines.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No prompts available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async handleNotifications(): Promise<void> {
		if (!this.#ctx.ctx.mcpManager) {
			this.#ctx.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.#ctx.ctx.mcpManager.getNotificationState();
		const servers = this.#ctx.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
		const lines: string[] = ["", theme.bold("MCP Notifications"), ""];
		lines.push(`  Status: ${statusIcon}  ${theme.fg("dim", "(mcp.notifications setting)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.#ctx.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			const check = theme.fg("success", "✓");
			const cross = theme.fg("dim", "✗");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? theme.fg("success", `subscribed (${subCount} URI${subCount !== 1 ? "s" : ""})`)
						: enabled
							? theme.fg("muted", "no active subscriptions")
							: theme.fg("dim", "inactive (notifications disabled)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${theme.fg("success", "✓")} ${theme.fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${theme.fg("dim", "not supported")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No servers support notifications."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	#showMessage(text: string): void {
		this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.ui.requestRender();
	}
}
