import type { AgentTool } from "@oh-my-pi/pi-agent-core";

export interface DiscoverableMCPTool {
	name: string;
	label: string;
	description: string;
	serverName?: string;
	mcpToolName?: string;
	schemaKeys: string[];
}

export interface DiscoverableMCPToolServerSummary {
	name: string;
	toolCount: number;
}

export interface DiscoverableMCPToolSummary {
	servers: DiscoverableMCPToolServerSummary[];
	toolCount: number;
}

export function formatDiscoverableMCPToolServerSummary(server: DiscoverableMCPToolServerSummary): string {
	const toolLabel = server.toolCount === 1 ? "tool" : "tools";
	return `${server.name} (${server.toolCount} ${toolLabel})`;
}

export interface DiscoverableMCPSearchDocument {
	tool: DiscoverableMCPTool;
	termFrequencies: Map<string, number>;
	length: number;
}

export interface DiscoverableMCPSearchPosting {
	documentIndex: number;
	termFrequency: number;
}

export interface DiscoverableMCPSearchIndex {
	documents: DiscoverableMCPSearchDocument[];
	averageLength: number;
	documentFrequencies: Map<string, number>;
	postings?: Map<string, DiscoverableMCPSearchPosting[]>;
	/** Reused by postings-based search to avoid per-query score array allocation. */
	scoreScratch?: Float64Array;
	/** Reused by postings-based search to avoid per-query touched-index array allocation. */
	touchedScratch?: Int32Array;
}

export interface DiscoverableMCPSearchResult {
	tool: DiscoverableMCPTool;
	score: number;
}

export interface DiscoverableMCPSearchOptions {
	excludedToolNames?: ReadonlySet<string>;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const QUERY_TOKEN_CACHE_LIMIT = 128;
const queryTokenCache = new Map<string, string[]>();
const FIELD_WEIGHTS = {
	name: 6,
	label: 4,
	serverName: 2,
	mcpToolName: 4,
	description: 2,
	schemaKey: 1,
} as const;

export function isMCPToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

function getSchemaPropertyKeys(parameters: unknown): string[] {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
	const properties = (parameters as { properties?: unknown }).properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	return Object.keys(properties as Record<string, unknown>).sort();
}

function tokenize(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
}

function tokenizeQuery(query: string): string[] {
	const cached = queryTokenCache.get(query);
	if (cached) return cached;
	const tokens = tokenize(query);
	if (queryTokenCache.size >= QUERY_TOKEN_CACHE_LIMIT) {
		const oldest = queryTokenCache.keys().next().value;
		if (oldest !== undefined) {
			queryTokenCache.delete(oldest);
		}
	}
	queryTokenCache.set(query, tokens);
	return tokens;
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): number {
	if (!value) return 0;
	let addedLength = 0;
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
		addedLength += weight;
	}
	return addedLength;
}

function buildSearchDocument(tool: DiscoverableMCPTool): DiscoverableMCPSearchDocument {
	const termFrequencies = new Map<string, number>();
	let length = 0;
	length += addWeightedTokens(termFrequencies, tool.name, FIELD_WEIGHTS.name);
	length += addWeightedTokens(termFrequencies, tool.label, FIELD_WEIGHTS.label);
	length += addWeightedTokens(termFrequencies, tool.serverName, FIELD_WEIGHTS.serverName);
	length += addWeightedTokens(termFrequencies, tool.mcpToolName, FIELD_WEIGHTS.mcpToolName);
	length += addWeightedTokens(termFrequencies, tool.description, FIELD_WEIGHTS.description);
	for (const schemaKey of tool.schemaKeys) {
		length += addWeightedTokens(termFrequencies, schemaKey, FIELD_WEIGHTS.schemaKey);
	}
	return { tool, termFrequencies, length };
}

