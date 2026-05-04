import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { HeaderBar } from "./header-bar";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

/**
 * Compact welcome surface with a gradient identity rail and session context.
 *
 * Two render modes:
 *   - Expanded (default): full bordered box on welcome / empty session.
 *   - Minimized (vivid layout, after first message): single-line gradient
 *     wordmark bar that stays at the top during the conversation.
 *
 * Toggle via setMinimized().
 */
export class WelcomeComponent implements Component {
	#minimized = false;
	#cwd: string = "";

	constructor(
		private readonly version: string,
		private modelName: string,
		private providerName: string,
		private recentSessions: RecentSession[] = [],
		private lspServers: LspServerInfo[] = [],
	) {
		try {
			this.#cwd = process.cwd();
		} catch {
			this.#cwd = "";
		}
	}

	invalidate(): void {}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	/**
	 * Switch between the full bordered welcome (false) and the thin gradient bar (true).
	 * Only takes effect under vivid layout — classic stays as a one-shot welcome.
	 */
	setMinimized(minimized: boolean): void {
		this.#minimized = minimized;
	}

	render(termWidth: number): string[] {
		if (this.#minimized && theme.layout === "vivid") {
			return this.#renderMinimized(termWidth);
		}
		return this.#renderExpanded(termWidth);
	}

	#renderMinimized(termWidth: number): string[] {
		return new HeaderBar({
			cwd: this.#cwd,
			hints: [`v${this.version}`, "? help"],
		}).render(termWidth);
	}

	#renderExpanded(termWidth: number): string[] {
		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 120;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 34;
		const minLeftCol = 20; // wordmark width
		const minRightCol = 28;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("OH MY PI"),
			visibleWidth(this.modelName),
			visibleWidth(this.providerName),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Compact wordmark (gradient: violet → cyan)
		const wordmark = this.#gradientLine("OH MY PI");
		const brandLine = `${theme.fg("dim", "coding harness")}${theme.fg("accent", " // ")}${theme.fg("muted", APP_NAME)}`;

		// Left column - centered identity and active model context
		const leftLines = [
			"",
			this.#centerText(wordmark, leftCol),
			this.#centerText(brandLine, leftCol),
			"",
			this.#centerText(theme.fg("statusLineModel", this.modelName), leftCol),
			this.#centerText(theme.fg("dim", this.providerName), leftCol),
			"",
			this.#centerText(theme.fg("muted", "ready for local changes"), leftCol),
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			for (const session of this.recentSessions.slice(0, 3)) {
				sessionLines.push(
					` ${theme.fg("dim", `${theme.md.bullet} `)}${theme.fg("muted", session.name)}${theme.fg("dim", ` (${session.timeAgo})`)}`,
				);
			}
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.success", "success")
						: server.status === "connecting"
							? theme.styledSymbol("status.pending", "muted")
							: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Shortcuts"))}`,
			` ${theme.fg("dim", "?")}${theme.fg("muted", " keyboard map")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " command palette")}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " prompt actions")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " bash")}${theme.fg("dim", "   $")}${theme.fg("muted", " python")}`,
			separator,
			` ${theme.bold(theme.fg("accent", "Language servers"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Recent work"))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} ${theme.sep.dot} vivid ui ${theme.sep.dot} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxSharp.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		return lines;
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Apply violet→cyan gradient to a string */
	#gradientLine(line: string): string {
		const colors = [
			"\x1b[38;5;141m", // violet
			"\x1b[38;5;135m", // purple
			"\x1b[38;5;99m", // blue-violet
			"\x1b[38;5;75m", // blue
			"\x1b[38;5;81m", // cyan-blue
			"\x1b[38;5;51m", // cyan
		];
		const reset = "\x1b[0m";

		let result = "";
		let colorIdx = 0;
		const step = Math.max(1, Math.floor(line.length / colors.length));

		for (let i = 0; i < line.length; i++) {
			if (i > 0 && i % step === 0 && colorIdx < colors.length - 1) {
				colorIdx++;
			}
			const char = line[i];
			if (char !== " ") {
				result += colors[colorIdx] + char + reset;
			} else {
				result += char;
			}
		}
		return result;
	}

	/**
	 * Fit string to exact width with ANSI-aware, wide-char-aware
	 * truncation/padding. Delegates to the native `truncateToWidth` so wide
	 * graphemes (CJK, emoji) and ANSI escapes are accounted for correctly.
	 */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			return truncateToWidth(str, width, undefined, true);
		}
		return str + padding(width - visLen);
	}
}
