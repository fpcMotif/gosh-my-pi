/**
 * Granular key matching functions.
 */

import {
	CODEPOINTS,
	CTRL_SYMBOL_MAP,
	LEGACY_KEY_SEQUENCES,
	LEGACY_SHIFT_SEQUENCES,
	LEGACY_CTRL_SEQUENCES,
	MODIFIERS,
	SYMBOL_KEYS,
} from "./_jskey_constants";
import type { LegacyModifierKey } from "./_jskey_constants";

export interface MatchContext {
	kittyProtocolActive: boolean;
	matchesKittySequence: (data: string, cp: number, mod: number) => boolean;
	matchesModifyOtherKeys: (data: string, cp: number, mod: number) => boolean;
	rawCtrlChar: (letter: string) => string;
}

const matchesLegacySequence = (data: string, sequences: readonly string[]): boolean => sequences.includes(data);

const matchesLegacyModifierSequence = (data: string, key: LegacyModifierKey, modifier: number): boolean => {
	if (modifier === MODIFIERS.shift) return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
	if (modifier === MODIFIERS.ctrl) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
	return false;
};

export function matchesEscapeKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier !== 0) return false;
	return data === "\u001B" || ctx.matchesKittySequence(data, CODEPOINTS.escape, 0);
}

export function matchesSpaceKey(
	data: string,
	modifier: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (ctx.kittyProtocolActive === false) {
		if (c === true && a === false && s === false && data === "\u0000") return true;
		if (a === true && c === false && s === false && data === "\u001B ") return true;
	}
	if (modifier === 0) return data === " " || ctx.matchesKittySequence(data, CODEPOINTS.space, 0);
	return ctx.matchesKittySequence(data, CODEPOINTS.space, modifier);
}

export function matchesTabKey(
	data: string,
	modifier: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (s === true && c === false && a === false)
		return data === "\u001B[Z" || ctx.matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift);
	if (modifier === 0) return data === "\t" || ctx.matchesKittySequence(data, CODEPOINTS.tab, 0);
	return ctx.matchesKittySequence(data, CODEPOINTS.tab, modifier);
}

function matchesShiftEnterInternal(data: string, ctx: MatchContext): boolean {
	if (ctx.matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift)) return true;
	if (ctx.matchesKittySequence(data, 57414, MODIFIERS.shift)) return true;
	if (ctx.matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) return true;
	return ctx.kittyProtocolActive === true && (data === "\u001B\r" || data === "\n");
}

function matchesAltEnterInternal(data: string, ctx: MatchContext): boolean {
	if (ctx.matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt)) return true;
	if (ctx.matchesKittySequence(data, 57414, MODIFIERS.alt)) return true;
	if (ctx.matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) return true;
	return ctx.kittyProtocolActive === false && data === "\u001B\r";
}

function matchesPlainEnterInternal(data: string, ctx: MatchContext): boolean {
	if (data === "\r") return true;
	if (ctx.kittyProtocolActive === false && data === "\n") return true;
	if (data === "\u001BOM") return true;
	if (ctx.matchesKittySequence(data, CODEPOINTS.enter, 0)) return true;
	return ctx.matchesKittySequence(data, 57414, 0);
}

export function matchesEnterKey(
	data: string,
	modifier: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (s === true && c === false && a === false) return matchesShiftEnterInternal(data, ctx);
	if (a === true && c === false && s === false) return matchesAltEnterInternal(data, ctx);
	if (modifier === 0) return matchesPlainEnterInternal(data, ctx);
	return ctx.matchesKittySequence(data, CODEPOINTS.enter, modifier) || ctx.matchesKittySequence(data, 57414, modifier);
}

export function matchesBackspaceKey(
	data: string,
	modifier: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (a === true && c === false && s === false) {
		if (data === "\u001B\x7F" || data === "\u001B\b") return true;
		return ctx.matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt);
	}
	if (modifier === 0)
		return data === "\x7F" || data === "\u0008" || ctx.matchesKittySequence(data, CODEPOINTS.backspace, 0);
	return (
		ctx.matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
		ctx.matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier)
	);
}

export function matchesInsertKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) || ctx.matchesKittySequence(data, -11, 0);
	if (matchesLegacyModifierSequence(data, "insert", modifier)) return true;
	return ctx.matchesKittySequence(data, -11, modifier);
}

