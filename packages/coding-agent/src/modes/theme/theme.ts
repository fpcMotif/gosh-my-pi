import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import {
	detectMacOSAppearance,
	MacAppearanceObserver,
	type HighlightColors as NativeHighlightColors,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
} from "@oh-my-pi/pi-natives";
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import { adjustHsv, getCustomThemesDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";
// Embed theme JSON files at build time
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };
import { resolveMermaidAscii } from "./mermaid-cache";
import { SPINNER_FRAMES, SYMBOL_PRESETS, type SpinnerType, type SymbolMap } from "./symbols";

export { getLanguageFromPath } from "../../utils/lang-from-path";
export type { SpinnerType } from "./symbols";

// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * All available symbol keys organized by category.
 */
export type SymbolKey =
	// Status Indicators
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree Connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Sharp
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	// Separators
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	// Icons
	| "icon.model"
	| "icon.plan"
	| "icon.loop"
	| "icon.folder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.time"
	| "icon.pi"
	| "icon.agents"
	| "icon.cache"
	| "icon.input"
	| "icon.output"
	| "icon.host"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.auto"
	| "icon.fast"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	// STT
	| "icon.mic"
	// Thinking Levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	// Text Formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown-specific
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	// Language/file type icons
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary"
	// Settings tab icons
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.context"
	| "tab.editing"
	| "tab.tools"
	| "tab.tasks"
	| "tab.providers"
	// Vivid layout glyphs
	| "rail.thin"
	| "rail.thick"
	| "prompt.sigil"
	| "badge.sep"
	| "tool.statusOk"
	| "tool.statusErr"
	| "tool.statusRun";

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

// Use Type.Union here (not StringEnum) because TypeCompiler doesn't support Type.Unsafe
const SymbolPresetSchema = Type.Union([Type.Literal("unicode"), Type.Literal("nerd"), Type.Literal("ascii")]);

const SymbolsSchema = Type.Optional(
	Type.Object({
		preset: Type.Optional(SymbolPresetSchema),
		overrides: Type.Optional(Type.Record(Type.String(), Type.String())),
	}),
);

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	layout: Type.Optional(Type.Union([Type.Literal("classic"), Type.Literal("vivid")])),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (10 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 colors)
		selectedBg: ColorValueSchema,
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
		// Python Mode (1 color)
		pythonMode: ColorValueSchema,
		// Footer Status Line
		statusLineBg: ColorValueSchema,
		statusLineSep: ColorValueSchema,
		statusLineModel: ColorValueSchema,
		statusLinePath: ColorValueSchema,
		statusLineGitClean: ColorValueSchema,
		statusLineGitDirty: ColorValueSchema,
		statusLineContext: ColorValueSchema,
		statusLineSpend: ColorValueSchema,
		statusLineStaged: ColorValueSchema,
		statusLineDirty: ColorValueSchema,
		statusLineUntracked: ColorValueSchema,
		statusLineOutput: ColorValueSchema,
		statusLineCost: ColorValueSchema,
		statusLineSubagents: ColorValueSchema,
		// Vivid layout tokens (optional — used only when theme.layout === "vivid")
		borderRailUser: Type.Optional(ColorValueSchema),
		borderRailAssistant: Type.Optional(ColorValueSchema),
		borderRailTool: Type.Optional(ColorValueSchema),
		borderRailFocused: Type.Optional(ColorValueSchema),
		promptSigil: Type.Optional(ColorValueSchema),
		gradFrom: Type.Optional(ColorValueSchema),
		gradTo: Type.Optional(ColorValueSchema),
		badgeOkFg: Type.Optional(ColorValueSchema),
		badgeOkBg: Type.Optional(ColorValueSchema),
		badgeErrFg: Type.Optional(ColorValueSchema),
		badgeErrBg: Type.Optional(ColorValueSchema),
		badgeWarnFg: Type.Optional(ColorValueSchema),
		badgeWarnBg: Type.Optional(ColorValueSchema),
		badgeInfoFg: Type.Optional(ColorValueSchema),
		badgeInfoBg: Type.Optional(ColorValueSchema),
		badgeHeyFg: Type.Optional(ColorValueSchema),
		badgeHeyBg: Type.Optional(ColorValueSchema),
		diffInsertFg: Type.Optional(ColorValueSchema),
		diffInsertBg: Type.Optional(ColorValueSchema),
		diffDeleteFg: Type.Optional(ColorValueSchema),
		diffDeleteBg: Type.Optional(ColorValueSchema),
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
	symbols: SymbolsSchema,
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TypeBox CJS/ESM type mismatch
const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema as any);

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode"
	| "pythonMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents"
	// Vivid layout fg tokens (resolved with fallbacks if theme.layout !== "vivid")
	| "borderRailUser"
	| "borderRailAssistant"
	| "borderRailTool"
	| "borderRailFocused"
	| "promptSigil"
	| "gradFrom"
	| "gradTo"
	| "badgeOkFg"
	| "badgeErrFg"
	| "badgeWarnFg"
	| "badgeInfoFg"
	| "badgeHeyFg"
	| "diffInsertFg"
	| "diffDeleteFg";

