/**
 * Symbol presets and spinner frames for the theme.
 * Extracted from theme.ts to keep that file under the max-lines limit.
 */
import type { SymbolKey, SymbolPreset } from "./theme";

export type SymbolMap = Record<SymbolKey, string>;

const UNICODE_SYMBOLS: SymbolMap = {
	// Status
	"status.success": "✔",
	"status.error": "✘",
	"status.warning": "⚠",
	"status.info": "ⓘ",
	"status.pending": "⏳",
	"status.disabled": "⦸",
	"status.enabled": "●",
	"status.running": "⟳",
	"status.shadowed": "◌",
	"status.aborted": "⏹",
	// Navigation
	"nav.cursor": "❯",
	"nav.selected": "➤",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",
	// Tree
	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
	"tree.horizontal": "─",
	"tree.hook": "└",
	// Box (rounded)
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box (sharp)
	"boxSharp.topLeft": "┌",
	"boxSharp.topRight": "┐",
	"boxSharp.bottomLeft": "└",
	"boxSharp.bottomRight": "┘",
	"boxSharp.horizontal": "─",
	"boxSharp.vertical": "│",
	"boxSharp.cross": "┼",
	"boxSharp.teeDown": "┬",
	"boxSharp.teeUp": "┴",
	"boxSharp.teeRight": "├",
	"boxSharp.teeLeft": "┤",
	// Separators (powerline-ish, but pure Unicode)
	"sep.powerline": "▕",
	"sep.powerlineThin": "┆",
	"sep.powerlineLeft": "▶",
	"sep.powerlineRight": "◀",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "▌",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " · ",
	"sep.slash": " / ",
	"sep.pipe": " │ ",
	// Icons
	"icon.model": "⬢",
	"icon.plan": "🗺",
	"icon.loop": "↻",
	"icon.folder": "📁",
	"icon.file": "📄",
	"icon.git": "⎇",
	"icon.branch": "⑂",
	"icon.pr": "⤴",
	"icon.tokens": "🪙",
	"icon.context": "◫",
	"icon.cost": "💲",
	"icon.time": "⏱",
	"icon.pi": "π",
	"icon.agents": "👥",
	"icon.cache": "💾",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.host": "🖥",
	"icon.session": "🆔",
	"icon.package": "📦",
	"icon.warning": "⚠",
	"icon.rewind": "↶",
	"icon.auto": "⟲",
	"icon.fast": "⚡",
	"icon.extensionSkill": "✦",
	"icon.extensionTool": "🛠",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "🔌",
	"icon.extensionRule": "⚖",
	"icon.extensionHook": "🪝",
	"icon.extensionPrompt": "✎",
	"icon.extensionContextFile": "📎",
	"icon.extensionInstruction": "📘",
	// STT
	"icon.mic": "🎤",
	// Thinking levels
	"thinking.minimal": "◔ min",
	"thinking.low": "◑ low",
	"thinking.medium": "◒ med",
	"thinking.high": "◕ high",
	"thinking.xhigh": "◉ xhi",
	// Checkboxes
	"checkbox.checked": "☑",
	"checkbox.unchecked": "☐",
	// Formatting
	"format.bullet": "•",
	"format.dash": "—",
	"format.bracketLeft": "⟦",
	"format.bracketRight": "⟧",
	// Markdown
	"md.quoteBorder": "▏",
	"md.hrChar": "─",
	"md.bullet": "•",
	// Language/file icons (emoji-centric, no Nerd Font required)
	"lang.default": "⌘",
	"lang.typescript": "🟦",
	"lang.javascript": "🟨",
	"lang.python": "🐍",
	"lang.rust": "🦀",
	"lang.go": "🐹",
	"lang.java": "☕",
	"lang.c": "Ⓒ",
	"lang.cpp": "➕",
	"lang.csharp": "♯",
	"lang.ruby": "💎",
	"lang.php": "🐘",
	"lang.swift": "🕊",
	"lang.kotlin": "🅺",
	"lang.shell": "💻",
	"lang.html": "🌐",
	"lang.css": "🎨",
	"lang.json": "🧾",
	"lang.yaml": "📋",
	"lang.markdown": "📝",
	"lang.sql": "🗄",
	"lang.docker": "🐳",
	"lang.lua": "🌙",
	"lang.text": "🗒",
	"lang.env": "🔧",
	"lang.toml": "🧾",
	"lang.xml": "⟨⟩",
	"lang.ini": "⚙",
	"lang.conf": "⚙",
	"lang.log": "📜",
	"lang.csv": "📑",
	"lang.tsv": "📑",
	"lang.image": "🖼",
	"lang.pdf": "📕",
	"lang.archive": "🗜",
	"lang.binary": "⚙",
	// Settings tabs
	"tab.appearance": "🎨",
	"tab.model": "🤖",
	"tab.interaction": "⌨",
	"tab.context": "📋",
	"tab.editing": "💻",
	"tab.tools": "🔧",
	"tab.tasks": "📦",
	"tab.providers": "🌐",
	// Vivid layout
	"rail.thin": "│",
	"rail.thick": "▌",
	"prompt.sigil": ":::",
	"badge.sep": "╱╱╱",
	"tool.statusOk": "✓",
	"tool.statusErr": "×",
	"tool.statusRun": "●",
};

