import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { shortenPath } from "../../tools/render-utils";
import { gradientText } from "./gradient-text";

export interface HeaderBarOptions {
	/** Brand text shown as a gradient (default: "OH MY PI"). */
	brand?: string;
	/** Working directory shown after the wordmark. */
	cwd?: string;
	/** Context % shown as a small indicator (e.g. 12 → "12% ctx"). Hidden when undefined. */
	contextPct?: number;
	/** Short keybinding hints (e.g. "? help", "Ctrl+C exit"). Joined with separator dots. */
	hints?: string[];
}

/**
 * One-line persistent header used during sessions in vivid layout.
 * Shows: gradient brand · cwd · ctx% · key hints — extending across the terminal width.
 */
export class HeaderBar implements Component {
	#brand: string;
	#cwd: string;
	#contextPct?: number;
	#hints: string[];

	constructor(options: HeaderBarOptions = {}) {
		this.#brand = options.brand ?? "OH MY PI";
		this.#cwd = options.cwd ?? "";
		this.#contextPct = options.contextPct;
		this.#hints = options.hints ?? ["? help"];
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	setContextPct(pct: number | undefined): void {
		this.#contextPct = pct;
	}

	setHints(hints: string[]): void {
		this.#hints = hints;
	}

	invalidate(): void {}

	render(termWidth: number): string[] {
		if (termWidth <= 0) return [];

		const wordmark = gradientText(this.#brand);
		const dot = theme.fg("dim", ` ${theme.sep.dot} `);
		const segments: string[] = [wordmark];

		if (this.#cwd) {
			const cwdNormalized = shortenPath(this.#cwd).replace(/\\/g, "/");
			segments.push(theme.fg("muted", cwdNormalized));
		}
		if (this.#contextPct !== undefined) {
			segments.push(theme.fg("dim", `${this.#contextPct}% ctx`));
		}
		for (const hint of this.#hints) {
			segments.push(theme.fg("dim", hint));
		}

		const composed = segments.join(dot);
		const visLen = visibleWidth(composed);
		if (visLen >= termWidth) {
			return [truncateToWidth(composed, termWidth)];
		}

		// Trailing horizontal rule fragment to extend the bar visually.
		const fillWidth = Math.max(0, termWidth - visLen - 1);
		const fill = " " + theme.fg("dim", theme.boxRound.horizontal.repeat(fillWidth));
		return [composed + fill];
	}

	/** Helper for callers that need a fixed-width pad to align the header against a sidebar. */
	renderPadded(termWidth: number, _leftOffset = 0): string[] {
		const lines = this.render(termWidth);
		if (lines.length === 0) return [];
		const out: string[] = [];
		for (const line of lines) {
			const visLen = visibleWidth(line);
			if (visLen >= termWidth) {
				out.push(line);
			} else {
				out.push(line + padding(termWidth - visLen));
			}
		}
		return out;
	}
}