/** Set of all valid ThemeColor string values for runtime validation */
const THEME_COLOR_RECORD = {
	accent: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	bashMode: true,
	pythonMode: true,
	statusLineSep: true,
	statusLineModel: true,
	statusLinePath: true,
	statusLineGitClean: true,
	statusLineGitDirty: true,
	statusLineContext: true,
	statusLineSpend: true,
	statusLineStaged: true,
	statusLineDirty: true,
	statusLineUntracked: true,
	statusLineOutput: true,
	statusLineCost: true,
	statusLineSubagents: true,
	borderRailUser: true,
	borderRailAssistant: true,
	borderRailTool: true,
	borderRailFocused: true,
	promptSigil: true,
	gradFrom: true,
	gradTo: true,
	badgeOkFg: true,
	badgeErrFg: true,
	badgeWarnFg: true,
	badgeInfoFg: true,
	badgeHeyFg: true,
	diffInsertFg: true,
	diffDeleteFg: true,
} satisfies Record<ThemeColor, true>;

const VALID_THEME_COLORS: ReadonlySet<string> = new Set(Object.keys(THEME_COLOR_RECORD));

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg"
	// Vivid layout bg tokens (optional; fallbacks resolve in createTheme)
	| "badgeOkBg"
	| "badgeErrBg"
	| "badgeWarnBg"
	| "badgeInfoBg"
	| "badgeHeyBg"
	| "diffInsertBg"
	| "diffDeleteBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = Bun.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (Bun.env.WT_SESSION !== null && Bun.env.WT_SESSION !== undefined && Bun.env.WT_SESSION !== "") {
		return "truecolor";
	}
	const term = Bun.env.TERM ?? "";
	// Only fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

function colorToAnsi(color: string, mode: ColorMode): string {
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const ansi = Bun.color(color, format);
	if (ansi === null) {
		throw new Error(`Invalid color value: ${color}`);
	}
	return ansi;
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${String(color)}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	const ansi = colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	powershell: "lang.shell",
	just: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	astro: "lang.html",
	vue: "lang.html",
	svelte: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};