export function matchesDeleteKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) || ctx.matchesKittySequence(data, -10, 0);
	if (matchesLegacyModifierSequence(data, "delete", modifier)) return true;
	return ctx.matchesKittySequence(data, -10, modifier);
}

export function matchesHomeKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) || ctx.matchesKittySequence(data, -14, 0);
	if (matchesLegacyModifierSequence(data, "home", modifier)) return true;
	return ctx.matchesKittySequence(data, -14, modifier);
}

export function matchesEndKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) || ctx.matchesKittySequence(data, -15, 0);
	if (matchesLegacyModifierSequence(data, "end", modifier)) return true;
	return ctx.matchesKittySequence(data, -15, modifier);
}

export function matchesPageUpKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) || ctx.matchesKittySequence(data, -12, 0);
	if (matchesLegacyModifierSequence(data, "pageUp", modifier)) return true;
	return ctx.matchesKittySequence(data, -12, modifier);
}

export function matchesPageDownKey(data: string, modifier: number, ctx: MatchContext): boolean {
	if (modifier === 0)
		return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) || ctx.matchesKittySequence(data, -13, 0);
	if (matchesLegacyModifierSequence(data, "pageDown", modifier)) return true;
	return ctx.matchesKittySequence(data, -13, modifier);
}

export function matchesFunctionalKey(data: string, key: string, modifier: number, ctx: MatchContext): boolean {
	switch (key) {
		case "insert":
			return matchesInsertKey(data, modifier, ctx);
		case "delete":
			return matchesDeleteKey(data, modifier, ctx);
		case "home":
			return matchesHomeKey(data, modifier, ctx);
		case "end":
			return matchesEndKey(data, modifier, ctx);
		case "pageup":
			return matchesPageUpKey(data, modifier, ctx);
		case "pagedown":
			return matchesPageDownKey(data, modifier, ctx);
		case "clear":
			if (modifier === 0) return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
			return matchesLegacyModifierSequence(data, "clear", modifier);
		default:
			return false;
	}
}

export function matchesAltLeftKey(data: string, ctx: MatchContext): boolean {
	if (data === "\u001B[1;3D") return true;
	if (ctx.kittyProtocolActive === false && data === "\u001BB") return true;
	if (data === "\u001Bb") return true;
	return ctx.matchesKittySequence(data, -4, MODIFIERS.alt);
}

export function matchesAltRightKey(data: string, ctx: MatchContext): boolean {
	if (data === "\u001B[1;3C") return true;
	if (ctx.kittyProtocolActive === false && data === "\u001BF") return true;
	if (data === "\u001Bf") return true;
	return ctx.matchesKittySequence(data, -3, MODIFIERS.alt);
}

export function matchesCtrlLeftKey(data: string, ctx: MatchContext): boolean {
	if (data === "\u001B[1;5D") return true;
	if (matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl)) return true;
	return ctx.matchesKittySequence(data, -4, MODIFIERS.ctrl);
}

export function matchesCtrlRightKey(data: string, ctx: MatchContext): boolean {
	if (data === "\u001B[1;5C") return true;
	if (matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl)) return true;
	return ctx.matchesKittySequence(data, -3, MODIFIERS.ctrl);
}

function matchesAltNavigationInternal(data: string, key: string, cp: number, ctx: MatchContext): boolean {
	if (key === "up") return data === "\u001Bp" || ctx.matchesKittySequence(data, cp, MODIFIERS.alt);
	if (key === "down") return data === "\u001Bn" || ctx.matchesKittySequence(data, cp, MODIFIERS.alt);
	if (key === "left") return matchesAltLeftKey(data, ctx);
	if (key === "right") return matchesAltRightKey(data, ctx);
	return false;
}

function matchesPlainNavigationInternal(data: string, key: string, cp: number, ctx: MatchContext): boolean {
	const seq = (LEGACY_KEY_SEQUENCES as Record<string, readonly string[]>)[key];
	return (seq !== undefined && matchesLegacySequence(data, seq)) || ctx.matchesKittySequence(data, cp, 0);
}

