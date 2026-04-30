import { theme } from "../packages/coding-agent/src/modes/theme/theme";
import {
	buildDiscoverableMCPSearchIndex,
	searchDiscoverableMCPTools,
	type DiscoverableMCPTool,
	type DiscoverableMCPSearchIndex,
} from "../packages/coding-agent/src/mcp/discoverable-tool-metadata";
import { bashToolRenderer, type BashRenderArgs } from "../packages/coding-agent/src/tools/bash";
import { SearchTool, type SearchToolDetails } from "../packages/coding-agent/src/tools/search";
import { searchToolBm25Renderer, type SearchToolBm25Details } from "../packages/coding-agent/src/tools/search-tool-bm25";
import type { ToolSession } from "../packages/coding-agent/src/tools";

interface RoundMetrics {
	bm25_index_ms: number;
	bm25_query_ms: number;
	file_search_ms: number;
	bash_render_ms: number;
	tool_discovery_render_ms: number;
	total_ms: number;
	checksum: number;
}

interface RenderableComponent {
	render(width: number): string[];
	invalidate?: () => void;
}

const ROOT = process.cwd();
const ROUND_COUNT = 5;
const QUERY_REPEAT_COUNT = 14;
const TOOL_COUNT = 6_000;
const WIDTH = 112;

const queryTerms = [
	"calendar schedule meeting attendee",
	"github issue pull request comment",
	"database query migration schema",
	"browser screenshot click form",
	"slack message channel thread",
	"search document vector embedding",
	"kubernetes pod deployment logs",
	"file upload download image",
];

const searchPatterns = [
	"renderStatusLine",
	"ToolExecutionComponent",
	"truncateToWidth",
	"SearchTool",
] as const;

function nowMs(): number {
	return performance.now();
}

function median(values: number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function roundMetric(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function emitMetric(name: string, value: number): void {
	process.stdout.write(`METRIC ${name}=${roundMetric(value)}\n`);
}

function renderAndMeasure(component: RenderableComponent): number {
	const lines = component.render(WIDTH);
	let checksum = lines.length;
	for (const line of lines) {
		checksum += line.length;
	}
	return checksum;
}

function buildSyntheticTools(): DiscoverableMCPTool[] {
	const verbs = ["create", "update", "delete", "list", "search", "sync", "export", "import"];
	const domains = [
		"calendar",
		"github",
		"database",
		"browser",
		"slack",
		"document",
		"kubernetes",
		"storage",
	];
	const nouns = ["meeting", "issue", "schema", "form", "thread", "embedding", "deployment", "artifact"];
	const tools: DiscoverableMCPTool[] = [];
	for (let index = 0; index < TOOL_COUNT; index += 1) {
		const verb = verbs[index % verbs.length]!;
		const domain = domains[Math.floor(index / verbs.length) % domains.length]!;
		const noun = nouns[Math.floor(index / (verbs.length * domains.length)) % nouns.length]!;
		const serverName = `${domain}-server-${index % 25}`;
		const uniqueTerm = `feature${index % 257}`;
		tools.push({
			name: `mcp__${serverName}__${verb}_${domain}_${noun}_${index}`,
			label: `${verb} ${domain} ${noun}`,
			description: `${verb} ${domain} ${noun} records with ${uniqueTerm} filtering, pagination, audit logs, batch mode, and user scoped permissions`,
			serverName,
			mcpToolName: `${verb}_${noun}`,
			schemaKeys: ["id", "query", "limit", "cursor", domain, noun, uniqueTerm],
		});
	}
	return tools;
}

function makeSearchSession(): ToolSession {
	const settings = {
		get(key: string): unknown {
			switch (key) {
				case "search.contextBefore":
				case "search.contextAfter":
					return 1;
				case "readLineNumbers":
					return true;
				case "readHashLines":
					return false;
				case "edit.mode":
					return "whole";
				default:
					return undefined;
			}
		},
	};
	return {
		cwd: ROOT,
		hasUI: false,
		hasEditTool: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
}

function measureBm25(tools: DiscoverableMCPTool[]): {
	index: DiscoverableMCPSearchIndex;
	indexMs: number;
	queryMs: number;
	checksum: number;
} {
	const indexStart = nowMs();
	const index = buildDiscoverableMCPSearchIndex(tools);
	const indexMs = nowMs() - indexStart;
	let checksum = 0;
	const queryStart = nowMs();
	for (let repeat = 0; repeat < QUERY_REPEAT_COUNT; repeat += 1) {
		for (const query of queryTerms) {
			const results = searchDiscoverableMCPTools(index, query, 8);
			checksum += results.length;
			checksum += Math.round((results[0]?.score ?? 0) * 1000);
		}
	}
	return { index, indexMs, queryMs: nowMs() - queryStart, checksum };
}

async function measureFileSearch(searchTool: SearchTool): Promise<{ elapsedMs: number; checksum: number }> {
	let checksum = 0;
	const start = nowMs();
	for (const pattern of searchPatterns) {
		const result = await searchTool.execute("bench", {
			pattern,
			path: "packages/coding-agent/src",
			i: false,
			gitignore: true,
			skip: 0,
		});
		const details = result.details as SearchToolDetails | undefined;
		checksum += details?.matchCount ?? 0;
		checksum += details?.fileCount ?? 0;
	}
	return { elapsedMs: nowMs() - start, checksum };
}

function measureBashRenderer(): { elapsedMs: number; checksum: number } {
	const output = Array.from(
		{ length: 900 },
		(_, index) =>
			`line ${index.toString().padStart(4, "0")} tool output with tabs\tpaths/packages/coding-agent/src/tools/bash.ts and enough text to wrap`,
	).join("\n");
	const args: BashRenderArgs = {
		command: "bun check:ts --filter coding-agent",
		cwd: "packages/coding-agent",
		env: { NODE_ENV: "test", PI_BENCH: "1" },
		timeout: 120,
	};
	let checksum = 0;
	const start = nowMs();
	for (let iteration = 0; iteration < 90; iteration += 1) {
		const component = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: output }],
				details: { timeoutSeconds: 120 },
				isError: false,
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: { output, expanded: false, previewLines: 10, timeout: 120 },
			},
			theme,
			args,
		) as RenderableComponent;
		checksum += renderAndMeasure(component);
	}
	return { elapsedMs: nowMs() - start, checksum };
}