export type ThemeLayout = "classic" | "vivid";

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		private readonly mode: ColorMode,
		private readonly symbolPreset: SymbolPreset,
		symbolOverrides: Partial<Record<SymbolKey, string>>,
		readonly layout: ThemeLayout = "classic",
	) {
		this.#fgColors = {} as Record<ThemeColor, string>;
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.#fgColors[key] = fgAnsi(value, mode);
		}
		this.#bgColors = {} as Record<ThemeBg, string>;
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.#bgColors[key] = bgAnsi(value, mode);
		}
		// Build symbol map from preset + overrides
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.#symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.#symbols) {
				this.#symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.#symbols) });
			}
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel | Effort): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	getPythonModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("pythonMode", str);
	}

	// ============================================================================
	// Symbol Methods
	// ============================================================================

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		return this.fg(color, this.#symbols[key]);
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// ============================================================================
	// Symbol Category Accessors
	// ============================================================================

	get status() {
		return {
			success: this.#symbols["status.success"],
			error: this.#symbols["status.error"],
			warning: this.#symbols["status.warning"],
			info: this.#symbols["status.info"],
			pending: this.#symbols["status.pending"],
			disabled: this.#symbols["status.disabled"],
			enabled: this.#symbols["status.enabled"],
			running: this.#symbols["status.running"],
			shadowed: this.#symbols["status.shadowed"],
			aborted: this.#symbols["status.aborted"],
		};
	}

	get nav() {
		return {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
		};
	}

	get tree() {
		return {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
		};
	}

	get boxSharp() {
		return {
			topLeft: this.#symbols["boxSharp.topLeft"],
			topRight: this.#symbols["boxSharp.topRight"],
			bottomLeft: this.#symbols["boxSharp.bottomLeft"],
			bottomRight: this.#symbols["boxSharp.bottomRight"],
			horizontal: this.#symbols["boxSharp.horizontal"],
			vertical: this.#symbols["boxSharp.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get sep() {
		return {
			powerline: this.#symbols["sep.powerline"],
			powerlineThin: this.#symbols["sep.powerlineThin"],
			powerlineLeft: this.#symbols["sep.powerlineLeft"],
			powerlineRight: this.#symbols["sep.powerlineRight"],
			powerlineThinLeft: this.#symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.#symbols["sep.powerlineThinRight"],
			block: this.#symbols["sep.block"],
			space: this.#symbols["sep.space"],
			asciiLeft: this.#symbols["sep.asciiLeft"],
			asciiRight: this.#symbols["sep.asciiRight"],
			dot: this.#symbols["sep.dot"],
			slash: this.#symbols["sep.slash"],
			pipe: this.#symbols["sep.pipe"],
		};
	}

	get icon() {
		return {
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			loop: this.#symbols["icon.loop"],
			folder: this.#symbols["icon.folder"],
			file: this.#symbols["icon.file"],
			git: this.#symbols["icon.git"],
			branch: this.#symbols["icon.branch"],
			pr: this.#symbols["icon.pr"],
			tokens: this.#symbols["icon.tokens"],
			context: this.#symbols["icon.context"],
			cost: this.#symbols["icon.cost"],
			time: this.#symbols["icon.time"],
			pi: this.#symbols["icon.pi"],
			agents: this.#symbols["icon.agents"],
			cache: this.#symbols["icon.cache"],
			input: this.#symbols["icon.input"],
			output: this.#symbols["icon.output"],
			host: this.#symbols["icon.host"],
			session: this.#symbols["icon.session"],
			package: this.#symbols["icon.package"],
			warning: this.#symbols["icon.warning"],
			rewind: this.#symbols["icon.rewind"],
			auto: this.#symbols["icon.auto"],
			fast: this.#symbols["icon.fast"],
			extensionSkill: this.#symbols["icon.extensionSkill"],
			extensionTool: this.#symbols["icon.extensionTool"],
			extensionSlashCommand: this.#symbols["icon.extensionSlashCommand"],
			extensionMcp: this.#symbols["icon.extensionMcp"],
			extensionRule: this.#symbols["icon.extensionRule"],
			extensionHook: this.#symbols["icon.extensionHook"],
			extensionPrompt: this.#symbols["icon.extensionPrompt"],
			extensionContextFile: this.#symbols["icon.extensionContextFile"],
			extensionInstruction: this.#symbols["icon.extensionInstruction"],
			mic: this.#symbols["icon.mic"],
		};
	}

	get thinking() {
		return {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
		};
	}

	get checkbox() {
		return {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
		};
	}

	get format() {
		return {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
		};
	}

	/**
	 * Default spinner frames (status spinner).
	 */
	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	/**
	 * Get spinner frames by type.
	 */
	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return SPINNER_FRAMES[this.symbolPreset][type];
	}

	/**
	 * Get language icon for a language name.
	 * Maps common language names to their corresponding symbol keys.
	 */
	getLangIcon(lang: string | undefined): string {
		if (lang === null || lang === undefined || lang === "") return this.#symbols["lang.default"];
		const normalized = lang.toLowerCase();
		const key = langMap[normalized];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}

export async function getAvailableThemes(): Promise<string[]> {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const result: ThemeInfo[] = [];

	// Built-in themes (embedded, no file path)
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

	// Custom themes
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some(themeInfo => themeInfo.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadThemeJson(name: string): Promise<ThemeJson> {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	let content: string;
	try {
		content = await Bun.file(themePath).text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Theme not found: ${name}`);
		throw error;
	}
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${String(error)}`);
	}
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors: string[] = [];
		const otherErrors: string[] = [];

		for (const e of errors) {
			// Check for missing required color properties
			const match = e.path.match(/^\/colors\/(\w+)$/);
			if (match && e.message.includes("Required")) {
				missingColors.push(match[1]);
			} else {
				otherErrors.push(`  - ${e.path}: ${e.message}`);
			}
		}

		let errorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			errorMessage += `\nMissing required color tokens:\n`;
			errorMessage += missingColors.map(c => `  - ${c}`).join("\n");
			errorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			errorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}
	return json as ThemeJson;
}

interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

/** HSV adjustment to shift green toward blue for colorblind mode (red-green colorblindness) */
const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

const BG_COLOR_KEYS: Set<string> = new Set([
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"statusLineBg",
	"badgeOkBg",
	"badgeErrBg",
	"badgeWarnBg",
	"badgeInfoBg",
	"badgeHeyBg",
	"diffInsertBg",
	"diffDeleteBg",
]);

const VIVID_FG_FALLBACKS: Record<string, ThemeColor> = {
	borderRailUser: "customMessageLabel",
	borderRailAssistant: "accent",
	borderRailTool: "borderAccent",
	borderRailFocused: "accent",
	promptSigil: "success",
	gradFrom: "accent",
	gradTo: "borderAccent",
	badgeOkFg: "success",
	badgeErrFg: "error",
	badgeWarnFg: "warning",
	badgeInfoFg: "accent",
	badgeHeyFg: "customMessageLabel",
	diffInsertFg: "toolDiffAdded",
	diffDeleteFg: "toolDiffRemoved",
};
const VIVID_BG_FALLBACKS: Record<string, ThemeBg> = {
	badgeOkBg: "toolSuccessBg",
	badgeErrBg: "toolErrorBg",
	badgeWarnBg: "toolPendingBg",
	badgeInfoBg: "toolPendingBg",
	badgeHeyBg: "selectedBg",
	diffInsertBg: "toolSuccessBg",
	diffDeleteBg: "toolErrorBg",
};

function classifyThemeColors(resolvedColors: Record<string, string | number>): {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
} {
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (BG_COLOR_KEYS.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return { fgColors, bgColors };
}

function applyVividFallbacks(
	fgColors: Record<ThemeColor, string | number>,
	bgColors: Record<ThemeBg, string | number>,
): void {
	for (const [tokenKey, fallbackKey] of Object.entries(VIVID_FG_FALLBACKS)) {
		if (fgColors[tokenKey as ThemeColor] === undefined) {
			fgColors[tokenKey as ThemeColor] = fgColors[fallbackKey];
		}
	}
	for (const [tokenKey, fallbackKey] of Object.entries(VIVID_BG_FALLBACKS)) {
		if (bgColors[tokenKey as ThemeBg] === undefined) {
			bgColors[tokenKey as ThemeBg] = bgColors[fallbackKey];
		}
	}
}

function createTheme(themeJson: ThemeJson, options: CreateThemeOptions = {}): Theme {
	const { mode, symbolPresetOverride, colorBlindMode } = options;
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);

	if (colorBlindMode === true) {
		const added = resolvedColors.toolDiffAdded;
		if (typeof added === "string" && added.startsWith("#")) {
			resolvedColors.toolDiffAdded = adjustHsv(added, COLORBLIND_ADJUSTMENT);
		}
	}

	const { fgColors, bgColors } = classifyThemeColors(resolvedColors);

	// Apply fallbacks for vivid-layout tokens missing from non-vivid themes.
	// This keeps the system robust: any theme can still be queried for these
	// keys, and components branching on theme.layout never see undefined.
	applyVividFallbacks(fgColors, bgColors);

	// Extract symbol configuration - settings override takes precedence over theme
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	const layout: ThemeLayout = themeJson.layout ?? "classic";
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides, layout);
}

