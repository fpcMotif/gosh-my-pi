/**
 * Legacy terminal sequence parsing.
 */

import { CTRL_SYMBOL_CODES, LEGACY_SEQUENCE_KEY_IDS, LEGACY_SEQUENCE_MAP } from "./_jskey_constants";

export interface LegacyContext {
	kittyProtocolActive: boolean;
}

function parseLegacyAltLetter(data: string): string | undefined {
	if (data.length === 2 && data.startsWith("\u001B")) {
		const c = data.codePointAt(1);
		if (c !== undefined) {
			if (c >= 1 && c <= 26) return `ctrl+alt+${String.fromCodePoint(c + 96)}`;
			if (c >= 97 && c <= 122) return `alt+${String.fromCodePoint(c)}`;
		}
	}
	return undefined;
}

export function parseLegacyAltKey(data: string, ctx: LegacyContext): string | undefined {
	if (ctx.kittyProtocolActive) return undefined;
	if (data === "\u001B\r") return "alt+enter";
	if (data === "\u001B ") return "alt+space";
	if (data === "\u001B\x7F" || data === "\u001B\b") return "alt+backspace";
	if (data === "\u001BB") return "alt+left";
	if (data === "\u001BF") return "alt+right";
	return parseLegacyAltLetter(data);
}

function parseLegacyCtrlKey(data: string): string | undefined {
	if (data.length === 1) {
		const c = data.codePointAt(0);
		if (c !== undefined) {
			const sym = CTRL_SYMBOL_CODES[c];
			if (sym !== undefined) return sym;
			if (c >= 1 && c <= 26) return `ctrl+${String.fromCodePoint(c + 96)}`;
			if (c >= 32 && c <= 126) return data;
		}
	}
	return undefined;
}

export function parseLegacyKey(data: string, ctx: LegacyContext): string | undefined {
	if (ctx.kittyProtocolActive && (data === "\u001B\r" || data === "\n")) return "shift+enter";
	const id = LEGACY_SEQUENCE_KEY_IDS[data];
	if (id !== undefined) return id;
	const mapped = LEGACY_SEQUENCE_MAP[data];
	if (mapped !== undefined) return mapped;
	if (data === "\r" || (ctx.kittyProtocolActive === false && data === "\n") || data === "\u001BOM") return "enter";
	const alt = parseLegacyAltKey(data, ctx);
	if (alt === undefined) return parseLegacyCtrlKey(data);
	return alt;
}
