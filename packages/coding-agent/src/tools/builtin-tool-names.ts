export const BUILTIN_TOOL_NAMES = [
	"ast_grep",
	"ast_edit",
	"render_mermaid",
	"ask",
	"bash",
	"debug",
	"python",
	"calc",
	"ssh",
	"edit",
	"github",
	"find",
	"search",
	"lsp",
	"notebook",
	"read",
	"inspect_image",
	"browser",
	"checkpoint",
	"rewind",
	"task",
	"job",
	"recipe",
	"irc",
	"todo_write",
	"web_search",
	"search_tool_bm25",
	"write",
] as const;

export type ToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);
