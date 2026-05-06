/**
 * Pure text-display utilities — no pi-natives dependency.
 *
 * These were originally in `@oh-my-pi/pi-tui` but they're not TUI-specific
 * and don't need the native addon. Anything that needs to compute display
 * widths, expand tabs, or pad strings can use them. Moved here as part of
 * the pi-tui deprecation (candidate #3).
 *
 * pi-tui still re-exports these names for backward compatibility; new
 * code should import from `@oh-my-pi/pi-utils` directly.
 *
 * The native-addon-coupled utilities (`truncateToWidth`, `wrapTextWithAnsi`,
 * `Ellipsis`) stay in pi-tui — moving them here would force every pi-utils
 * consumer to load pi-natives at module-init time, which breaks dev
 * environments that don't have the native addon built.
 */

import { getDefaultTabWidth, getIndentation } from "./tab-spacing";

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);

/**
 * Replace tabs with configured spacing for consistent rendering.
 */
export function replaceTabs(text: string, file?: string): string {
	return text.replaceAll("\t", " ".repeat(getIndentation(file)));
}

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}

/**
 * Calculate the visible width of a string in terminal columns. Includes
 * tab expansion (using configured tab width) and east-asian-wide character
 * handling via `Bun.stringWidth`.
 */
export function visibleWidth(str: string): number {
	if (!str) return 0;

	// Fast path: pure ASCII printable
	let tabLength = 0;
	const tabWidth = getDefaultTabWidth();
	let isPureAscii = true;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 9) {
			tabLength += tabWidth;
		} else if (code < 0x20 || code > 0x7e) {
			isPureAscii = false;
		}
	}
	if (isPureAscii) {
		return str.length + tabLength;
	}
	return Bun.stringWidth(str) + tabLength;
}
