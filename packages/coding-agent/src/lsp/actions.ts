import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { theme } from "../modes/theme/theme";
import type { ToolSession } from "../tools";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { ensureFileOpen, getOrCreateClient, sendRequest, waitForProjectLoaded } from "./client";
import { applyWorkspaceEdit } from "./edits";
import { detectLspmux } from "./lspmux";
import {
	collectFileDiagnosticsExternal,
	dedupeDiagnostics,
	isProjectAwareLspServer,
	processAllTargets,
	reloadServer,
} from "./diagnostics-helpers";
import {
	type CodeAction,
	type CodeActionContext,
	type Command,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	type LspClient,
	type LspParams,
	type LspToolDetails,
	type Position,
	type ServerConfig,
	type SymbolInformation,
	type WorkspaceEdit,
} from "./types";
import {
	applyCodeAction,
	dedupeWorkspaceSymbols,
	extractHoverText,
	fileToUri,
	filterWorkspaceSymbols,
	formatCodeAction,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatDocumentSymbol,
	formatGroupedDiagnosticMessages,
	formatLocation,
	formatSymbolInformation,
	formatWorkspaceEdit,
	readLocationContext,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	symbolKindToIcon,
} from "./utils";

export { reloadServer, isProjectAwareLspServer, dedupeDiagnostics } from "./diagnostics-helpers";
export { waitForDiagnostics } from "./diagnostics-helpers";

export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
export const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
export const WORKSPACE_SYMBOL_LIMIT = 200;

export const LOCATION_CONTEXT_LINES = 1;
export const REFERENCE_CONTEXT_LIMIT = 50;

export const REFERENCES_RETRY_COUNT = 2;
export const REFERENCES_RETRY_DELAY_MS = 250;

export function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

export function rangeContainsPosition(range: Location["range"], position: Position): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

export function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

