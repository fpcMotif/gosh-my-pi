/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { loadCapability } from "../../discovery";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "../components/dynamic-border";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

type SSHAddScope = "user" | "project";

export class SSHCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /ssh command and route to subcommands
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
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /ssh help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("SSH Host Management"),
			"",
			"Manage SSH host configurations for remote command execution.",
			"",
			theme.fg("accent", "Commands:"),
			"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			"  /ssh list             List all configured SSH hosts",
			"  /ssh remove <name> [--scope project|user]    Remove an SSH host (default: project)",
			"  /ssh help             Show this help message",
			"",
		].join("\n");
		this.#showMessage(helpText);
	}

	/**
	 * Handle /ssh add - parse flags and add host to config
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddArgs(text);
		if (!parsed) return;

		const { name, host, username, port, keyPath, description, compat, scope } = parsed;
		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);

			const config: SSHHostConfig = { host };
			if (username) config.username = username;
			if (port) config.port = port;
			if (keyPath) config.keyPath = keyPath;
			if (description) config.description = description;
			if (compat) config.compat = true;

			await addSSHHost(filePath, name, config);

			const lines = [
				"",
				theme.fg("success", `✓ Added SSH host "${name}" to ${scope} config`),
				"",
				`  Host: ${host}`,
			];
			if (username) lines.push(`  User: ${username}`);
			if (port) lines.push(`  Port: ${port}`);
			if (keyPath) lines.push(`  Key:  ${keyPath}`);
			if (description) lines.push(`  Desc: ${description}`);
			if (compat) lines.push(`  Compat: true`);
			lines.push("", theme.fg("muted", `Run ${theme.fg("accent", "/ssh list")} to see all configured hosts.`), "");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const help = errorMsg.includes("already exists")
				? `\n\nTip: Use ${theme.fg("accent", "/ssh remove")} first.`
				: "";
			this.ctx.showError(`Failed to add host: ${errorMsg}${help}`);
		}
	}

	#parseAddArgs(text: string): {
		name: string;
		host: string;
		username?: string;
		port?: number;
		keyPath?: string;
		description?: string;
		compat: boolean;
		scope: SSHAddScope;
	} | null {
		const match = text.match(/^\/ssh\s+add\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (!rest || tokens.length === 0) {
			this.ctx.showError(
				"Usage: /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			);
			return null;
		}

		let name: string | undefined;
		let host: string | undefined;
		let username: string | undefined;
		let port: number | undefined;
		let keyPath: string | undefined;
		let description: string | undefined;
		let compat = false;
		let scope: SSHAddScope = "project";

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}
		while (i < tokens.length) {
			const tok = tokens[i];
			if (tok === "--host") {
				host = tokens[i + 1];
				i += 2;
			} else if (tok === "--user") {
				username = tokens[i + 1];
				i += 2;
			} else if (tok === "--port") {
				port = Number.parseInt(tokens[i + 1] ?? "", 10);
				i += 2;
			} else if (tok === "--key") {
				keyPath = tokens[i + 1];
				i += 2;
			} else if (tok === "--desc") {
				description = tokens[i + 1];
				i += 2;
			} else if (tok === "--compat") {
				compat = true;
				i += 1;
			} else if (tok === "--scope") {
				const val = tokens[i + 1];
				if (val !== "project" && val !== "user") {
					this.ctx.showError("Invalid --scope. Use project or user.");
					return null;
				}
				scope = val;
				i += 2;
			} else {
				this.ctx.showError(`Unknown option: ${tok}`);
				return null;
			}
		}

		if (!name) {
			this.ctx.showError("Host name required.");
			return null;
		}
		if (!host) {
			this.ctx.showError("--host is required.");
			return null;
		}
		return { name, host, username, port, keyPath, description, compat, scope };
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();
			const [userCfg, projectCfg] = await Promise.all([
				readSSHConfigFile(getSSHConfigPath("user", cwd)),
				readSSHConfigFile(getSSHConfigPath("project", cwd)),
			]);

			const userHosts = Object.keys(userCfg.hosts ?? {});
			const projectHosts = Object.keys(projectCfg.hosts ?? {});
			const configNames = new Set([...userHosts, ...projectHosts]);

			let discHosts: SSHHost[] = [];
			try {
				const res = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discHosts = res.items.filter(h => !configNames.has(h.name));
			} catch {}

			if (!userHosts.length && !projectHosts.length && !discHosts.length) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No SSH hosts configured."),
						"",
						`Use ${theme.fg("accent", "/ssh add")} to add a host.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured SSH Hosts"), ""];
			this.#appendHostLines(lines, "User level", "(~/.omp/agent/ssh.json)", userCfg.hosts ?? {});
			this.#appendHostLines(lines, "Project level", "(.omp/ssh.json)", projectCfg.hosts ?? {});
			this.#appendDiscoveredHostLines(lines, discHosts);

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list hosts: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#appendHostLines(lines: string[], label: string, path: string, hosts: Record<string, SSHHostConfig>): void {
		const names = Object.keys(hosts);
		if (!names.length) return;
		lines.push(theme.fg("accent", label) + theme.fg("muted", ` ${path}:`));
		for (const name of names) lines.push(`  ${theme.fg("accent", name)} ${this.#formatHostDetails(hosts[name])}`);
		lines.push("");
	}

	#appendDiscoveredHostLines(lines: string[], discovered: SSHHost[]): void {
		if (!discovered.length) return;
		const bySrc = new Map<string, SSHHost[]>();
		for (const h of discovered) {
			const key = `${h._source.providerName}|${h._source.path}`;
			let g = bySrc.get(key);
			if (!g) {
				g = [];
				bySrc.set(key, g);
			}
			g.push(h);
		}
		for (const [key, hosts] of bySrc) {
			const [prov, p] = key.split("|");
			lines.push(
				theme.fg("accent", "Discovered") +
					theme.fg("muted", ` (${prov}: ${shortenPath(p)}):`) +
					theme.fg("dim", " read-only"),
			);
			for (const h of hosts) lines.push(`  ${theme.fg("accent", h.name)} ${this.#formatHostDetails(h)}`);
			lines.push("");
		}
	}

	/**
	 * Format host details (host, user, port) for display
	 */
	#formatHostDetails(config: { host?: string; username?: string; port?: number }): string {
		const parts: string[] = [];
		if (config.host) parts.push(config.host);
		if (config.username) parts.push(`user=${config.username}`);
		if (config.port && config.port !== 22) parts.push(`port=${config.port}`);
		return theme.fg("dim", parts.length > 0 ? `[${parts.join(", ")}]` : "");
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(text: string): Promise<void> {
		const tokens = parseCommandArgs(text.match(/^\/ssh\s+(?:remove|rm)\b\s*(.*)$/i)?.[1]?.trim() ?? "");
		let name: string | undefined;
		let scope: "project" | "user" = "project";
		let i = 0;
		if (tokens.length > 0 && !tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}
		while (i < tokens.length) {
			if (tokens[i] === "--scope") {
				const val = tokens[i + 1];
				if (val !== "project" && val !== "user") {
					this.ctx.showError("Invalid --scope.");
					return;
				}
				scope = val;
				i += 2;
			} else {
				this.ctx.showError(`Unknown option: ${tokens[i]}`);
				return;
			}
		}

		if (!name) {
			this.ctx.showError("Host name required.");
			return;
		}

		try {
			const filePath = getSSHConfigPath(scope, getProjectDir());
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(`Host "${name}" not found in ${scope} config.`);
				return;
			}
			await removeSSHHost(filePath, name);
			this.#showMessage(
				["", theme.fg("success", `✓ Removed SSH host "${name}" from ${scope} config`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to remove host: ${error instanceof Error ? error.message : String(error)}`);
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
