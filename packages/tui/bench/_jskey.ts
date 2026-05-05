/**
 * Keyboard input handling for terminal applications.
 */

import { KITTY_KEY_NAME_MAP, LOCK_MASK, MODIFIERS, SYMBOL_KEYS } from "./_jskey_constants";
import type { KeyId } from "./_jskey_constants";
import type { MatchContext } from "./_jskey_matchers";
import {
	matchesFunctionalKey,
	matchesNavigationKey,
	matchesSpecialKey,
	matchesLetterOrSymbolKey,
} from "./_jskey_matchers";
import { parseLegacyKey } from "./_jskey_legacy";
import type { LegacyContext } from "./_jskey_legacy";

let _kittyProtocolActive = false;

export function setKittyProtocolActive(active: boolean): void {
	_kittyProtocolActive = active;
}

export function isKittyProtocolActive(): boolean {
	return _kittyProtocolActive;
}

export type KeyEventType = "press" | "repeat" | "release";
interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number;
	baseLayoutKey?: number;
	modifier: number;
	eventType: KeyEventType;
}

export function isKeyRelease(data: string): boolean {
	if (data.includes("\u001B[200~")) return false;
	const parts = [":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F"];
	return parts.some(p => data.includes(p));
}

export function isKeyRepeat(data: string): boolean {
	if (data.includes("\u001B[200~")) return false;
	const parts = [":2u", ":2~", ":2A", ":2B", ":2C", ":2D", ":2H", ":2F"];
	return parts.some(p => data.includes(p));
}

function parseEventType(str: string | undefined): KeyEventType {
	if (str === "2") return "repeat";
	if (str === "3") return "release";
	return "press";
}

export function parseKittySequence(data: string): ParsedKittySequence | null {
	const csiUMatch = data.match(/\u001B\[(\d+)(?::(\d*))?(?::(\d+))?;(\d+)(?::(\d+))?u/);
	if (csiUMatch) {
		return {
			codepoint: Number.parseInt(csiUMatch[1], 10),
			shiftedKey: csiUMatch[2] ? Number.parseInt(csiUMatch[2], 10) : undefined,
			baseLayoutKey: csiUMatch[3] ? Number.parseInt(csiUMatch[3], 10) : undefined,
			modifier: Number.parseInt(csiUMatch[4], 10) - 1,
			eventType: parseEventType(csiUMatch[5]),
		};
	}
	const arrowMatch = data.match(/\u001B\[1;(\d+)(?::(\d+))?([ABCD])/);
	if (arrowMatch) {
		const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		return {
			codepoint: arrowCodes[arrowMatch[3]],
			modifier: Number.parseInt(arrowMatch[1], 10) - 1,
			eventType: parseEventType(arrowMatch[2]),
		};
	}
	const funcMatch = data.match(/\u001B\[(\d+);(\d+)(?::(\d+))?~/);
	if (funcMatch) {
		const funcCodes: Record<number, number> = { 2: -11, 3: -10, 5: -12, 6: -13, 7: -14, 8: -15 };
		const codepoint = funcCodes[Number.parseInt(funcMatch[1], 10)];
		if (codepoint !== undefined) {
			return { codepoint, modifier: Number.parseInt(funcMatch[2], 10) - 1, eventType: parseEventType(funcMatch[3]) };
		}
	}
	const homeEndMatch = data.match(/\u001B\[1;(\d+)(?::(\d+))?([HF])/);
	if (homeEndMatch) {
		return {
			codepoint: homeEndMatch[3] === "H" ? -14 : -15,
			modifier: Number.parseInt(homeEndMatch[1], 10) - 1,
			eventType: parseEventType(homeEndMatch[2]),
		};
	}
	return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const p = parseKittySequence(data);
	if (!p) return false;
	if ((p.modifier & ~LOCK_MASK) !== (expectedModifier & ~LOCK_MASK)) return false;
	return p.codepoint === expectedCodepoint || (p.baseLayoutKey !== undefined && p.baseLayoutKey === expectedCodepoint);
}

function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
	const m = data.match(/\u001B\[27;(\d+);(\d+)~/);
	if (!m) return false;
	return Number.parseInt(m[2], 10) === expectedKeycode && Number.parseInt(m[1], 10) - 1 === expectedModifier;
}

function rawCtrlChar(letter: string): string {
	const code = letter.toLowerCase().codePointAt(0);
	return code === undefined ? "" : String.fromCodePoint(code - 96);
}

const MATCH_CONTEXT: MatchContext = {
	get kittyProtocolActive() {
		return _kittyProtocolActive;
	},
	matchesKittySequence,
	matchesModifyOtherKeys,
	rawCtrlChar,
};

const LEGACY_CONTEXT: LegacyContext = {
	get kittyProtocolActive() {
		return _kittyProtocolActive;
	},
};

const PARSED_KEY_ID_CACHE = new Map<string, { key: string; ctrl: boolean; shift: boolean; alt: boolean }>();

function parseKeyId(keyId: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean } | null {
	const norm = keyId.toLowerCase();
	const cached = PARSED_KEY_ID_CACHE.get(norm);
	if (cached) return cached;
	const parts = norm.split("+");
	const key = parts.at(-1);
	if (key === undefined || key === "") return null;
	const res = { key, ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") };
	PARSED_KEY_ID_CACHE.set(norm, res);
	return res;
}

function resolveKittyKeyName(cp: number): string | undefined {
	const mapped = KITTY_KEY_NAME_MAP[cp];
	if (mapped !== undefined) return mapped;
	if (cp >= 97 && cp <= 122) return String.fromCodePoint(cp);
	const char = String.fromCodePoint(cp);
	return SYMBOL_KEYS.has(char) ? char : undefined;
}

export function matchesKey(data: string, keyId: KeyId): boolean {
	const p = parseKeyId(keyId);
	if (p === null) return false;
	const { key, ctrl, shift, alt } = p;
	let mod = 0;
	if (shift) mod |= MODIFIERS.shift;
	if (alt) mod |= MODIFIERS.alt;
	if (ctrl) mod |= MODIFIERS.ctrl;
	if (matchesSpecialKey(data, key, mod, ctrl, alt, shift, MATCH_CONTEXT)) return true;
	if (matchesFunctionalKey(data, key, mod, MATCH_CONTEXT)) return true;
	if (matchesNavigationKey(data, key, mod, ctrl, alt, shift, MATCH_CONTEXT)) return true;
	if (key.startsWith("f") && mod === 0 && parseLegacyKey(data, LEGACY_CONTEXT) === key) return true;
	return matchesLetterOrSymbolKey(data, key, mod, ctrl, alt, shift, MATCH_CONTEXT);
}

export function parseKey(data: string): string | undefined {
	const k = parseKittySequence(data);
	if (k) {
		const mods: string[] = [];
		const eff = k.modifier & ~LOCK_MASK;
		if (eff & MODIFIERS.shift) mods.push("shift");
		if (eff & MODIFIERS.ctrl) mods.push("ctrl");
		if (eff & MODIFIERS.alt) mods.push("alt");
		const name = resolveKittyKeyName(k.baseLayoutKey ?? k.codepoint);
		if (name !== undefined && name !== "") return mods.length > 0 ? `${mods.join("+")}+${name}` : name;
	}
	return parseLegacyKey(data, LEGACY_CONTEXT);
}
