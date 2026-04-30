import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

export interface RowSplitOptions {
	/**
	 * Fixed width (in cells) of the left column. The right column gets
	 * `totalWidth - leftWidth - separatorWidth`.
	 */
	leftWidth: number;
	/**
	 * Optional one-character separator drawn between columns. Defaults to a
	 * dim vertical rule (`│`). Pass an empty string to omit.
	 */
	separator?: string;
}

/**
 * Renders two children side-by-side, each padded to its column width.
 *
 * Useful for laying out a sidebar (left) alongside a main area (right) inside
 * a parent that hands down a single `width`. Lines are aligned; the shorter
 * side is padded with empty rows.
 *
 * The renderer is single-pass and ANSI-aware — colors inside child output
 * are preserved as long as the child returns one ANSI-colored string per
 * logical row.
 */
export class RowSplit implements Component {
	#left: Component;
	#right: Component;
	#leftWidth: number;
	#separator: string;

	constructor(left: Component, right: Component, options: RowSplitOptions) {
		this.#left = left;
		this.#right = right;
		this.#leftWidth = Math.max(0, options.leftWidth | 0);
		this.#separator = options.separator ?? "";
	}

	setLeftWidth(width: number): void {
		this.#leftWidth = Math.max(0, width | 0);
	}

	invalidate(): void {
		this.#left.invalidate?.();
		this.#right.invalidate?.();
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		// Render the configured separator with the dim-rule fallback only when
		// the caller supplied no override and there's room to draw it.
		const sepRaw = this.#separator || (width >= 4 ? theme.boxRound.vertical : "");
		const sepWidth = visibleWidth(sepRaw);
		const styledSep = sepRaw === theme.boxRound.vertical ? theme.fg("dim", sepRaw) : sepRaw;

		const leftCol = Math.min(this.#leftWidth, Math.max(0, width - sepWidth - 1));
		const rightCol = Math.max(0, width - leftCol - sepWidth);

		const leftLines = leftCol > 0 ? this.#left.render(leftCol) : [];
		const rightLines = rightCol > 0 ? this.#right.render(rightCol) : [];

		const rowCount = Math.max(leftLines.length, rightLines.length);
		if (rowCount === 0) return [];

		const out: string[] = [];
		for (let i = 0; i < rowCount; i++) {
			const left = leftLines[i] ?? "";
			const right = rightLines[i] ?? "";
			out.push(padTo(left, leftCol) + styledSep + padTo(right, rightCol));
		}
		return out;
	}
}

/** Pad an ANSI-colored line to exactly `target` visible cells (truncating if longer). */
function padTo(line: string, target: number): string {
	const vis = visibleWidth(line);
	if (vis === target) return line;
	if (vis < target) return line + padding(target - vis);
	return truncateToWidth(line, target);
}