function measureToolDiscoveryRenderer(index: DiscoverableMCPSearchIndex): { elapsedMs: number; checksum: number } {
	const ranked = searchDiscoverableMCPTools(index, "calendar meeting attendee schedule", 24);
	const details: SearchToolBm25Details = {
		query: "calendar meeting attendee schedule",
		limit: 24,
		total_tools: index.documents.length,
		activated_tools: ranked.slice(0, 8).map(result => result.tool.name),
		active_selected_tools: ranked.slice(0, 12).map(result => result.tool.name),
		tools: ranked.map(result => ({
			name: result.tool.name,
			label: result.tool.label,
			description: result.tool.description,
			server_name: result.tool.serverName,
			mcp_tool_name: result.tool.mcpToolName,
			schema_keys: result.tool.schemaKeys,
			score: result.score,
		})),
	};
	let checksum = 0;
	const start = nowMs();
	for (let iteration = 0; iteration < 160; iteration += 1) {
		const component = searchToolBm25Renderer.renderResult(
			{
				content: [{ type: "text", text: "{}" }],
				details,
				isError: false,
			},
			{ expanded: false, isPartial: false },
			theme,
		) as RenderableComponent;
		checksum += renderAndMeasure(component);
	}
	return { elapsedMs: nowMs() - start, checksum };
}

async function runRound(tools: DiscoverableMCPTool[], searchTool: SearchTool): Promise<RoundMetrics> {
	const bm25 = measureBm25(tools);
	const fileSearch = await measureFileSearch(searchTool);
	const bashRender = measureBashRenderer();
	const discoveryRender = measureToolDiscoveryRenderer(bm25.index);
	const totalMs = bm25.queryMs + bm25.indexMs + fileSearch.elapsedMs + bashRender.elapsedMs + discoveryRender.elapsedMs;
	return {
		bm25_index_ms: bm25.indexMs,
		bm25_query_ms: bm25.queryMs,
		file_search_ms: fileSearch.elapsedMs,
		bash_render_ms: bashRender.elapsedMs,
		tool_discovery_render_ms: discoveryRender.elapsedMs,
		total_ms: totalMs,
		checksum: bm25.checksum + fileSearch.checksum + bashRender.checksum + discoveryRender.checksum,
	};
}

async function main(): Promise<void> {
	const tools = buildSyntheticTools();
	const searchTool = new SearchTool(makeSearchSession());
	await runRound(tools, searchTool);
	const rounds: RoundMetrics[] = [];
	for (let iteration = 0; iteration < ROUND_COUNT; iteration += 1) {
		rounds.push(await runRound(tools, searchTool));
	}
	const names = [
		"total_ms",
		"bm25_query_ms",
		"bm25_index_ms",
		"file_search_ms",
		"bash_render_ms",
		"tool_discovery_render_ms",
	] as const;
	for (const name of names) {
		emitMetric(name, median(rounds.map(round => round[name])));
	}
	emitMetric("checksum", median(rounds.map(round => round.checksum)));
}

await main();
