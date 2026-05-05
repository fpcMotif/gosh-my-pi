/**
 * Constants and types for keyboard input handling.
 */

export type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";
export type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";
export type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";
export type BaseKey = Letter | SymbolKey | SpecialKey;

export type KeyId =
	| BaseKey
	| `ctrl+${BaseKey}`
	| `shift+${BaseKey}`
	| `alt+${BaseKey}`
	| `ctrl+shift+${BaseKey}`
	| `shift+ctrl+${BaseKey}`
	| `ctrl+alt+${BaseKey}`
	| `alt+ctrl+${BaseKey}`
	| `shift+alt+${BaseKey}`
	| `alt+shift+${BaseKey}`
	| `ctrl+shift+alt+${BaseKey}`
	| `ctrl+alt+shift+${BaseKey}`
	| `shift+ctrl+alt+${BaseKey}`
	| `shift+alt+ctrl+${BaseKey}`
	| `alt+ctrl+shift+${BaseKey}`
	| `alt+shift+ctrl+${BaseKey}`;

export const Key = {
	escape: "escape" as const,
	esc: "esc" as const,
	enter: "enter" as const,
	return: "return" as const,
	tab: "tab" as const,
	space: "space" as const,
	backspace: "backspace" as const,
	delete: "delete" as const,
	insert: "insert" as const,
	clear: "clear" as const,
	home: "home" as const,
	end: "end" as const,
	pageUp: "pageUp" as const,
	pageDown: "pageDown" as const,
	up: "up" as const,
	down: "down" as const,
	left: "left" as const,
	right: "right" as const,
	f1: "f1" as const,
	f2: "f2" as const,
	f3: "f3" as const,
	f4: "f4" as const,
	f5: "f5" as const,
	f6: "f6" as const,
	f7: "f7" as const,
	f8: "f8" as const,
	f9: "f9" as const,
	f10: "f10" as const,
	f11: "f11" as const,
	f12: "f12" as const,
	backtick: "`" as const,
	hyphen: "-" as const,
	equals: "=" as const,
	leftbracket: "[" as const,
	rightbracket: "]" as const,
	backslash: "\\" as const,
	semicolon: ";" as const,
	quote: "'" as const,
	comma: "," as const,
	period: "." as const,
	slash: "/" as const,
	exclamation: "!" as const,
	at: "@" as const,
	hash: "#" as const,
	dollar: "$" as const,
	percent: "%" as const,
	caret: "^" as const,
	ampersand: "&" as const,
	asterisk: "*" as const,
	leftparen: "(" as const,
	rightparen: ")" as const,
	underscore: "_" as const,
	plus: "+" as const,
	pipe: "|" as const,
	tilde: "~" as const,
	leftbrace: "{" as const,
	rightbrace: "}" as const,
	colon: ":" as const,
	lessthan: "<" as const,
	greaterthan: ">" as const,
	question: "?" as const,
	ctrl: <K extends BaseKey>(key: K): `ctrl+${K}` => `ctrl+${key}`,
	shift: <K extends BaseKey>(key: K): `shift+${K}` => `shift+${key}`,
	alt: <K extends BaseKey>(key: K): `alt+${K}` => `alt+${key}`,
	ctrlShift: <K extends BaseKey>(key: K): `ctrl+shift+${K}` => `ctrl+shift+${key}`,
	shiftCtrl: <K extends BaseKey>(key: K): `shift+ctrl+${K}` => `shift+ctrl+${key}`,
	ctrlAlt: <K extends BaseKey>(key: K): `ctrl+alt+${K}` => `ctrl+alt+${key}`,
	altCtrl: <K extends BaseKey>(key: K): `alt+ctrl+${K}` => `alt+ctrl+${key}`,
	shiftAlt: <K extends BaseKey>(key: K): `shift+alt+${K}` => `shift+alt+${key}`,
	altShift: <K extends BaseKey>(key: K): `alt+shift+${K}` => `alt+shift+${key}`,
	ctrlShiftAlt: <K extends BaseKey>(key: K): `ctrl+shift+alt+${K}` => `ctrl+shift+alt+${key}`,
} as const;