const NERD_SYMBOLS: SymbolMap = {
	// Status Indicators
	// pick:  | alt:   
	"status.success": "\uf00c",
	// pick:  | alt:   
	"status.error": "\uf00d",
	// pick:  | alt:  
	"status.warning": "\uf12a",
	// pick:  | alt: 
	"status.info": "\uf129",
	// pick:  | alt:   
	"status.pending": "\uf254",
	// pick:  | alt:  
	"status.disabled": "\uf05e",
	// pick:  | alt:  
	"status.enabled": "\uf111",
	// pick:  | alt:   
	"status.running": "\uf110",
	// pick: ◐ | alt: ◑ ◒ ◓ ◔
	"status.shadowed": "◐",
	// pick:  | alt:  
	"status.aborted": "\uf04d",
	// Navigation
	// pick:  | alt:  
	"nav.cursor": "\uf054",
	// pick:  | alt:  
	"nav.selected": "\uf178",
	// pick:  | alt:  
	"nav.expand": "\uf0da",
	// pick:  | alt:  
	"nav.collapse": "\uf0d7",
	// pick:  | alt:  
	"nav.back": "\uf060",
	// Tree Connectors (same as unicode)
	// pick: ├─ | alt: ├╴ ├╌ ╠═ ┣━
	"tree.branch": "\u251c\u2500",
	// pick: └─ | alt: └╴ └╌ ╚═ ┗━
	"tree.last": "\u2514\u2500",
	// pick: │ | alt: ┃ ║ ▏ ▕
	"tree.vertical": "\u2502",
	// pick: ─ | alt: ━ ═ ╌ ┄
	"tree.horizontal": "\u2500",
	// pick: └ | alt: ╰ ⎿ ↳
	"tree.hook": "\u2514",
	// Box Drawing - Rounded (same as unicode)
	// pick: ╭ | alt: ┌ ┏ ╔
	"boxRound.topLeft": "\u256d",
	// pick: ╮ | alt: ┐ ┓ ╗
	"boxRound.topRight": "\u256e",
	// pick: ╰ | alt: └ ┗ ╚
	"boxRound.bottomLeft": "\u2570",
	// pick: ╯ | alt: ┘ ┛ ╝
	"boxRound.bottomRight": "\u256f",
	// pick: ─ | alt: ━ ═ ╌
	"boxRound.horizontal": "\u2500",
	// pick: │ | alt: ┃ ║ ▏
	"boxRound.vertical": "\u2502",
	// Box Drawing - Sharp (same as unicode)
	// pick: ┌ | alt: ┏ ╭ ╔
	"boxSharp.topLeft": "\u250c",
	// pick: ┐ | alt: ┓ ╮ ╗
	"boxSharp.topRight": "\u2510",
	// pick: └ | alt: ┗ ╰ ╚
	"boxSharp.bottomLeft": "\u2514",
	// pick: ┘ | alt: ┛ ╯ ╝
	"boxSharp.bottomRight": "\u2518",
	// pick: ─ | alt: ━ ═ ╌
	"boxSharp.horizontal": "\u2500",
	// pick: │ | alt: ┃ ║ ▏
	"boxSharp.vertical": "\u2502",
	// pick: ┼ | alt: ╋ ╬ ┿
	"boxSharp.cross": "\u253c",
	// pick: ┬ | alt: ╦ ┯ ┳
	"boxSharp.teeDown": "\u252c",
	// pick: ┴ | alt: ╩ ┷ ┻
	"boxSharp.teeUp": "\u2534",
	// pick: ├ | alt: ╠ ┝ ┣
	"boxSharp.teeRight": "\u251c",
	// pick: ┤ | alt: ╣ ┥ ┫
	"boxSharp.teeLeft": "\u2524",
	// Separators - Nerd Font specific
	// pick:  | alt:   
	"sep.powerline": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineThin": "\ue0b1",
	// pick:  | alt:  
	"sep.powerlineLeft": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineRight": "\ue0b2",
	// pick:  | alt: 
	"sep.powerlineThinLeft": "\ue0b1",
	// pick:  | alt: 
	"sep.powerlineThinRight": "\ue0b3",
	// pick: █ | alt: ▓ ▒ ░ ▉ ▌
	"sep.block": "\u2588",
	// pick: space | alt: ␠ ·
	"sep.space": " ",
	// pick: > | alt: › » ▸
	"sep.asciiLeft": ">",
	// pick: < | alt: ‹ « ◂
	"sep.asciiRight": "<",
	// pick: · | alt: • ⋅
	"sep.dot": " \u00b7 ",
	// pick:  | alt: / ∕ ⁄
	"sep.slash": "\ue0bb",
	// pick:  | alt: │ ┃ |
	"sep.pipe": "\ue0b3",
	// Icons - Nerd Font specific
	// pick:  | alt:   ◆
	"icon.model": "\uec19",
	// pick:  | alt:  
	"icon.plan": "\uf2d2",
	// pick: ↻ | alt: ⟳
	"icon.loop": "\uf021",
	// pick:  | alt:  
	"icon.folder": "\uf115",
	// pick:  | alt:  
	"icon.file": "\uf15b",
	// pick:  | alt:  ⎇
	"icon.git": "\uf1d3",
	// pick:  | alt:  ⎇
	"icon.branch": "\uf126",
	// pick:  (nf-cod-git_pull_request) | alt:  (nf-oct-git_pull_request)
	"icon.pr": "\uea64",
	// pick:  | alt: ⊛ ◍ 
	"icon.tokens": "\ue26b",
	// pick:  | alt: ◫ ▦
	"icon.context": "\ue70f",
	// pick:  | alt: $ ¢
	"icon.cost": "\uf155",
	// pick:  | alt: ◷ ◴
	"icon.time": "\uf017",
	// pick:  | alt: π ∏ ∑
	"icon.pi": "\ue22c",
	// pick:  | alt: 
	"icon.agents": "\uf0c0",
	// pick:  | alt:  
	"icon.cache": "\uf1c0",
	// pick:  | alt:  →
	"icon.input": "\uf090",
	// pick:  | alt:  →
	"icon.output": "\uf08b",
	// pick:  | alt:  
	"icon.host": "\uf109",
	// pick:  | alt:  
	"icon.session": "\uf550",
	// pick:  | alt: 
	"icon.package": "\uf487",
	// pick:  | alt:  
	"icon.warning": "\uf071",
	// pick:  | alt:  ↺
	"icon.rewind": "\uf0e2",
	// pick: 󰁨 | alt:   
	"icon.auto": "\u{f0068}",
	"icon.fast": "\uf0e7",
	"icon.extensionSkill": "\uf0eb",
	// pick:  | alt:  
	"icon.extensionTool": "\uf0ad",
	// pick:  | alt: 
	"icon.extensionSlashCommand": "\uf120",
	// pick:  | alt:  
	"icon.extensionMcp": "\uf1e6",
	// pick:  | alt:  
	"icon.extensionRule": "\uf0e3",
	// pick:  | alt: 
	"icon.extensionHook": "\uf0c1",
	// pick:  | alt:  
	"icon.extensionPrompt": "\uf075",
	// pick:  | alt:  
	"icon.extensionContextFile": "\uf0f6",
	// pick:  | alt:  
	"icon.extensionInstruction": "\uf02d",
	// STT - fa-microphone
	"icon.mic": "\uf130",
	// Thinking Levels - emoji labels
	// pick: 🤨 min | alt:  min  min
	"thinking.minimal": "\u{F0E7} min",
	// pick: 🤔 low | alt:  low  low
	"thinking.low": "\u{F10C} low",
	// pick: 🤓 med | alt:  med  med
	"thinking.medium": "\u{F192} med",
	// pick: 🤯 high | alt:  high  high
	"thinking.high": "\u{F111} high",
	// pick: 🧠 xhi | alt:  xhi  xhi
	"thinking.xhigh": "\u{F06D} xhi",
	// Checkboxes
	// pick:  | alt:  
	"checkbox.checked": "\uf14a",
	// pick:  | alt: 
	"checkbox.unchecked": "\uf096",
	// pick:  | alt:   •
	"format.bullet": "\uf111",
	// pick: – | alt: — ― -
	"format.dash": "\u2013",
	// pick: ⟨ | alt: [ ⟦
	"format.bracketLeft": "⟨",
	// pick: ⟩ | alt: ] ⟧
	"format.bracketRight": "⟩",
	// Markdown-specific
	// pick: │ | alt: ┃ ║
	"md.quoteBorder": "\u2502",
	// pick: ─ | alt: ━ ═
	"md.hrChar": "\u2500",
	// pick:  | alt:  •
	"md.bullet": "\uf111",
	// Language icons (nerd font devicons)
	"lang.default": "",
	"lang.typescript": "\u{E628}",
	"lang.javascript": "\u{E60C}",
	"lang.python": "\u{E606}",
	"lang.rust": "\u{E7A8}",
	"lang.go": "\u{E627}",
	"lang.java": "\u{E738}",
	"lang.c": "\u{E61E}",
	"lang.cpp": "\u{E61D}",
	"lang.csharp": "\u{E7BC}",
	"lang.ruby": "\u{E791}",
	"lang.php": "\u{E608}",
	"lang.swift": "\u{E755}",
	"lang.kotlin": "\u{E634}",
	"lang.shell": "\u{E795}",
	"lang.html": "\u{E736}",
	"lang.css": "\u{E749}",
	"lang.json": "\u{E60B}",
	"lang.yaml": "\u{E615}",
	"lang.markdown": "\u{E609}",
	"lang.sql": "\u{E706}",
	"lang.docker": "\u{E7B0}",
	"lang.lua": "\u{E620}",
	"lang.text": "\u{E612}",
	"lang.env": "\u{E615}",
	"lang.toml": "\u{E615}",
	"lang.xml": "\u{F05C0}",
	"lang.ini": "\u{E615}",
	"lang.conf": "\u{E615}",
	"lang.log": "\u{F0331}",
	"lang.csv": "\u{F021B}",
	"lang.tsv": "\u{F021B}",
	"lang.image": "\u{F021F}",
	"lang.pdf": "\u{F0226}",
	"lang.archive": "\u{F187}",
	"lang.binary": "\u{F019A}",
	// Settings tab icons
	"tab.appearance": "󰃣",
	"tab.model": "󰚩",
	"tab.interaction": "󰌌",
	"tab.context": "󰘸",
	"tab.editing": "",
	"tab.tools": "󰠭",
	"tab.tasks": "󰐱",
	"tab.providers": "󰖟",
	// Vivid layout (nerd-font glyphs unchanged from Unicode for these — same look)
	"rail.thin": "│",
	"rail.thick": "▌",
	"prompt.sigil": ":::",
	"badge.sep": "╱╱╱",
	"tool.statusOk": "",
	"tool.statusErr": "",
	"tool.statusRun": "",
};

