/**
 * InspectorPanel - Detail view for selected extension.
 *
 * Shows name, description, origin, status, and kind-specific preview.
 */
import * as os from "node:os";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { theme } from "../../../modes/theme/theme";
import { shortenPath } from "../../../tools/render-utils";
import type { Extension, ExtensionState } from "./types";

interface ToolDefinition {
	parameters?: {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	inputSchema?: {
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

export class InspectorPanel implements Component {
	#extension: Extension | null = null;

	setExtension(extension: Extension | null): void {
		this.#extension = extension;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.#extension) {
			return [theme.fg("muted", "Select an extension"), theme.fg("dim", "to view details")];
		}

		const ext = this.#extension;
		const lines: string[] = [];

		// Name header
		lines.push(theme.bold(theme.fg("accent", ext.displayName)));
		lines.push("");

		// Kind badge
		lines.push(theme.fg("muted", "Type: ") + this.#getKindBadge(ext.kind));
		lines.push("");

		// Description (wrapped)
		const desc = ext.description;
		const isValidDescription = typeof desc === "string" && desc.length > 0;
		if (isValidDescription && width > 2) {
			const wrapped = wrapTextWithAnsi(desc, width - 2);
			for (const line of wrapped) {
				lines.push(truncateToWidth(line, width));
			}
			lines.push("");
		} else if (isValidDescription) {
			// Width too small for wrapping, show truncated single line
			lines.push(truncateToWidth(desc, width));
			lines.push("");
		}

		// Origin
		lines.push(theme.fg("muted", "Origin:"));
		let levelLabel = "Native";
		if (ext.source.level === "user") {
			levelLabel = "User";
		} else if (ext.source.level === "project") {
			levelLabel = "Project";
		}
		lines.push(`  ${theme.italic(`via ${ext.source.providerName} (${levelLabel})`)}`);
		const shortened = shortenPath(ext.path, os.homedir());
		// If path is very long, show just the last parts
		const displayPath =
			shortened.length > 40 && shortened.split("/").length > 3
				? `.../${shortened.split("/").slice(-3).join("/")}`
				: shortened;
		lines.push(`  ${theme.fg("dim", displayPath)}`);
		lines.push("");

		// Status badge
		lines.push(theme.fg("muted", "Status:"));
		lines.push(`  ${this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy)}`);
		lines.push("");

		// Preview section (routed based on kind)
		const previewLines = this.#renderPreview(ext, width);
		lines.push(...previewLines);

		return lines;
	}

	#renderPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];
		let content: string[] = [];

		switch (ext.kind) {
			case "context-file":
				content = this.#renderFilePreview(ext.raw, width);
				break;
			case "tool":
				content = this.#renderToolArgs(ext.raw, width);
				break;
			case "skill":
				content = this.#renderSkillContent(ext.raw, width);
				break;
			case "mcp":
				content = this.#renderMcpDetails(ext.raw, width);
				break;
			default:
				content = this.#renderDefaultPreview(ext, width);
				break;
		}

		if (content.length > 0) {
			lines.push(...content);
		}

		return lines;
	}

	#renderFilePreview(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Preview:"));
		lines.push(theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.min(width - 2, 40))));

		const content = this.#getContextFileContent(raw);
		if (content === null || content === undefined || content === "") {
			lines.push(theme.fg("dim", "  (no content)"));
			lines.push("");
			return lines;
		}

		const fileLines = content.split("\n");
		for (const line of fileLines.slice(0, 20)) {
			const highlighted = this.#highlightMarkdown(line);
			lines.push(truncateToWidth(highlighted, width - 2));
		}

		if (fileLines.length > 20) {
			lines.push(theme.fg("dim", "(truncated at line 20)"));
		}