async function loadTheme(name: string, options: CreateThemeOptions = {}): Promise<Theme> {
	const themeJson = await loadThemeJson(name);
	return createTheme(themeJson, options);
}

export async function getThemeByName(name: string): Promise<Theme | undefined> {
	try {
		return await loadTheme(name);
	} catch {
		return undefined;
	}
}

/** Appearance detected via OSC 11 background color query, or undefined if not yet available. */
var terminalReportedAppearance: "dark" | "light" | undefined;

/** Appearance reported by the macOS fallback observer, or undefined if not yet available. */
var macOSReportedAppearance: "dark" | "light" | undefined;

function shouldUseMacOSAppearanceFallback(): boolean {
	// Zellij currently breaks OSC 11 passthrough on macOS, so terminal-derived
	// appearance cannot be trusted there. Fall back to host macOS appearance
	// without letting it override valid terminal signals elsewhere.
	return (
		process.platform === "darwin" &&
		!(Bun.env.ZELLIJ === null || Bun.env.ZELLIJ === undefined || Bun.env.ZELLIJ === "")
	);
}

function detectTerminalBackground(): "dark" | "light" {
	// Tier 1: terminal-reported appearance from OSC 11 luminance.
	if (!shouldUseMacOSAppearanceFallback() && terminalReportedAppearance) {
		return terminalReportedAppearance;
	}

	// Tier 2: COLORFGBG env var (static at process start, but still terminal-derived).
	const colorfgbg = Bun.env.COLORFGBG ?? "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
			const bg = parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) return bg < 8 ? "dark" : "light";
		}
	}

	// Tier 3: host macOS appearance for known-broken terminal paths only.
	if (shouldUseMacOSAppearanceFallback()) {
		const macAppearance = macOSReportedAppearance ?? detectMacOSAppearance();
		if (macAppearance !== null && macAppearance !== undefined) return macAppearance;
	}

	return "dark";
}

