import {
	buildDiscoverableMCPSearchIndex,
	formatDiscoverableMCPToolServerSummary,
	searchDiscoverableMCPTools,
	summarizeDiscoverableMCPTools,
	type DiscoverableMCPTool,
	type DiscoverableMCPSearchIndex,
} from "../packages/coding-agent/src/mcp/discoverable-tool-metadata";

interface RoundMetrics {
	bm25_index_ms: number;
	bm25_query_ms: number;
	result_format_ms: number;
	summary_ms: number;
	total_ms: number;
	checksum: number;
}

const ROUND_COUNT = 7;
const QUERY_REPEAT_COUNT = 18;
const TOOL_COUNT = 12_000;
const RESULT_LIMIT = 8;

const queryTerms = [
	"calendar schedule meeting attendee",
	"github issue pull request comment",
	"database query migration schema",
	"browser screenshot click form",
	"slack message channel thread",
	"search document vector embedding",
	"kubernetes pod deployment logs",
	"file upload download image",
	"approval task workflow status",
	"email draft inbox attachment",
];

interface FormattedSearchResult {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

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

function buildSyntheticTools(): DiscoverableMCPTool[] {
	const verbs = ["create", "update", "delete", "list", "search", "sync", "export", "import", "review", "summarize"];
	const domains = [
		"calendar",
		"github",
		"database",
		"browser",
		"slack",
		"document",
		"kubernetes",
		"storage",
		"approval",
		"email",
	];
	const nouns = [
		"meeting",
		"issue",
		"schema",
		"form",
		"thread",
		"embedding",
		"deployment",
		"artifact",
		"workflow",
		"attachment",
	];
	const tools: DiscoverableMCPTool[] = [];
	for (let index = 0; index < TOOL_COUNT; index += 1) {
		const verb = verbs[index % verbs.length]!;
		const domain = domains[Math.floor(index / verbs.length) % domains.length]!;
		const noun = nouns[Math.floor(index / (verbs.length * domains.length)) % nouns.length]!;
		const serverName = `${domain}-server-${index % 40}`;
		const uniqueTerm = `feature${index % 509}`;
		tools.push({
			name: `mcp__${serverName}__${verb}_${domain}_${noun}_${index}`,
			label: `${verb} ${domain} ${noun}`,
			description: `${verb} ${domain} ${noun} records with ${uniqueTerm} filtering, pagination, audit logs, batch mode, and user scoped permissions`,
			serverName,
			mcpToolName: `${verb}_${noun}`,
			schemaKeys: ["id", "query", "limit", "cursor", "actor", "workspace", domain, noun, uniqueTerm],
		});
	}
	return tools;
}

function formatResult(tool: DiscoverableMCPTool, score: number): FormattedSearchResult {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
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
			const results = searchDiscoverableMCPTools(index, query, RESULT_LIMIT);
			checksum += results.length;
			checksum += Math.round((results[0]?.score ?? 0) * 1000);
		}
	}
	return { index, indexMs, queryMs: nowMs() - queryStart, checksum };
}

function measureResultFormatting(index: DiscoverableMCPSearchIndex): { elapsedMs: number; checksum: number } {
	let checksum = 0;
	const start = nowMs();
	for (let repeat = 0; repeat < QUERY_REPEAT_COUNT * 8; repeat += 1) {
		const query = queryTerms[repeat % queryTerms.length]!;
		const ranked = searchDiscoverableMCPTools(index, query, 24);
		const formatted = ranked.map(result => formatResult(result.tool, result.score));
		checksum += formatted.length;
		checksum += formatted[0]?.name.length ?? 0;
		checksum += formatted[0]?.schema_keys.length ?? 0;
	}
	return { elapsedMs: nowMs() - start, checksum };
}

function measureSummary(tools: DiscoverableMCPTool[]): { elapsedMs: number; checksum: number } {
	let checksum = 0;
	const start = nowMs();
	for (let repeat = 0; repeat < 120; repeat += 1) {
		const summary = summarizeDiscoverableMCPTools(tools);
		const lines = summary.servers.map(formatDiscoverableMCPToolServerSummary);
		checksum += summary.toolCount;
		checksum += lines.length;
		checksum += lines[0]?.length ?? 0;
	}
	return { elapsedMs: nowMs() - start, checksum };
}

async function runRound(tools: DiscoverableMCPTool[]): Promise<RoundMetrics> {
	const bm25 = measureBm25(tools);
	const formatting = measureResultFormatting(bm25.index);
	const summary = measureSummary(tools);
	const totalMs = bm25.queryMs + bm25.indexMs + formatting.elapsedMs + summary.elapsedMs;
	return {
		bm25_index_ms: bm25.indexMs,
		bm25_query_ms: bm25.queryMs,
		result_format_ms: formatting.elapsedMs,
		summary_ms: summary.elapsedMs,
		total_ms: totalMs,
		checksum: bm25.checksum + formatting.checksum + summary.checksum,
	};
}

async function main(): Promise<void> {
	const tools = buildSyntheticTools();
	await runRound(tools);
	const rounds: RoundMetrics[] = [];
	for (let iteration = 0; iteration < ROUND_COUNT; iteration += 1) {
		rounds.push(await runRound(tools));
	}
	const names = ["total_ms", "bm25_query_ms", "bm25_index_ms", "result_format_ms", "summary_ms"] as const;
	for (const name of names) {
		emitMetric(name, median(rounds.map(round => round[name])));
	}
	emitMetric("checksum", median(rounds.map(round => round.checksum)));
}

await main();
