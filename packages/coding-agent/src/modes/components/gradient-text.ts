import { theme } from "../theme/theme";

const RESET_FG = "\x1b[39m";

// Default endpoints: violet → cyan, matches the pi-vivid wordmark palette.
const DEFAULT_FROM_HEX = "#C084FC";
const DEFAULT_TO_HEX = "#A5F3FC";

// Stepped 256-color palette for terminals without truecolor (kept compatible
// with the legacy welcome.ts wordmark so the look is unchanged on those).
const DEFAULT_PALETTE_256 = [141, 135, 99, 75, 81, 51];

export interface GradientOptions {
	fromHex?: string;
	toHex?: string;
	palette256?: number[];
	/** When set, ignore color mode and force this path. Useful for tests. */
	force?: "truecolor" | "256color";
}

function parseHex(hex: string): [number, number, number] {
	const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
	if (!m) return [255, 255, 255];
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbAnsi(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function ansi256(idx: number): string {
	return `\x1b[38;5;${idx}m`;
}

function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n";
}

/**
 * Apply a per-character gradient across `text`.
 *
 * - Truecolor terminals: smooth 24-bit RGB interpolation between fromHex and toHex.
 * - 256-color terminals: stepped walk through palette256 (defaults to a violet→cyan ramp).
 * - Whitespace is preserved without color codes (so background stays clean).
 *
 * Returns the colored string with a single trailing fg reset (`\x1b[39m`).
 */
export function gradientText(text: string, options: GradientOptions = {}): string {
	if (text.length === 0) return text;

	const mode = options.force ?? theme.getColorMode();
	if (mode === "truecolor") {
		return gradientTruecolor(text, options.fromHex ?? DEFAULT_FROM_HEX, options.toHex ?? DEFAULT_TO_HEX);
	}
	return gradientStepped256(text, options.palette256 ?? DEFAULT_PALETTE_256);
}

function gradientTruecolor(text: string, fromHex: string, toHex: string): string {
	const [r1, g1, b1] = parseHex(fromHex);
	const [r2, g2, b2] = parseHex(toHex);
	const chars = [...text];
	const denom = Math.max(1, chars.length - 1);
	let result = "";
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (isWhitespace(ch)) {
			result += ch;
			continue;
		}
		const t = i / denom;
		const r = lerp(r1, r2, t);
		const g = lerp(g1, g2, t);
		const b = lerp(b1, b2, t);
		result += rgbAnsi(r, g, b) + ch;
	}
	return result + RESET_FG;
}

function gradientStepped256(text: string, palette: number[]): string {
	if (palette.length === 0) return text;
	const chars = [...text];
	const step = Math.max(1, Math.floor(chars.length / palette.length));
	let colorIdx = 0;
	let result = "";
	for (let i = 0; i < chars.length; i++) {
		if (i > 0 && i % step === 0 && colorIdx < palette.length - 1) {
			colorIdx++;
		}
		const ch = chars[i];
		if (isWhitespace(ch)) {
			result += ch;
			continue;
		}
		result += ansi256(palette[colorIdx]) + ch;
	}
	return result + RESET_FG;
}