function getDefaultTheme(): string {
	const bg = detectTerminalBackground();
	return bg === "light" ? autoLightTheme : autoDarkTheme;
}

// ============================================================================
// Global Theme Instance
// ============================================================================

export var theme: Theme;
var currentThemeName: string | undefined;

/** Get the name of the currently active theme. */
export function getCurrentThemeName(): string | undefined {
	return currentThemeName;
}
var currentSymbolPresetOverride: SymbolPreset | undefined;
var currentColorBlindMode: boolean = false;
var themeWatcher: fs.FSWatcher | undefined;
var themeReloadTimer: NodeJS.Timeout | undefined;
var sigwinchHandler: (() => void) | undefined;
var autoDetectedTheme: boolean = false;
var autoDarkTheme: string = "dark";
var autoLightTheme: string = "light";
var onThemeChangeCallback: (() => void) | undefined;
var themeLoadRequestId: number = 0;

function getCurrentThemeOptions(): CreateThemeOptions {
	return {
		symbolPresetOverride: currentSymbolPresetOverride,
		colorBlindMode: currentColorBlindMode,
	};
}

export async function initTheme(
	enableWatcher: boolean = false,
	symbolPreset?: SymbolPreset,
	colorBlindMode?: boolean,
	darkTheme?: string,
	lightTheme?: string,
): Promise<void> {
	autoDetectedTheme = true;
	autoDarkTheme = darkTheme ?? "dark";
	autoLightTheme = lightTheme ?? "light";
	const name = getDefaultTheme();
	currentThemeName = name;
	currentSymbolPresetOverride = symbolPreset;
	currentColorBlindMode = colorBlindMode ?? false;
	try {
		theme = await loadTheme(name, getCurrentThemeOptions());
		if (enableWatcher) {
			await startThemeWatcher();
			startSigwinchListener();
		}
	} catch (error) {
		logger.debug("Theme loading failed, falling back to dark theme", { error: String(error) });
		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());
		// Don't start watcher for fallback theme
	}
}