		lines.push("");
		return lines;
	}

	#getContextFileContent(raw: unknown): string | null {
		if (typeof raw !== "object" || raw === null || !("content" in raw)) return null;
		const { content } = raw as { content?: unknown };
		return typeof content === "string" ? content : null;
	}

	#highlightMarkdown(line: string): string {
		// Basic markdown syntax highlighting
		let highlighted = line;

		// Headers
		if (/^#{1,6}\s/.test(highlighted)) {
			highlighted = theme.bold(theme.fg("accent", highlighted));
		}
		// Code blocks
		else if (highlighted.startsWith("```")) {
			highlighted = theme.fg("dim", highlighted);
		}
		// Lists
		else if (/^[\s]*[-*+]\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*[-*+]\s)/, theme.fg("accent", "$1"));
		}
		// Numbered lists
		else if (/^[\s]*\d+\.\s/.test(highlighted)) {
			highlighted = highlighted.replace(/^([\s]*\d+\.\s)/, theme.fg("accent", "$1"));
		}

		return highlighted;
	}

	#renderToolArgs(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Arguments:"));
		lines.push(theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const tool = raw as ToolDefinition;
			const params = tool?.parameters?.properties ?? tool?.inputSchema?.properties ?? {};

			if (Object.keys(params).length === 0) {
				lines.push(theme.fg("dim", "  (no arguments)"));
			} else {
				this.#renderToolParams(lines, tool);
			}
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse tool definition)"));
		}

		lines.push("");
		return lines;
	}

	#renderToolParams(lines: string[], tool: ToolDefinition): void {
		const params = tool.parameters?.properties ?? tool.inputSchema?.properties ?? {};
		const required = new Set(tool.parameters?.required ?? tool.inputSchema?.required ?? []);

		for (const [name, spec] of Object.entries(params)) {
			lines.push(this.#renderToolParam(name, spec, required));
		}
	}

	#renderToolParam(name: string, spec: unknown, required: Set<string>): string {
		const param = spec as { type?: string; default?: unknown };
		const type = param.type ?? "any";

		let reqCol: string;
		if (required.has(name)) {
			reqCol = theme.fg("warning", "Required");
		} else if (param.default === undefined) {
			reqCol = theme.fg("dim", "Optional");
		} else {
			reqCol = theme.fg("dim", `Default: ${JSON.stringify(param.default)}`);
		}

		const nameCol = theme.fg("accent", name.padEnd(12));
		const typeCol = theme.fg("muted", type.padEnd(10));

		return `  ${nameCol} ${typeCol} ${reqCol}`;
	}

	#renderSkillContent(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Instruction:"));
		lines.push(theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const skill = raw as { prompt?: string; instruction?: string; content?: string };
			const instruction = skill?.prompt ?? skill?.instruction ?? skill?.content ?? "";

			if (instruction === "") {
				lines.push(theme.fg("dim", "  (no instruction text)"));
			} else {
				const instructionLines = instruction.split("\n").slice(0, 15);
				for (const line of instructionLines) {
					lines.push(truncateToWidth(line, width - 2));
				}

				if (instruction.split("\n").length > 15) {
					lines.push(theme.fg("dim", "(truncated at line 15)"));
				}
			}
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse skill content)"));
		}

		lines.push("");
		return lines;
	}

	#renderMcpDetails(raw: unknown, width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("muted", "Connection:"));
		lines.push(theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.min(width - 2, 40))));

		try {
			const mcp = raw as {
				transport?: string;
				type?: string;
				command?: string;
				cmd?: string;
				args?: string[];
				arguments?: string[];
				env?: Record<string, string>;
			};
			this.#renderMcpConnectionInfo(lines, mcp);
		} catch {
			lines.push(theme.fg("dim", "  (unable to parse MCP configuration)"));
		}

		lines.push("");
		return lines;
	}

	#renderMcpConnectionInfo(
		lines: string[],
		mcp: {
			transport?: string;
			type?: string;
			command?: string;
			cmd?: string;
			args?: string[];
			arguments?: string[];
			env?: Record<string, string>;
		},
	): void {
		const transport = mcp.transport ?? mcp.type ?? "unknown";
		lines.push(`  ${theme.fg("muted", "Transport:")}  ${theme.fg("accent", transport)}`);

		const command = mcp.command ?? mcp.cmd ?? "";
		if (command !== "") {
			lines.push(`  ${theme.fg("muted", "Command:")}    ${theme.fg("success", command)}`);
		}

		const args = mcp.args ?? mcp.arguments ?? [];
		if (args.length > 0) {
			lines.push(`  ${theme.fg("muted", "Args:")}       ${theme.fg("dim", args.join(" "))}`);
		}

		this.#renderMcpEnv(lines, mcp.env);
	}

	#renderMcpEnv(lines: string[], env: Record<string, string> | undefined): void {
		if (env === undefined) return;
		const envCount = Object.keys(env).length;
		if (envCount > 0) {
			lines.push(`  ${theme.fg("muted", "Env vars:")}   ${theme.fg("dim", `${envCount} defined`)}`);
		}
	}

	#renderDefaultPreview(ext: Extension, width: number): string[] {
		const lines: string[] = [];

		// Show trigger pattern if present
		if (ext.trigger !== null && ext.trigger !== undefined && ext.trigger !== "") {
			lines.push(theme.fg("muted", "Trigger:"));
			lines.push(theme.fg("dim", theme.boxSharp.horizontal.repeat(Math.min(width - 2, 40))));
			lines.push(`  ${theme.fg("accent", ext.trigger)}`);
			lines.push("");
		}

		return lines;
	}

	#getKindBadge(kind: string): string {
		const kindColors: Record<string, string> = {
			"extension-module": "accent",
			skill: "accent",
			rule: "success",
			tool: "warning",
			mcp: "accent",
			prompt: "muted",
			hook: "warning",
			"context-file": "dim",
			instruction: "muted",
			"slash-command": "accent",
		};

		const color = kindColors[kind] || "muted";
		return theme.fg(color as "accent" | "success" | "warning" | "muted" | "dim", kind);
	}

	#getStatusBadge(state: ExtensionState, reason?: string, shadowedBy?: string): string {
		switch (state) {
			case "active":
				return theme.fg("success", `${theme.status.enabled} Active`);
			case "disabled": {
				let reasonText = "unknown";
				if (reason === "provider-disabled") {
					reasonText = "provider disabled";
				} else if (reason === "item-disabled") {
					reasonText = "manually disabled";
				}
				return theme.fg("dim", `${theme.status.disabled} Disabled (${reasonText})`);
			}
			case "shadowed": {
				const shadowedText =
					shadowedBy !== null && shadowedBy !== undefined && shadowedBy !== "" ? ` by ${shadowedBy}` : "";
				return theme.fg("warning", `${theme.status.shadowed} Shadowed${shadowedText}`);
			}
		}
	}
}