export function normalizeLocationResult(
	result: Location | Location[] | LocationLink | LocationLink[] | null,
): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap(loc => {
		if ("uri" in loc) {
			return [loc as Location];
		}
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

function uriToFile(uri: string): string {
	return uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
}

export async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const context = await readLocationContext(
		uriToFile(location.uri),
		location.range.start.line + 1,
		LOCATION_CONTEXT_LINES,
	);
	if (context.length === 0) {
		return header;
	}
	return `${header}\n${context.map(lineText => `    ${lineText}`).join("\n")}`;
}

interface DiagnosticsActionParams {
	action: "diagnostics";
	file: string;
	timeoutSec: number;
	cwd: string;
	signal: AbortSignal | undefined;
	getServers: (filePath: string) => Array<[string, ServerConfig]>;
	params: LspParams;
}

async function handleSingleFileDiagnostics(
	resolved: string,
	servers: Array<[string, ServerConfig]>,
	args: DiagnosticsActionParams,
	allServerNames: Set<string>,
	diagnosticsWaitTimeoutMs: number,
): Promise<AgentToolResult<LspToolDetails>> {
	const uri = fileToUri(resolved);
	const relPath = formatPathRelativeToCwd(resolved, args.cwd);
	const allDiagnostics = await collectFileDiagnosticsExternal({
		servers,
		resolved,
		uri,
		cwd: args.cwd,
		signal: args.signal,
		diagnosticsWaitTimeoutMs,
		allServerNames,
	});
	const uniqueDiagnostics = dedupeDiagnostics(allDiagnostics);
	sortDiagnostics(uniqueDiagnostics);

	if (uniqueDiagnostics.length === 0) {
		return {
			content: [{ type: "text", text: "No diagnostics" }],
			details: {
				action: args.action,
				serverName: Array.from(allServerNames).join(", "),
				success: true,
			},
		};
	}

	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const output = `${summary}:\n${formatGroupedDiagnosticMessages(formatted)}`;
	return {
		content: [{ type: "text", text: output }],
		details: {
			action: args.action,
			serverName: Array.from(allServerNames).join(", "),
			success: true,
		},
	};
}

function pickDiagnosticsTimeout(detailed: boolean, timeoutSec: number): number {
	return detailed
		? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
		: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
}

export async function handleDiagnosticsAction(args: DiagnosticsActionParams): Promise<AgentToolResult<LspToolDetails>> {
	const { file, timeoutSec, params, action } = args;

	const resolvedTargets = await resolveDiagnosticTargets(file, args.cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
	const targets = resolvedTargets.matches;
	const truncatedGlobTargets = resolvedTargets.truncated;

	if (targets.length === 0) {
		return {
			content: [{ type: "text", text: `No files matched pattern: ${file}` }],
			details: { action, success: true, request: params },
		};
	}

	const detailed = targets.length > 1 || truncatedGlobTargets;
	const diagnosticsWaitTimeoutMs = pickDiagnosticsTimeout(detailed, timeoutSec);
	const allServerNames = new Set<string>();

	if (!detailed && targets.length === 1) {
		const resolved = resolveToCwd(targets[0], args.cwd);
		const servers = args.getServers(resolved);
		if (servers.length === 0) {
			return {
				content: [{ type: "text", text: `${theme.status.error} ${targets[0]}: No language server found` }],
				details: { action, success: true, request: params },
			};
		}
		return handleSingleFileDiagnostics(resolved, servers, args, allServerNames, diagnosticsWaitTimeoutMs);
	}

	const results: string[] = [];
	if (truncatedGlobTargets) {
		results.push(
			`${theme.status.warning} Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
		);
	}

	const targetOutputs = await processAllTargets({
		targets,
		cwd: args.cwd,
		signal: args.signal,
		getServers: args.getServers,
		allServerNames,
		diagnosticsWaitTimeoutMs,
	});
	results.push(...targetOutputs);

	return {
		content: [{ type: "text", text: results.join("\n") }],
		details: {
			action,
			serverName: Array.from(allServerNames).join(", "),
			success: true,
		},
	};
}

interface WorkspaceSymbolsArgs {
	servers: Array<[string, ServerConfig]>;
	cwd: string;
	signal: AbortSignal | undefined;
	normalizedQuery: string;
	params: LspParams;
}

interface SymbolQueryResult {
	serverName: string;
	symbols: SymbolInformation[];
}

async function querySymbolsFromServer(
	serverName: string,
	serverConfig: ServerConfig,
	cwd: string,
	signal: AbortSignal | undefined,
	normalizedQuery: string,
): Promise<SymbolQueryResult> {
	throwIfAborted(signal);
	const workspaceClient = await getOrCreateClient(serverConfig, cwd);
	const workspaceResult = (await sendRequest(
		workspaceClient,
		"workspace/symbol",
		{ query: normalizedQuery },
		signal,
	)) as SymbolInformation[] | null;
	if (!workspaceResult || workspaceResult.length === 0) {
		return { serverName, symbols: [] };
	}
	return {
		serverName,
		symbols: filterWorkspaceSymbols(workspaceResult, normalizedQuery),
	};
}

function isAbortedSignalCheck(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

async function aggregateSymbolQueries(args: WorkspaceSymbolsArgs): Promise<{
	aggregated: SymbolInformation[];
	respondingServers: Set<string>;
}> {
	const promises = args.servers.map(([name, config]) =>
		querySymbolsFromServer(name, config, args.cwd, args.signal, args.normalizedQuery),
	);
	const results = await Promise.allSettled(promises);
	const aggregated: SymbolInformation[] = [];
	const respondingServers = new Set<string>();
	for (const result of results) {
		if (result.status === "fulfilled") {
			if (result.value.symbols.length > 0) {
				respondingServers.add(result.value.serverName);
				aggregated.push(...result.value.symbols);
			}
		} else if (result.reason instanceof ToolAbortError || isAbortedSignalCheck(args.signal)) {
			throw result.reason instanceof Error ? result.reason : new ToolAbortError();
		}
	}
	return { aggregated, respondingServers };
}

export async function handleWorkspaceSymbols(args: WorkspaceSymbolsArgs): Promise<AgentToolResult<LspToolDetails>> {
	const { servers, normalizedQuery, params } = args;
	if (servers.length === 0) {
		return {
			content: [{ type: "text", text: "No language server found for this action" }],
			details: { action: "symbols", success: false, request: params },
		};
	}
	const { aggregated, respondingServers } = await aggregateSymbolQueries(args);
	const dedupedSymbols = dedupeWorkspaceSymbols(aggregated);
	if (dedupedSymbols.length === 0) {
		return {
			content: [{ type: "text", text: `No symbols matching "${normalizedQuery}"` }],
			details: {
				action: "symbols",
				serverName: Array.from(respondingServers).join(", "),
				success: true,
				request: params,
			},
		};
	}
	const limitedSymbols = dedupedSymbols.slice(0, WORKSPACE_SYMBOL_LIMIT);
	const lines = limitedSymbols.map(s => formatSymbolInformation(s, args.cwd));
	const truncationLine =
		dedupedSymbols.length > WORKSPACE_SYMBOL_LIMIT
			? `\n... ${dedupedSymbols.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
			: "";
	return {
		content: [
			{
				type: "text",
				text: `Found ${dedupedSymbols.length} symbol(s) matching "${normalizedQuery}":\n${lines.map(l => `  ${l}`).join("\n")}${truncationLine}`,
			},
		],
		details: {
			action: "symbols",
			serverName: Array.from(respondingServers).join(", "),
			success: true,
			request: params,
		},
	};
}

async function reloadOneServer(
	serverName: string,
	serverConfig: ServerConfig,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	try {
		const workspaceClient = await getOrCreateClient(serverConfig, cwd);
		return await reloadServer(workspaceClient, serverName, signal);
	} catch (error) {
		if (error instanceof ToolAbortError || isAbortedSignalCheck(signal)) {
			throw error;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		return `Failed to reload ${serverName}: ${errorMessage}`;
	}
}

export async function handleWorkspaceReload(
	servers: Array<[string, ServerConfig]>,
	cwd: string,
	signal: AbortSignal | undefined,
	params: LspParams,
): Promise<AgentToolResult<LspToolDetails>> {
	if (servers.length === 0) {
		return {
			content: [{ type: "text", text: "No language server found for this action" }],
			details: { action: "reload", success: false, request: params },
		};
	}
	throwIfAborted(signal);
	const outputs = await Promise.all(servers.map(([name, config]) => reloadOneServer(name, config, cwd, signal)));
	return {
		content: [{ type: "text", text: outputs.join("\n") }],
		details: {
			action: "reload",
			serverName: servers.map(([name]) => name).join(", "),
			success: true,
			request: params,
		},
	};
}

export interface FileActionContext {
	client: LspClient;
	uri: string;
	position: Position;
	targetFile: string | null;
	serverConfig: ServerConfig;
	serverName: string;
	cwd: string;
	signal: AbortSignal | undefined;
	session: ToolSession;
}

async function fetchLocations(ctx: FileActionContext, method: string): Promise<Location[]> {
	const result = (await sendRequest(
		ctx.client,
		method,
		{ textDocument: { uri: ctx.uri }, position: ctx.position },
		ctx.signal,
	)) as Location | Location[] | LocationLink | LocationLink[] | null;
	return normalizeLocationResult(result);
}

async function formatLocationsResponse(
	locations: Location[],
	cwd: string,
	emptyMessage: string,
	prefix: string,
): Promise<string> {
	if (locations.length === 0) {
		return emptyMessage;
	}
	const lines = await Promise.all(locations.map(location => formatLocationWithContext(location, cwd)));
	return `Found ${locations.length} ${prefix}:\n${lines.join("\n")}`;
}

export async function handleDefinitionAction(ctx: FileActionContext): Promise<string> {
	const locations = await fetchLocations(ctx, "textDocument/definition");
	return formatLocationsResponse(locations, ctx.cwd, "No definition found", "definition(s)");
}

export async function handleTypeDefinitionAction(ctx: FileActionContext): Promise<string> {
	const locations = await fetchLocations(ctx, "textDocument/typeDefinition");
	return formatLocationsResponse(locations, ctx.cwd, "No type definition found", "type definition(s)");
}

export async function handleImplementationAction(ctx: FileActionContext): Promise<string> {
	const locations = await fetchLocations(ctx, "textDocument/implementation");
	return formatLocationsResponse(locations, ctx.cwd, "No implementation found", "implementation(s)");
}

async function fetchReferencesOnce(ctx: FileActionContext): Promise<Location[] | null> {
	return (await sendRequest(
		ctx.client,
		"textDocument/references",
		{
			textDocument: { uri: ctx.uri },
			position: ctx.position,
			context: { includeDeclaration: true },
		},
		ctx.signal,
	)) as Location[] | null;
}

async function fetchReferencesWithRetry(ctx: FileActionContext, attempt: number): Promise<Location[] | null> {
	const result = await fetchReferencesOnce(ctx);
	const locations = result ?? [];
	if (!isProjectAwareLspServer(ctx.serverConfig) || attempt >= REFERENCES_RETRY_COUNT) {
		return result;
	}
	if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, ctx.uri, ctx.position)) {
		return result;
	}

	await waitForProjectLoaded(ctx.client, ctx.signal);
	throwIfAborted(ctx.signal);
	await untilAborted(ctx.signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
	return fetchReferencesWithRetry(ctx, attempt + 1);
}

export async function handleReferencesAction(ctx: FileActionContext): Promise<string> {
	const result = await fetchReferencesWithRetry(ctx, 0);

	if (!result || result.length === 0) {
		return "No references found";
	}
	const contextualReferences = result.slice(0, REFERENCE_CONTEXT_LIMIT);
	const plainReferences = result.slice(REFERENCE_CONTEXT_LIMIT);
	const contextualLines = await Promise.all(
		contextualReferences.map(location => formatLocationWithContext(location, ctx.cwd)),
	);
	const plainLines = plainReferences.map(location => `  ${formatLocation(location, ctx.cwd)}`);
	const lines = plainLines.length
		? [...contextualLines, `  ... ${plainLines.length} additional reference(s) shown without context`, ...plainLines]
		: contextualLines;
	return `Found ${result.length} reference(s):\n${lines.join("\n")}`;
}

export async function handleHoverAction(ctx: FileActionContext): Promise<string> {
	const result = (await sendRequest(
		ctx.client,
		"textDocument/hover",
		{ textDocument: { uri: ctx.uri }, position: ctx.position },
		ctx.signal,
	)) as Hover | null;

	const contents = result?.contents;
	if (contents === null || contents === undefined) {
		return "No hover information";
	}
	return extractHoverText(contents);
}

interface CodeActionRequestArgs {
	ctx: FileActionContext;
	apply: boolean | undefined;
	query: string | undefined;
}

async function fetchCodeActions(args: CodeActionRequestArgs): Promise<(CodeAction | Command)[] | null> {
	const { ctx, apply, query } = args;
	const diagnostics = ctx.client.diagnostics.get(ctx.uri)?.diagnostics ?? [];
	const queryProvided = query !== null && query !== undefined && query !== "";
	const context: CodeActionContext = {
		diagnostics,
		only: apply !== true && queryProvided ? [query] : undefined,
		triggerKind: 1,
	};

	return (await sendRequest(
		ctx.client,
		"textDocument/codeAction",
		{
			textDocument: { uri: ctx.uri },
			range: { start: ctx.position, end: ctx.position },
			context,
		},
		ctx.signal,
	)) as (CodeAction | Command)[] | null;
}

interface ApplyCodeActionArgs {
	ctx: FileActionContext;
	result: (CodeAction | Command)[];
	normalizedQuery: string;
}

function findCodeAction(result: (CodeAction | Command)[], normalizedQuery: string): CodeAction | Command | undefined {
	const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
	return result.find(
		(actionItem, index) =>
			(parsedIndex !== null && index === parsedIndex) ||
			actionItem.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
	);
}

function buildAppliedActionSummary(appliedAction: {
	title: string;
	edits: string[];
	executedCommands: string[];
}): string {
	const summaryLines: string[] = [];
	if (appliedAction.edits.length > 0) {
		summaryLines.push("  Workspace edit:");
		summaryLines.push(...appliedAction.edits.map(item => `    ${item}`));
	}
	if (appliedAction.executedCommands.length > 0) {
		summaryLines.push("  Executed command(s):");
		summaryLines.push(...appliedAction.executedCommands.map(commandName => `    ${commandName}`));
	}
	return `Applied "${appliedAction.title}":\n${summaryLines.join("\n")}`;
}

async function selectAndApplyCodeAction(args: ApplyCodeActionArgs): Promise<string> {
	const { ctx, result, normalizedQuery } = args;
	const selectedAction = findCodeAction(result, normalizedQuery);

	if (!selectedAction) {
		const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
		return `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
	}

	const appliedAction = await applyCodeAction(selectedAction, {
		resolveCodeAction: async actionItem =>
			(await sendRequest(ctx.client, "codeAction/resolve", actionItem, ctx.signal)) as CodeAction,
		applyWorkspaceEdit: async edit => applyWorkspaceEdit(edit, ctx.cwd),
		executeCommand: async commandItem => {
			await sendRequest(
				ctx.client,
				"workspace/executeCommand",
				{
					command: commandItem.command,
					arguments: commandItem.arguments ?? [],
				},
				ctx.signal,
			);
		},
	});

	if (!appliedAction) {
		return `Action "${selectedAction.title}" has no workspace edit or command to apply`;
	}
	return buildAppliedActionSummary(appliedAction);
}

export async function handleCodeActionsAction(args: CodeActionRequestArgs): Promise<string> {
	const result = await fetchCodeActions(args);
	if (!result || result.length === 0) {
		return "No code actions available";
	}

	const queryProvided = args.query !== null && args.query !== undefined && args.query !== "";
	if (args.apply === true && queryProvided) {
		const normalizedQuery = (args.query ?? "").trim();
		if (normalizedQuery.length === 0) {
			return "Error: query parameter required when apply=true for code_actions";
		}
		return selectAndApplyCodeAction({ ctx: args.ctx, result, normalizedQuery });
	}

	const actionLines = result.map((actionItem, index) => `  ${formatCodeAction(actionItem, index)}`);
	return `${result.length} code action(s):\n${actionLines.join("\n")}`;
}

export async function handleSymbolsAction(ctx: FileActionContext): Promise<string> {
	const targetFile = ctx.targetFile;
	if (targetFile === null || targetFile === undefined || targetFile === "") {
		return "Error: file parameter required for document symbols";
	}
	const result = (await sendRequest(
		ctx.client,
		"textDocument/documentSymbol",
		{ textDocument: { uri: ctx.uri } },
		ctx.signal,
	)) as (DocumentSymbol | SymbolInformation)[] | null;

	if (!result || result.length === 0) {
		return "No symbols found";
	}
	const relPath = formatPathRelativeToCwd(targetFile, ctx.cwd);
	if ("selectionRange" in result[0]) {
		const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
		return `Symbols in ${relPath}:\n${lines.join("\n")}`;
	}
	const lines = (result as SymbolInformation[]).map(s => {
		const line = s.location.range.start.line + 1;
		const icon = symbolKindToIcon(s.kind);
		return `${icon} ${s.name} @ line ${line}`;
	});
	return `Symbols in ${relPath}:\n${lines.join("\n")}`;
}

interface RenameArgs {
	ctx: FileActionContext;
	new_name: string;
	apply: boolean | undefined;
}

export async function handleRenameAction(args: RenameArgs): Promise<string> {
	const { ctx, new_name, apply } = args;
	const result = (await sendRequest(
		ctx.client,
		"textDocument/rename",
		{
			textDocument: { uri: ctx.uri },
			position: ctx.position,
			newName: new_name,
		},
		ctx.signal,
	)) as WorkspaceEdit | null;

	if (!result) {
		return "Rename returned no edits";
	}
	const shouldApply = apply !== false;
	if (shouldApply) {
		const applied = await applyWorkspaceEdit(result, ctx.cwd);
		return `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
	}
	const preview = formatWorkspaceEdit(result, ctx.cwd);
	return `Rename preview:\n${preview.map(p => `  ${p}`).join("\n")}`;
}

interface StatusActionArgs {
	cwd: string;
	servers: Record<string, ServerConfig>;
	params: LspParams;
}

function buildLspmuxStatus(state: { available: boolean; running: boolean }): string {
	if (!state.available) return "";
	return state.running ? "lspmux: active (multiplexing enabled)" : "lspmux: installed but server not running";
}

export async function handleStatusAction(args: StatusActionArgs): Promise<AgentToolResult<LspToolDetails>> {
	const servers = Object.keys(args.servers);
	const lspmuxState = await detectLspmux();
	const lspmuxStatus = buildLspmuxStatus(lspmuxState);

	const serverStatus =
		servers.length > 0
			? `Active language servers: ${servers.join(", ")}`
			: "No language servers configured for this project";

	const output = lspmuxStatus ? `${serverStatus}\n${lspmuxStatus}` : serverStatus;
	return {
		content: [{ type: "text", text: output }],
		details: { action: "status", success: true, request: args.params },
	};
}

interface PrepareFileActionArgs {
	resolvedFile: string;
	serverConfig: ServerConfig;
	serverName: string;
	line: number | undefined;
	symbol: string | undefined;
	cwd: string;
	signal: AbortSignal | undefined;
	session: ToolSession;
	action: string;
}

const CROSS_FILE_ACTIONS = new Set(["definition", "type_definition", "implementation", "references", "rename"]);

export async function prepareFileActionContext(args: PrepareFileActionArgs): Promise<FileActionContext> {
	const { resolvedFile, serverConfig, serverName, line, symbol, cwd, signal, session, action } = args;
	const client = await getOrCreateClient(serverConfig, cwd);
	await ensureFileOpen(client, resolvedFile, signal);

	const uri = fileToUri(resolvedFile);
	const resolvedLine = line ?? 1;
	const resolvedCharacter = await resolveSymbolColumn(resolvedFile, resolvedLine, symbol);
	const position = { line: resolvedLine - 1, character: resolvedCharacter };

	if (CROSS_FILE_ACTIONS.has(action)) {
		await waitForProjectLoaded(client, signal);
	}

	return {
		client,
		uri,
		position,
		targetFile: resolvedFile,
		serverConfig,
		serverName,
		cwd,
		signal,
		session,
	};
}