export async function setTheme(
	name: string,
	enableWatcher: boolean = false,
): Promise<{ success: boolean; error?: string }> {
	autoDetectedTheme = false;
	currentThemeName = name;
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}
		theme = loadedTheme;
		if (enableWatcher) {
			await startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme change superseded by a newer request" };
		}
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		theme = await loadTheme("dark", getCurrentThemeOptions());
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function previewTheme(name: string): Promise<{ success: boolean; error?: string }> {
	const requestId = ++themeLoadRequestId;
	try {
		const loadedTheme = await loadTheme(name, getCurrentThemeOptions());
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		theme = loadedTheme;
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		if (requestId !== themeLoadRequestId) {
			return { success: false, error: "Theme preview superseded by a newer request" };
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Enable auto-detection mode, switching to the appropriate dark/light theme.
 */
export function enableAutoTheme(): void {
	autoDetectedTheme = true;
	reevaluateAutoTheme("enableAutoTheme");
}

/**
 * Update the theme mappings for auto-detection mode.
 * When a dark/light mapping changes and auto-detection is active, re-evaluate the theme.
 */
export function setAutoThemeMapping(mode: "dark" | "light", themeName: string): void {
	if (mode === "dark") autoDarkTheme = themeName;
	else autoLightTheme = themeName;
	reevaluateAutoTheme("setAutoThemeMapping");
}

/**
 * Called when the terminal detects a dark/light appearance change.
 * The terminal layer queries OSC 11 (background color) and computes luminance;
 * Mode 2031 notifications trigger re-queries rather than providing the value directly.
 */
export function onTerminalAppearanceChange(mode: "dark" | "light"): void {
	if (terminalReportedAppearance === mode) return;
	terminalReportedAppearance = mode;
	reevaluateAutoTheme("terminal appearance");
}

export function setThemeInstance(themeInstance: Theme): void {
	autoDetectedTheme = false;
	theme = themeInstance;
	currentThemeName = "<in-memory>";
	stopThemeWatcher();
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

/**
 * Set the symbol preset override, recreating the theme with the new preset.
 */
export async function setSymbolPreset(preset: SymbolPreset): Promise<void> {
	currentSymbolPresetOverride = preset;
	if (currentThemeName !== null && currentThemeName !== undefined && currentThemeName !== "") {
		try {
			theme = await loadTheme(currentThemeName, getCurrentThemeOptions());
		} catch {
			// Fall back to dark theme with new preset
			theme = await loadTheme("dark", getCurrentThemeOptions());
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
	}
}

/**
 * Get the current symbol preset override.
 */
export function getSymbolPresetOverride(): SymbolPreset | undefined {
	return currentSymbolPresetOverride;
}

/**
 * Set color blind mode, recreating the theme with the new setting.
 * When enabled, uses blue instead of green for diff additions.
 */
export async function setColorBlindMode(enabled: boolean): Promise<void> {
	currentColorBlindMode = enabled;
	if (currentThemeName !== null && currentThemeName !== undefined && currentThemeName !== "") {
		try {
			theme = await loadTheme(currentThemeName, getCurrentThemeOptions());
		} catch {
			// Fall back to dark theme
			theme = await loadTheme("dark", getCurrentThemeOptions());
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
	}
}

/**
 * Get the current color blind mode setting.
 */
export function getColorBlindMode(): boolean {
	return currentColorBlindMode;
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

/**
 * Get available symbol presets.
 */
export function getAvailableSymbolPresets(): SymbolPreset[] {
	return ["unicode", "nerd", "ascii"];
}

/**
 * Check if a string is a valid symbol preset.
 */
export function isValidSymbolPreset(preset: string): preset is SymbolPreset {
	return preset === "unicode" || preset === "nerd" || preset === "ascii";
}

async function startThemeWatcher(): Promise<void> {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (
		currentThemeName === null ||
		currentThemeName === undefined ||
		currentThemeName === "" ||
		currentThemeName === "dark" ||
		currentThemeName === "light"
	) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			loadTheme(watchedThemeName, getCurrentThemeOptions())
				.then(loadedTheme => {
					theme = loadedTheme;
					if (onThemeChangeCallback) {
						onThemeChangeCallback();
					}
				})
				.catch(() => {
					// Ignore errors (file might be in invalid state while being edited)
				});
		}, 100);
	};

	try {
		themeWatcher = fs.watch(customThemesDir, (_eventType, filename) => {
			if (currentThemeName !== watchedThemeName) {
				return;
			}
			if (filename === null || filename === undefined || filename === "") {
				scheduleReload();
				return;
			}
			const changedFile = String(filename);
			if (changedFile !== watchedFileName) {
				return;
			}
			scheduleReload();
		});
	} catch {
		// Ignore errors starting watcher
	}
}

/**
 * Shared logic for re-evaluating the auto-detected theme.
 * Called from SIGWINCH, terminal appearance change handler, and macOS fallback observer.
 */
function reevaluateAutoTheme(debugLabel: string): void {
	if (!autoDetectedTheme) return;
	const resolved = getDefaultTheme();
	if (resolved === currentThemeName) return;
	currentThemeName = resolved;
	loadTheme(resolved, getCurrentThemeOptions())
		.then(loadedTheme => {
			theme = loadedTheme;
			if (onThemeChangeCallback) {
				onThemeChangeCallback();
			}
		})
		.catch(error => {
			logger.debug(`Theme switch on ${debugLabel} failed`, { error: String(error) });
		});
}

// ============================================================================
// macOS Appearance Fallback Observer
// ============================================================================

var macObserver: { stop(): void } | undefined;

function startMacAppearanceObserver(): void {
	stopMacAppearanceObserver();
	if (!shouldUseMacOSAppearanceFallback()) return;
	try {
		macOSReportedAppearance = detectMacOSAppearance() ?? undefined;
		macObserver = MacAppearanceObserver.start((err, appearance) => {
			if (!err && (appearance === "dark" || appearance === "light")) {
				macOSReportedAppearance = appearance;
				reevaluateAutoTheme("macOS fallback");
			}
		});
	} catch (error) {
		logger.warn("Failed to start macOS appearance observer", { error });
	}
}

function stopMacAppearanceObserver(): void {
	if (macObserver) {
		macObserver.stop();
		macObserver = undefined;
	}
	macOSReportedAppearance = undefined;
}

// ============================================================================
// SIGWINCH Listener
// ============================================================================

/** Re-check appearance on SIGWINCH and switch dark/light when using auto-detected theme. */
function startSigwinchListener(): void {
	stopSigwinchListener();
	sigwinchHandler = () => {
		reevaluateAutoTheme("SIGWINCH");
	};
	process.on("SIGWINCH", sigwinchHandler);
	startMacAppearanceObserver();
}

function stopSigwinchListener(): void {
	if (sigwinchHandler) {
		process.removeListener("SIGWINCH", sigwinchHandler);
		sigwinchHandler = undefined;
	}
	stopMacAppearanceObserver();
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
	stopSigwinchListener();
	terminalReportedAppearance = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export async function getResolvedThemeColors(themeName?: string): Promise<Record<string, string>> {
	const name = themeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = await loadThemeJson(name);
	const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);

	// Default text color for empty values (terminal uses default fg color)
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// Empty means default terminal color - use sensible fallback for HTML
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * Check if a theme is a "light" theme by analyzing its background color luminance.
 * Loads theme JSON synchronously (built-in or custom file) and resolves userMessageBg.
 */
export function isLightTheme(themeName?: string): boolean {
	const name = themeName ?? "dark";
	const builtinThemes = getBuiltinThemes();
	let themeJson: ThemeJson | undefined;
	if (name in builtinThemes) {
		themeJson = builtinThemes[name];
	} else {
		try {
			const customPath = path.join(getCustomThemesDir(), `${name}.json`);
			const content = fs.readFileSync(customPath, "utf-8");
			themeJson = JSON.parse(content) as ThemeJson;
		} catch {
			return false;
		}
	}
	try {
		const resolved = resolveVarRefs(themeJson.colors.userMessageBg, themeJson.vars ?? {});
		if (typeof resolved !== "string" || !resolved.startsWith("#") || resolved.length !== 7) return false;
		const r = parseInt(resolved.slice(1, 3), 16) / 255;
		const g = parseInt(resolved.slice(3, 5), 16) / 255;
		const b = parseInt(resolved.slice(5, 7), 16) / 255;
		// Relative luminance (ITU-R BT.709)
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		return luminance > 0.5;
	} catch {
		return false;
	}
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export async function getThemeExportColors(themeName?: string): Promise<{
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
}> {
	const name = themeName ?? getDefaultTheme();
	try {
		const themeJson = await loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: string | number | undefined): string | undefined => {
			if (value === undefined) return undefined;
			if (typeof value === "number") return ansi256ToHex(value);
			if (value === "" || value.startsWith("#")) return value;
			const varName = value.startsWith("$") ? value.slice(1) : value;
			if (varName in vars) {
				const resolved = resolveVarRefs(varName, vars);
				return typeof resolved === "number" ? ansi256ToHex(resolved) : resolved;
			}
			return value;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI Helpers
// ============================================================================

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: NativeHighlightColors | undefined;

function getHighlightColors(t: Theme): NativeHighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = {
			comment: t.getFgAnsi("syntaxComment"),
			keyword: t.getFgAnsi("syntaxKeyword"),
			function: t.getFgAnsi("syntaxFunction"),
			variable: t.getFgAnsi("syntaxVariable"),
			string: t.getFgAnsi("syntaxString"),
			number: t.getFgAnsi("syntaxNumber"),
			type: t.getFgAnsi("syntaxType"),
			operator: t.getFgAnsi("syntaxOperator"),
			punctuation: t.getFgAnsi("syntaxPunctuation"),
			inserted: t.getFgAnsi("toolDiffAdded"),
			deleted: t.getFgAnsi("toolDiffRemoved"),
		};
	}
	return cachedHighlightColors;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	const validLang =
		lang !== null && lang !== undefined && lang !== "" && nativeSupportsLanguage(lang) ? lang : undefined;
	try {
		return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
	} catch {
		return code.split("\n");
	}
}

export function getSymbolTheme(): SymbolTheme {
	const preset = theme.getSymbolPreset();

	return {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
}

let _markdownTheme: MarkdownTheme | undefined;
let _markdownThemeRef: Theme | undefined;

export function getMarkdownTheme(): MarkdownTheme {
	if (_markdownTheme !== undefined && _markdownThemeRef === theme) {
		return _markdownTheme;
	}
	const markdownTheme: MarkdownTheme = {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		symbols: getSymbolTheme(),
		resolveMermaidAscii,
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang =
				lang !== null && lang !== undefined && lang !== "" && nativeSupportsLanguage(lang) ? lang : undefined;
			try {
				return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
			} catch {
				return code.split("\n").map(line => theme.fg("mdCodeBlock", line));
			}
		},
	};
	_markdownTheme = markdownTheme;
	_markdownThemeRef = theme;
	return markdownTheme;
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		symbols: getSymbolTheme(),
		hintStyle: (text: string) => theme.fg("dim", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", `${theme.nav.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
	};
}