export const SYMBOL_KEYS = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);

export const CTRL_SYMBOL_MAP: Record<string, string> = {
	"@": "\u0000",
	"[": "\u001B",
	"\\": "\u001C",
	"]": "\u001D",
	"^": "\u001E",
	_: "\u001F",
	"-": "\u001F",
} as const;

export const CTRL_SYMBOL_CODES: Record<number, KeyId> = {
	28: "ctrl+\\",
	29: "ctrl+]",
	30: "ctrl+^",
	31: "ctrl+_",
} as const;

export const MODIFIERS = { shift: 1, alt: 2, ctrl: 4 } as const;

export const LOCK_MASK = 64 + 128;

export const CODEPOINTS = { escape: 27, tab: 9, enter: 13, space: 32, backspace: 127, kpEnter: 57414 } as const;

export const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 } as const;

export const FUNCTIONAL_CODEPOINTS = {
	delete: -10,
	insert: -11,
	pageUp: -12,
	pageDown: -13,
	home: -14,
	end: -15,
} as const;

export const LEGACY_KEY_SEQUENCES = {
	up: ["\u001B[A", "\u001BOA"],
	down: ["\u001B[B", "\u001BOB"],
	right: ["\u001B[C", "\u001BOC"],
	left: ["\u001B[D", "\u001BOD"],
	home: ["\u001B[H", "\u001BOH", "\u001B[1~", "\u001B[7~"],
	end: ["\u001B[F", "\u001BOF", "\u001B[4~", "\u001B[8~"],
	insert: ["\u001B[2~"],
	delete: ["\u001B[3~"],
	pageUp: ["\u001B[5~", "\u001B[[5~"],
	pageDown: ["\u001B[6~", "\u001B[[6~"],
	clear: ["\u001B[E", "\u001BOE"],
	f1: ["\u001BOP", "\u001B[11~", "\u001B[[A"],
	f2: ["\u001BOQ", "\u001B[12~", "\u001B[[B"],
	f3: ["\u001BOR", "\u001B[13~", "\u001B[[C"],
	f4: ["\u001BOS", "\u001B[14~", "\u001B[[D"],
	f5: ["\u001B[15~", "\u001B[[E"],
	f6: ["\u001B[17~"],
	f7: ["\u001B[18~"],
	f8: ["\u001B[19~"],
	f9: ["\u001B[20~"],
	f10: ["\u001B[21~"],
	f11: ["\u001B[23~"],
	f12: ["\u001B[24~"],
} as const;

export const LEGACY_SHIFT_SEQUENCES = {
	up: ["\u001B[a"],
	down: ["\u001B[b"],
	right: ["\u001B[c"],
	left: ["\u001B[d"],
	clear: ["\u001B[e"],
	insert: ["\u001B[2$"],
	delete: ["\u001B[3$"],
	pageUp: ["\u001B[5$"],
	pageDown: ["\u001B[6$"],
	home: ["\u001B[7$"],
	end: ["\u001B[8$"],
} as const;

export const LEGACY_CTRL_SEQUENCES = {
	up: ["\u001BOa"],
	down: ["\u001BOb"],
	right: ["\u001BOc"],
	left: ["\u001BOd"],
	clear: ["\u001BOe"],
	insert: ["\u001B[2^"],
	delete: ["\u001B[3^"],
	pageUp: ["\u001B[5^"],
	pageDown: ["\u001B[6^"],
	home: ["\u001B[7^"],
	end: ["\u001B[8^"],
} as const;