export function getDiscoverableMCPTool(tool: AgentTool): DiscoverableMCPTool | null {
	if (!isMCPToolName(tool.name)) return null;
	const toolRecord = tool as AgentTool & {
		label?: string;
		description?: string;
		mcpServerName?: string;
		mcpToolName?: string;
		parameters?: unknown;
	};
	return {
		name: tool.name,
		label: typeof toolRecord.label === "string" ? toolRecord.label : tool.name,
		description: typeof toolRecord.description === "string" ? toolRecord.description : "",
		serverName: typeof toolRecord.mcpServerName === "string" ? toolRecord.mcpServerName : undefined,
		mcpToolName: typeof toolRecord.mcpToolName === "string" ? toolRecord.mcpToolName : undefined,
		schemaKeys: getSchemaPropertyKeys(toolRecord.parameters),
	};
}

export function collectDiscoverableMCPTools(tools: Iterable<AgentTool>): DiscoverableMCPTool[] {
	const discoverable: DiscoverableMCPTool[] = [];
	for (const tool of tools) {
		const metadata = getDiscoverableMCPTool(tool);
		if (metadata) {
			discoverable.push(metadata);
		}
	}
	return discoverable;
}

export function selectDiscoverableMCPToolNamesByServer(
	tools: Iterable<DiscoverableMCPTool>,
	serverNames: ReadonlySet<string>,
): string[] {
	if (serverNames.size === 0) return [];
	return Array.from(tools)
		.filter(tool => tool.serverName !== undefined && serverNames.has(tool.serverName))
		.map(tool => tool.name);
}

export function summarizeDiscoverableMCPTools(tools: DiscoverableMCPTool[]): DiscoverableMCPToolSummary {
	const serverToolCounts = new Map<string, number>();
	for (const tool of tools) {
		if (!tool.serverName) continue;
		serverToolCounts.set(tool.serverName, (serverToolCounts.get(tool.serverName) ?? 0) + 1);
	}
	const servers = Array.from(serverToolCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, toolCount]) => ({ name, toolCount }));
	return {
		servers,
		toolCount: tools.length,
	};
}

export function buildDiscoverableMCPSearchIndex(tools: Iterable<DiscoverableMCPTool>): DiscoverableMCPSearchIndex {
	const documents = Array.from(tools, buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	const postings = new Map<string, DiscoverableMCPSearchPosting[]>();
	for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
		const document = documents[documentIndex]!;
		for (const [token, termFrequency] of document.termFrequencies) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
			let tokenPostings = postings.get(token);
			if (!tokenPostings) {
				tokenPostings = [];
				postings.set(token, tokenPostings);
			}
			tokenPostings.push({ documentIndex, termFrequency });
		}
	}
	return {
		documents,
		averageLength,
		documentFrequencies,
		postings,
	};
}

function compareSearchResults(left: DiscoverableMCPSearchResult, right: DiscoverableMCPSearchResult): number {
	return right.score - left.score || left.tool.name.localeCompare(right.tool.name);
}

function isSearchResultWorse(left: DiscoverableMCPSearchResult, right: DiscoverableMCPSearchResult): boolean {
	return compareSearchResults(left, right) > 0;
}

function isSearchResultWorseThanCandidate(
	result: DiscoverableMCPSearchResult,
	candidateTool: DiscoverableMCPTool,
	candidateScore: number,
): boolean {
	return candidateScore > result.score || (candidateScore === result.score && result.tool.name > candidateTool.name);
}

function findWorstSearchResultIndex(results: DiscoverableMCPSearchResult[]): number {
	let worstIndex = 0;
	for (let index = 1; index < results.length; index += 1) {
		if (isSearchResultWorse(results[index]!, results[worstIndex]!)) {
			worstIndex = index;
		}
	}
	return worstIndex;
}

