import { type Component, truncateToWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { shortenPath } from "../../tools/render-utils";

export interface SidebarMcpServer {
	name: string;
	status: "ready" | "error" | "connecting";
	toolCount?: number;
}

export interface SidebarModelCard {
	name: string;
	provider?: string;
	thinkingLevel?: string;
}

export interface SidebarOptions {
	sessionTitle?: string;
	cwd?: string;
	mcpServers?: SidebarMcpServer[];
	model?: SidebarModelCard;
}

/**
 * Vertical info panel used as the left column under vivid layout.
 * Shows session, working directory, MCP server health, and the active model card.
 *
 * Pure presentation — pump data in via the setters; the component does not
 * subscribe to any global state itself.
 */
export class Sidebar implements Component {
	#sessionTitle: string;
	#cwd: string;
	#mcpServers: SidebarMcpServer[];
	#model?: SidebarModelCard;

	constructor(options: SidebarOptions = {}) {
		this.#sessionTitle = options.sessionTitle ?? "";
		this.#cwd = options.cwd ?? "";
		this.#mcpServers = options.mcpServers ?? [];
		this.#model = options.model;
	}

	setSessionTitle(title: string): void {
		this.#sessionTitle = title;
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	setMcpServers(servers: SidebarMcpServer[]): void {
		this.#mcpServers = servers;
	}

	setModel(model: SidebarModelCard | undefined): void {
		this.#model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const out: string[] = [];

		// Section headers honour the width budget so narrow panels don't
		// overflow on labels like "Working dir" (11 cells).
		const heading = (label: string): string => truncateToWidth(theme.bold(theme.fg("dim", label)), width);

		// Session
		out.push(heading("Session"));
		out.push(this.#row(this.#sessionTitle || "—", "muted", width));
		out.push("");

		// Working dir
		out.push(heading("Working dir"));
		const cwd = this.#cwd ? shortenPath(this.#cwd).replace(/\\/g, "/") : "—";
		out.push(this.#row(cwd, "muted", width));
		out.push("");

		// MCP
		out.push(heading("MCP"));
		if (this.#mcpServers.length === 0) {
			out.push(this.#row("none connected", "dim", width));
		} else {
			for (const server of this.#mcpServers) {
				out.push(this.#mcpRow(server, width));
			}
		}
		out.push("");

		// Model card
		out.push(heading("Model"));
		if (this.#model) {
			const diamond = theme.fg("accent", "◇");
			const name = theme.fg("statusLineModel", this.#model.name);
			out.push(truncateToWidth(`${diamond} ${name}`, width));
			if (this.#model.provider !== null && this.#model.provider !== undefined && this.#model.provider !== "") {
				out.push(this.#row(this.#model.provider, "dim", width));
			}
			if (
				this.#model.thinkingLevel !== null &&
				this.#model.thinkingLevel !== undefined &&
				this.#model.thinkingLevel !== ""
			) {
				out.push(this.#row(`thinking: ${this.#model.thinkingLevel}`, "dim", width));
			}
		} else {
			out.push(this.#row("—", "dim", width));
		}

		return out;
	}

	#row(text: string, color: "muted" | "dim", width: number): string {
		return truncateToWidth(theme.fg(color, text), width);
	}

	#mcpRow(server: SidebarMcpServer, width: number): string {
		const icon =
			server.status === "ready"
				? theme.styledSymbol("status.success", "success")
				: server.status === "connecting"
					? theme.styledSymbol("status.pending", "muted")
					: theme.styledSymbol("status.error", "error");
		const name = theme.fg("muted", server.name);
		const tools = server.toolCount !== undefined ? theme.fg("dim", ` (${server.toolCount})`) : "";
		return truncateToWidth(`${icon} ${name}${tools}`, width);
	}
}