export function matchesNavigationKey(
	data: string,
	key: string,
	mod: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	const navMap: Record<string, number> = { up: -1, down: -2, left: -4, right: -3 };
	const cp = navMap[key];
	if (cp === undefined) return false;
	if (a === true && c === false && s === false) return matchesAltNavigationInternal(data, key, cp, ctx);
	if (c === true && a === false && s === false) return matchesCtrlNavigationInternal(data, key, cp, ctx);
	if (mod === 0) return matchesPlainNavigationInternal(data, key, cp, ctx);
	return matchesLegacyModifierSequence(data, key as LegacyModifierKey, mod) || ctx.matchesKittySequence(data, cp, mod);
}

function matchesCtrlNavigationInternal(data: string, key: string, cp: number, ctx: MatchContext): boolean {
	if (key === "left") return matchesCtrlLeftKey(data, ctx);
	if (key === "right") return matchesCtrlRightKey(data, ctx);
	return false;
}

export function matchesSpecialKey(
	data: string,
	key: string,
	mod: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	switch (key) {
		case "escape":
		case "esc":
			return matchesEscapeKey(data, mod, ctx);
		case "space":
			return matchesSpaceKey(data, mod, c, a, s, ctx);
		case "tab":
			return matchesTabKey(data, mod, c, a, s, ctx);
		case "enter":
		case "return":
			return matchesEnterKey(data, mod, c, a, s, ctx);
		case "backspace":
			return matchesBackspaceKey(data, mod, c, a, s, ctx);
		default:
			return false;
	}
}

function matchesCtrlLetterInternal(data: string, key: string, cp: number, isL: boolean, ctx: MatchContext): boolean {
	if (isL === false) {
		const l = CTRL_SYMBOL_MAP[key];
		if (l !== undefined && data === l) return true;
		return ctx.matchesModifyOtherKeys(data, cp, MODIFIERS.ctrl) || ctx.matchesKittySequence(data, cp, MODIFIERS.ctrl);
	}
	const r = ctx.rawCtrlChar(key);
	if (data === r) return true;
	const firstCp = data.length > 0 ? data.codePointAt(0) : undefined;
	if (firstCp !== undefined && firstCp === r.codePointAt(0)) return true;
	return ctx.matchesModifyOtherKeys(data, cp, MODIFIERS.ctrl) || ctx.matchesKittySequence(data, cp, MODIFIERS.ctrl);
}

function matchesShiftAltLetterInternal(
	data: string,
	key: string,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (c === true && a === true && s === false && ctx.kittyProtocolActive === false) {
		return data === `\u001B${ctx.rawCtrlChar(key)}`;
	}
	if (a === true && c === false && s === false && ctx.kittyProtocolActive === false && data === `\u001B${key}`) {
		return true;
	}
	return false;
}

function matchesShiftCtrlLetterInternal(
	data: string,
	cp: number,
	c: boolean,
	s: boolean,
	a: boolean,
	ctx: MatchContext,
): boolean {
	if (c === true && s === true && a === false)
		return ctx.matchesKittySequence(data, cp, MODIFIERS.shift + MODIFIERS.ctrl);
	if (s === true && c === false && a === false) {
		if (data.length === 1 && data.toUpperCase() === data && data.toLowerCase() !== data) return true;
		return ctx.matchesKittySequence(data, cp, MODIFIERS.shift);
	}
	return false;
}

function matchesOtherLetterInternal(data: string, cp: number, mod: number, ctx: MatchContext): boolean {
	if (mod === 0) return data === String.fromCodePoint(cp) || ctx.matchesKittySequence(data, cp, 0);
	return ctx.matchesKittySequence(data, cp, mod);
}

function isLetterOrSymbol(key: string): boolean {
	if (key.length !== 1) return false;
	return (key >= "a" && key <= "z") || SYMBOL_KEYS.has(key);
}

export function matchesLetterOrSymbolKey(
	data: string,
	key: string,
	mod: number,
	c: boolean,
	a: boolean,
	s: boolean,
	ctx: MatchContext,
): boolean {
	if (isLetterOrSymbol(key) === false) return false;
	const cp = key.codePointAt(0) ?? -1;
	if (cp === -1) return false;
	const isL = key >= "a" && key <= "z";
	if (isL === true && matchesShiftAltLetterInternal(data, key, c, a, s, ctx)) return true;
	if (c === true && s === false && a === false) return matchesCtrlLetterInternal(data, key, cp, isL, ctx);
	if (matchesShiftCtrlLetterInternal(data, cp, c, s, a, ctx)) return true;
	return matchesOtherLetterInternal(data, cp, mod, ctx);
}