export function searchDiscoverableMCPTools(
	index: DiscoverableMCPSearchIndex,
	query: string,
	limit: number,
	options?: DiscoverableMCPSearchOptions,
): DiscoverableMCPSearchResult[] {
	const queryTokens = tokenizeQuery(query);
	if (queryTokens.length === 0) {
		throw new Error("Query must contain at least one letter or number.");
	}
	const normalizedLimit = Math.max(0, Math.floor(limit));
	if (index.documents.length === 0 || normalizedLimit === 0) {
		return [];
	}

	const weightedQueryTerms: Array<{
		token: string;
		queryTermCount: number;
		idf: number;
		weight: number;
		postings?: DiscoverableMCPSearchPosting[];
	}> = [];
	for (const token of queryTokens) {
		const existing = weightedQueryTerms.find(term => term.token === token);
		if (existing) {
			existing.queryTermCount += 1;
			existing.weight += existing.idf * (BM25_K1 + 1);
			continue;
		}
		const documentFrequency = index.documentFrequencies.get(token) ?? 0;
		if (documentFrequency === 0) continue;
		const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
		weightedQueryTerms.push({
			token,
			queryTermCount: 1,
			idf,
			weight: idf * (BM25_K1 + 1),
			postings: index.postings?.get(token),
		});
	}
	if (weightedQueryTerms.length === 0) {
		return [];
	}

	const results: DiscoverableMCPSearchResult[] = [];
	const bounded = normalizedLimit < index.documents.length;
	const excludedToolNames = options?.excludedToolNames;
	let worstIndex = -1;
	const pushResult = (tool: DiscoverableMCPTool, score: number) => {
		if (!bounded || results.length < normalizedLimit) {
			results.push({ tool, score });
			worstIndex = -1;
			return;
		}
		if (worstIndex === -1) {
			worstIndex = findWorstSearchResultIndex(results);
		}
		if (isSearchResultWorseThanCandidate(results[worstIndex]!, tool, score)) {
			results[worstIndex] = { tool, score };
			worstIndex = -1;
		}
	};

	if (index.postings) {
		const scores = index.scoreScratch ?? (index.scoreScratch = new Float64Array(index.documents.length));
		const touchedDocumentIndices = index.touchedScratch ?? (index.touchedScratch = new Int32Array(index.documents.length));
		let touchedCount = 0;
		if (excludedToolNames) {
			for (const { weight, postings } of weightedQueryTerms) {
				if (!postings) continue;
				for (const { documentIndex, termFrequency } of postings) {
					const document = index.documents[documentIndex]!;
					if (excludedToolNames.has(document.tool.name)) continue;
					const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
					const score = (weight * termFrequency) / (termFrequency + normalization);
					const previousScore = scores[documentIndex]!;
					if (previousScore === 0) {
						touchedDocumentIndices[touchedCount] = documentIndex;
						touchedCount += 1;
					}
					scores[documentIndex] = previousScore + score;
				}
			}
		} else {
			for (const { weight, postings } of weightedQueryTerms) {
				if (!postings) continue;
				for (const { documentIndex, termFrequency } of postings) {
					const document = index.documents[documentIndex]!;
					const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
					const score = (weight * termFrequency) / (termFrequency + normalization);
					const previousScore = scores[documentIndex]!;
					if (previousScore === 0) {
						touchedDocumentIndices[touchedCount] = documentIndex;
						touchedCount += 1;
					}
					scores[documentIndex] = previousScore + score;
				}
			}
		}
		for (let touchedIndex = 0; touchedIndex < touchedCount; touchedIndex += 1) {
			const documentIndex = touchedDocumentIndices[touchedIndex]!;
			const score = scores[documentIndex]!;
			if (score > 0) {
				pushResult(index.documents[documentIndex]!.tool, score);
				scores[documentIndex] = 0;
			}
		}
		return results.sort(compareSearchResults).slice(0, normalizedLimit);
	}

	for (const document of index.documents) {
		if (excludedToolNames?.has(document.tool.name)) continue;
		let score = 0;
		for (const { token, weight } of weightedQueryTerms) {
			const termFrequency = document.termFrequencies.get(token) ?? 0;
			if (termFrequency === 0) continue;
			const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
			score += (weight * termFrequency) / (termFrequency + normalization);
		}
		if (score > 0) {
			pushResult(document.tool, score);
		}
	}

	return results.sort(compareSearchResults).slice(0, normalizedLimit);
}