const ASCII_SYMBOLS: SymbolMap = {
	// Status Indicators
	"status.success": "[ok]",
	"status.error": "[!!]",
	"status.warning": "[!]",
	"status.info": "[i]",
	"status.pending": "[*]",
	"status.disabled": "[ ]",
	"status.enabled": "[x]",
	"status.running": "[~]",
	"status.shadowed": "[/]",
	"status.aborted": "[-]",
	// Navigation
	"nav.cursor": ">",
	"nav.selected": "->",
	"nav.expand": "+",
	"nav.collapse": "-",
	"nav.back": "<-",
	// Tree Connectors
	"tree.branch": "|--",
	"tree.last": "'--",
	"tree.vertical": "|",
	"tree.horizontal": "-",
	"tree.hook": "`-",
	// Box Drawing - Rounded (ASCII fallback)
	"boxRound.topLeft": "+",
	"boxRound.topRight": "+",
	"boxRound.bottomLeft": "+",
	"boxRound.bottomRight": "+",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	// Box Drawing - Sharp (ASCII fallback)
	"boxSharp.topLeft": "+",
	"boxSharp.topRight": "+",
	"boxSharp.bottomLeft": "+",
	"boxSharp.bottomRight": "+",
	"boxSharp.horizontal": "-",
	"boxSharp.vertical": "|",
	"boxSharp.cross": "+",
	"boxSharp.teeDown": "+",
	"boxSharp.teeUp": "+",
	"boxSharp.teeRight": "+",
	"boxSharp.teeLeft": "+",
	// Separators
	"sep.powerline": ">",
	"sep.powerlineThin": ">",
	"sep.powerlineLeft": ">",
	"sep.powerlineRight": "<",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "#",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " - ",
	"sep.slash": " / ",
	"sep.pipe": " | ",
	// Icons
	"icon.model": "[M]",
	"icon.plan": "plan",
	"icon.loop": "loop",
	"icon.folder": "[D]",
	"icon.file": "[F]",
	"icon.git": "git:",
	"icon.branch": "@",
	"icon.pr": "PR",
	"icon.tokens": "tok:",
	"icon.context": "ctx:",
	"icon.cost": "$",
	"icon.time": "t:",
	"icon.pi": "pi",
	"icon.agents": "AG",
	"icon.cache": "cache",
	"icon.input": "in:",
	"icon.output": "out:",
	"icon.host": "host",
	"icon.session": "id",
	"icon.package": "[P]",
	"icon.warning": "[!]",
	"icon.rewind": "<-",
	"icon.auto": "[A]",
	"icon.fast": ">>",
	"icon.extensionSkill": "SK",
	"icon.extensionTool": "TL",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "MCP",
	"icon.extensionRule": "RL",
	"icon.extensionHook": "HK",
	"icon.extensionPrompt": "PR",
	"icon.extensionContextFile": "CF",
	"icon.extensionInstruction": "IN",
	// STT
	"icon.mic": "MIC",
	// Thinking Levels
	"thinking.minimal": "[min]",
	"thinking.low": "[low]",
	"thinking.medium": "[med]",
	"thinking.high": "[high]",
	"thinking.xhigh": "[xhi]",
	// Checkboxes
	"checkbox.checked": "[x]",
	"checkbox.unchecked": "[ ]",
	"format.bullet": "*",
	"format.dash": "-",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	// Markdown-specific
	"md.quoteBorder": "|",
	"md.hrChar": "-",
	"md.bullet": "*",
	// Language icons (ASCII uses abbreviations)
	"lang.default": "code",
	"lang.typescript": "ts",
	"lang.javascript": "js",
	"lang.python": "py",
	"lang.rust": "rs",
	"lang.go": "go",
	"lang.java": "java",
	"lang.c": "c",
	"lang.cpp": "cpp",
	"lang.csharp": "cs",
	"lang.ruby": "rb",
	"lang.php": "php",
	"lang.swift": "swift",
	"lang.kotlin": "kt",
	"lang.shell": "sh",
	"lang.html": "html",
	"lang.css": "css",
	"lang.json": "json",
	"lang.yaml": "yaml",
	"lang.markdown": "md",
	"lang.sql": "sql",
	"lang.docker": "docker",
	"lang.lua": "lua",
	"lang.text": "txt",
	"lang.env": "env",
	"lang.toml": "toml",
	"lang.xml": "xml",
	"lang.ini": "ini",
	"lang.conf": "conf",
	"lang.log": "log",
	"lang.csv": "csv",
	"lang.tsv": "tsv",
	"lang.image": "img",
	"lang.pdf": "pdf",
	"lang.archive": "zip",
	"lang.binary": "bin",
	// Settings tab icons
	"tab.appearance": "[A]",
	"tab.model": "[M]",
	"tab.interaction": "[I]",
	"tab.context": "[X]",
	"tab.editing": "[E]",
	"tab.tools": "[T]",
	"tab.tasks": "[K]",
	"tab.providers": "[P]",
	// Vivid layout (ASCII fallbacks)
	"rail.thin": "|",
	"rail.thick": "|",
	"prompt.sigil": ">>>",
	"badge.sep": "///",
	"tool.statusOk": "[ok]",
	"tool.statusErr": "[x]",
	"tool.statusRun": "[*]",
};

export const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	nerd: NERD_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

export type SpinnerType = "status" | "activity";

export const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		status: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	nerd: {
		status: ["󱑖", "󱑋", "󱑌", "󱑍", "󱑎", "󱑏", "󱑐", "󱑑", "󱑒", "󱑓", "󱑔", "󱑕"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	ascii: {
		status: ["|", "/", "-", "\\"],
		activity: ["-", "\\", "|", "/"],
	},
};