export const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
	"\u001BOA": "up",
	"\u001BOB": "down",
	"\u001BOC": "right",
	"\u001BOD": "left",
	"\u001BOH": "home",
	"\u001BOF": "end",
	"\u001B[E": "clear",
	"\u001BOE": "clear",
	"\u001BOe": "ctrl+clear",
	"\u001B[e": "shift+clear",
	"\u001B[2~": "insert",
	"\u001B[2$": "shift+insert",
	"\u001B[2^": "ctrl+insert",
	"\u001B[3$": "shift+delete",
	"\u001B[3^": "ctrl+delete",
	"\u001B[[5~": "pageUp",
	"\u001B[[6~": "pageDown",
	"\u001B[a": "shift+up",
	"\u001B[b": "shift+down",
	"\u001B[c": "shift+right",
	"\u001B[d": "shift+left",
	"\u001BOa": "ctrl+up",
	"\u001BOb": "ctrl+down",
	"\u001BOc": "ctrl+right",
	"\u001BOd": "ctrl+left",
	"\u001B[5$": "shift+pageUp",
	"\u001B[6$": "shift+pageDown",
	"\u001B[7$": "shift+home",
	"\u001B[8$": "shift+end",
	"\u001B[5^": "ctrl+pageUp",
	"\u001B[6^": "ctrl+pageDown",
	"\u001B[7^": "ctrl+home",
	"\u001B[8^": "ctrl+end",
	"\u001BOP": "f1",
	"\u001BOQ": "f2",
	"\u001BOR": "f3",
	"\u001BOS": "f4",
	"\u001B[11~": "f1",
	"\u001B[12~": "f2",
	"\u001B[13~": "f3",
	"\u001B[14~": "f4",
	"\u001B[[A": "f1",
	"\u001B[[B": "f2",
	"\u001B[[C": "f3",
	"\u001B[[D": "f4",
	"\u001B[[E": "f5",
	"\u001B[15~": "f5",
	"\u001B[17~": "f6",
	"\u001B[18~": "f7",
	"\u001B[19~": "f8",
	"\u001B[20~": "f9",
	"\u001B[21~": "f10",
	"\u001B[23~": "f11",
	"\u001B[24~": "f12",
	"\u001Bb": "alt+left",
	"\u001Bf": "alt+right",
	"\u001Bp": "alt+up",
	"\u001Bn": "alt+down",
} as const;

export type LegacyModifierKey = keyof typeof LEGACY_SHIFT_SEQUENCES;

export const KITTY_KEY_NAME_MAP: Record<number, string> = {
	[CODEPOINTS.escape]: "escape",
	[CODEPOINTS.tab]: "tab",
	[CODEPOINTS.enter]: "enter",
	[CODEPOINTS.kpEnter]: "enter",
	[CODEPOINTS.space]: "space",
	[CODEPOINTS.backspace]: "backspace",
	[FUNCTIONAL_CODEPOINTS.delete]: "delete",
	[FUNCTIONAL_CODEPOINTS.insert]: "insert",
	[FUNCTIONAL_CODEPOINTS.home]: "home",
	[FUNCTIONAL_CODEPOINTS.end]: "end",
	[FUNCTIONAL_CODEPOINTS.pageUp]: "pageUp",
	[FUNCTIONAL_CODEPOINTS.pageDown]: "pageDown",
	[ARROW_CODEPOINTS.up]: "up",
	[ARROW_CODEPOINTS.down]: "down",
	[ARROW_CODEPOINTS.left]: "left",
	[ARROW_CODEPOINTS.right]: "right",
};

export const LEGACY_SEQUENCE_MAP: Record<string, string> = {
	"\u001B": "escape",
	"\t": "tab",
	"\u0000": "ctrl+space",
	" ": "space",
	"\u007F": "backspace",
	"\u0008": "backspace",
	"\u001B[Z": "shift+tab",
	"\u001B[A": "up",
	"\u001B[B": "down",
	"\u001B[C": "right",
	"\u001B[D": "left",
	"\u001B[H": "home",
	"\u001BOH": "home",
	"\u001B[F": "end",
	"\u001BOF": "end",
	"\u001B[3~": "delete",
	"\u001B[5~": "pageUp",
	"\u001B[6~": "pageDown",
};
