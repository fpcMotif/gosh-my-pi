import * as fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger, once, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { type Theme } from "../modes/theme/theme";
import lspDescription from "../prompts/tools/lsp.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import {
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	notifySaved,
	sendRequest,
	setIdleTimeout,
	syncContent,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import { applyTextEditsToString } from "./edits";
import { renderCall, renderResult } from "./render";
import {
	type Diagnostic,
	type LspParams,
	type LspToolDetails,
	lspSchema,
	type ServerConfig,
	type TextEdit,
} from "./types";
import { fileToUri, formatDiagnostic, formatDiagnosticsSummary, sortDiagnostics } from "./utils";
import {
	handleCodeActionsAction,
	handleDefinitionAction,
	handleDiagnosticsAction,
	handleHoverAction,
	handleImplementationAction,
	handleReferencesAction,
	handleRenameAction,
	handleStatusAction,
	handleSymbolsAction,
	handleTypeDefinitionAction,
	handleWorkspaceReload,
	handleWorkspaceSymbols,
	prepareFileActionContext,
} from "./actions";
import { dedupeDiagnostics, isProjectAwareLspServer, reloadServer, waitForDiagnostics } from "./diagnostics-helpers";

export type { LspServerStatus } from "./client";
export type { LspToolDetails } from "./types";

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(cwd: string): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status: "connecting",
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const lspServers = getLspServers(config);

	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	return { servers: results.map((result, i) => buildWarmupServerEntry(result, lspServers[i])) };
}

function buildWarmupServerEntry(
	result: PromiseSettledResult<{ name: string; fileTypes: string[] }>,
	server: [string, ServerConfig],
): LspStartupServerInfo & { status: "ready" | "error" } {
	const [name, serverConfig] = server;
	if (result.status === "fulfilled") {
		return {
			name: result.value.name,
			status: "ready",
			fileTypes: result.value.fileTypes,
		};
	}
	const reason = result.reason as { message?: string } | undefined;
	const errorMsg = reason?.message ?? String(result.reason);
	logger.warn("LSP server failed to start", { server: name, error: errorMsg });
	return {
		name,
		status: "error",
		fileTypes: serverConfig.fileTypes,
		error: errorMsg,
	};
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

/**
 * Sync in-memory file content to all applicable LSP servers.
 */
async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
}

/**
 * Notify all LSP servers that a file was saved.
 */
async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd);
			await notifySaved(client, absolutePath, signal);
		}),
	);
}

// Cache config per cwd to avoid repeated file I/O
const configCache = new Map<string, LspConfig>();

function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

function splitServers(servers: Array<[string, ServerConfig]>): {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
} {
	const lspServers: Array<[string, ServerConfig]> = [];
	const customLinterServers: Array<[string, ServerConfig]> = [];
	for (const entry of servers) {
		if (isCustomLinter(entry[1])) {
			customLinterServers.push(entry);
		} else {
			lspServers.push(entry);
		}
	}
	return { lspServers, customLinterServers };
}

function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

function getLspServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	return getServersForFile(config, filePath).filter(([, serverConfig]) => !isCustomLinter(serverConfig));
}

function getLspServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getLspServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;

function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

/** Project type detection result */
interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

interface ProjectDetector {
	marker: string | string[];
	build: () => ProjectType;
}

const PROJECT_DETECTORS: ProjectDetector[] = [
	{
		marker: "Cargo.toml",
		build: () => ({
			type: "rust",
			command: ["cargo", "check", "--message-format=short"],
			description: "Rust (cargo check)",
		}),
	},
	{
		marker: "tsconfig.json",
		build: () => ({
			type: "typescript",
			command: ["npx", "--yes", "@typescript/native-preview", "--noEmit"],
			description: "TypeScript (tsgo --noEmit)",
		}),
	},
	{
		marker: "go.mod",
		build: () => ({
			type: "go",
			command: ["go", "build", "./..."],
			description: "Go (go build)",
		}),
	},
	{
		marker: ["pyproject.toml", "pyrightconfig.json"],
		build: () => ({ type: "python", command: ["pyright"], description: "Python (pyright)" }),
	},
];

/** Detect project type from root markers */
function detectProjectType(cwd: string): ProjectType {
	for (const detector of PROJECT_DETECTORS) {
		const markers = Array.isArray(detector.marker) ? detector.marker : [detector.marker];
		if (markers.some(m => fs.existsSync(path.join(cwd, m)))) {
			return detector.build();
		}
	}
	return { type: "unknown", description: "Unknown project type" };
}

/** Run workspace diagnostics command and parse output */
async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = detectProjectType(cwd);
	if (!projectType.command) {
		return {
			output:
				"Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)",
			projectType,
		};
	}
	const proc = Bun.spawn(projectType.command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const abortHandler = () => {
		proc.kill();
	};
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		throwIfAborted(signal);
		const combined = (stdout + stderr).trim();
		if (!combined) {
			return { output: "No issues found", projectType };
		}
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return {
				output: `${lines.slice(0, 50).join("\n")}\n... and ${lines.length - 50} more lines`,
				projectType,
			};
		}
		return { output: combined, projectType };
	} catch (error) {
		if (signal !== undefined && signal.aborted) {
			throw new ToolAbortError();
		}
		return {
			output: `Failed to run ${projectType.command.join(" ")}: ${String(error)}`,
			projectType,
		};
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

type ServerVersionMap = Map<string, number>;

interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	allowUnversionedLspDiagnostics?: boolean;
}

async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}

async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			const version = client.openFiles.get(uri)?.version;
			if (version !== undefined) {
				versions.set(serverName, version);
			}
		}),
	);
	return versions;
}

interface DiagnosticServerResult {
	serverName: string;
	diagnostics: Diagnostic[];
}

async function fetchServerDiagnostics(
	serverName: string,
	serverConfig: ServerConfig,
	uri: string,
	absolutePath: string,
	cwd: string,
	options: GetDiagnosticsForFileOptions,
): Promise<DiagnosticServerResult> {
	const { signal, minVersions, expectedDocumentVersions, allowUnversionedLspDiagnostics = true } = options;
	throwIfAborted(signal);
	if (serverConfig.createClient) {
		const linterClient = getLinterClient(serverName, serverConfig, cwd);
		const diagnostics = await linterClient.lint(absolutePath);
		return { serverName, diagnostics };
	}

	const client = await getOrCreateClient(serverConfig, cwd);
	throwIfAborted(signal);
	if (isProjectAwareLspServer(serverConfig)) {
		await waitForProjectLoaded(client, signal);
		throwIfAborted(signal);
	}
	const minVersion = minVersions?.get(serverName);
	const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
	const diagnostics = await waitForDiagnostics(client, uri, {
		timeoutMs: 3000,
		signal,
		minVersion,
		expectedDocumentVersion,
		allowUnversioned: allowUnversionedLspDiagnostics,
	});
	return { serverName, diagnostics };
}

async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	const results = await Promise.allSettled(
		servers.map(([serverName, serverConfig]) =>
			fetchServerDiagnostics(serverName, serverConfig, uri, absolutePath, cwd, options),
		),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(...result.value.diagnostics);
		}
	}

	if (serverNames.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
	}

	const uniqueDiagnostics = dedupeDiagnostics(allDiagnostics);
	sortDiagnostics(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited,
		summary,
		errored: hasErrors,
	};
}

export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}

/** Default formatting options for LSP */
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<string> {
	if (servers.length === 0) {
		return content;
	}

	const uri = fileToUri(absolutePath);

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				return await linterClient.format(absolutePath, content);
			}

			const client = await getOrCreateClient(serverConfig, cwd);
			throwIfAborted(signal);

			const caps = client.serverCapabilities;
			if (caps?.documentFormattingProvider === null || caps?.documentFormattingProvider === undefined) {
				continue;
			}

			const edits = (await sendRequest(
				client,
				"textDocument/formatting",
				{ textDocument: { uri }, options: DEFAULT_FORMAT_OPTIONS },
				signal,
			)) as TextEdit[] | null;

			if (!edits || edits.length === 0) {
				return content;
			}

			return applyTextEditsToString(content, edits);
		} catch (error) {
			if (error instanceof ToolAbortError || signal?.aborted) {
				throw error;
			}
		}
	}

	return content;
}

/** Options for creating the LSP writethrough callback */
export interface WritethroughOptions {
	/** Whether to format the file using LSP after writing */
	enableFormat?: boolean;
	/** Whether to get LSP diagnostics after writing */
	enableDiagnostics?: boolean;
	/** Called when diagnostics arrive after the main timeout. */
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	/** Signal to cancel a pending deferred diagnostics fetch. */
	deferredSignal?: AbortSignal;
}

/** Internal resolved form of {@link WritethroughOptions}. */
type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
};

/** Per-file deferred LSP diagnostics wiring. */
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (file) {
		await file.write(content);
	} else {
		await Bun.write(dst, content);
	}
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}

interface DiagnosticAccumulator {
	messages: string[];
	servers: Set<string>;
	hasResults: boolean;
	hasFormatter: boolean;
	formatted: boolean;
}

function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const message of messages) {
		const match = message.match(/\[(error|warning|info|hint)\]/i);
		if (!match) continue;
		const key = match[1].toLowerCase() as keyof typeof counts;
		counts[key] += 1;
	}

	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);

	return {
		summary: parts.length > 0 ? parts.join(", ") : "no issues",
		errored: counts.error > 0,
	};
}

function addServersFromString(target: Set<string>, serverString: string): void {
	for (const server of serverString.split(",")) {
		const trimmed = server.trim();
		if (trimmed) {
			target.add(trimmed);
		}
	}
}

function accumulateResult(acc: DiagnosticAccumulator, result: FileDiagnosticsResult): void {
	acc.hasResults = true;
	if (result.server !== null && result.server !== undefined && result.server !== "") {
		addServersFromString(acc.servers, result.server);
	}
	if (result.messages.length > 0) {
		acc.messages.push(...result.messages);
	}
	if (result.formatter !== undefined) {
		acc.hasFormatter = true;
		if (result.formatter === FileFormatResult.FORMATTED) {
			acc.formatted = true;
		}
	}
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const acc: DiagnosticAccumulator = {
		messages: [],
		servers: new Set<string>(),
		hasResults: false,
		hasFormatter: false,
		formatted: false,
	};

	for (const result of results) {
		if (result) {
			accumulateResult(acc, result);
		}
	}

	if (!acc.hasResults && !acc.hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = acc.messages;
	if (acc.messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(acc.messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(acc.messages);
	}
	let formatter: FileFormatResult | undefined;
	if (acc.hasFormatter) {
		formatter = acc.formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
	}

	return {
		server: acc.servers.size > 0 ? Array.from(acc.servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

interface ScheduleDeferredArgs {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}

async function scheduleDeferredDiagnosticsFetch(args: ScheduleDeferredArgs): Promise<void> {
	try {
		const deferredTimeout = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([args.signal, deferredTimeout]);
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: combined,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {
		// Cancelled or LSP gave up; silently discard.
	}
}

interface RunWritethroughArgs {
	dst: string;
	content: string;
	cwd: string;
	options: ResolvedWritethroughOptions;
	signal?: AbortSignal;
	file?: BunFile;
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	};
}

interface FormatStageResult {
	finalContent: string;
	formatter: FileFormatResult | undefined;
}

async function applyCustomFormat(
	args: RunWritethroughArgs,
	customLinterServers: Array<[string, ServerConfig]>,
	lspServers: Array<[string, ServerConfig]>,
	operationSignal: AbortSignal,
): Promise<FormatStageResult> {
	const { dst, content, cwd, file } = args;
	const writeContent = async (value: string) => (file ? file.write(value) : Bun.write(dst, value));
	await writeContent(content);
	const finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal);
	const formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
	await writeContent(finalContent);
	await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
	return { finalContent, formatter };
}

async function applyLspFormat(
	args: RunWritethroughArgs,
	lspServers: Array<[string, ServerConfig]>,
	operationSignal: AbortSignal,
): Promise<FormatStageResult> {
	const { dst, content, cwd, options } = args;
	await syncFileContent(dst, content, cwd, lspServers, operationSignal);

	let finalContent = content;
	let formatter: FileFormatResult | undefined;
	if (options.enableFormat) {
		finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal);
		formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
	}

	if (finalContent !== content) {
		await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
	}

	return { finalContent, formatter };
}

interface WritethroughExecutionState {
	formatter: FileFormatResult | undefined;
	diagnostics: FileDiagnosticsResult | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	timedOut: boolean;
}

async function executeWritethroughCore(
	args: RunWritethroughArgs,
	servers: Array<[string, ServerConfig]>,
	lspServers: Array<[string, ServerConfig]>,
	customLinterServers: Array<[string, ServerConfig]>,
	useCustomFormatter: boolean,
	minVersions: ServerVersionMap | undefined,
	getWritePromise: () => Promise<unknown>,
	state: WritethroughExecutionState,
): Promise<void> {
	const { dst, cwd, options, signal } = args;
	const timeoutSignal = AbortSignal.timeout(5_000);
	timeoutSignal.addEventListener(
		"abort",
		() => {
			state.timedOut = true;
		},
		{ once: true },
	);
	const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	await untilAborted(operationSignal, async () => {
		const formatResult = useCustomFormatter
			? await applyCustomFormat(args, customLinterServers, lspServers, operationSignal)
			: await applyLspFormat(args, lspServers, operationSignal);
		state.formatter = formatResult.formatter;

		if (!useCustomFormatter) {
			await getWritePromise();
		}

		if (options.enableDiagnostics) {
			state.expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers);
		}

		await notifyFileSaved(dst, cwd, lspServers, operationSignal);

		if (options.enableDiagnostics) {
			state.diagnostics = await getDiagnosticsForFile(dst, cwd, servers, {
				signal: operationSignal,
				minVersions,
				expectedDocumentVersions: state.expectedDocumentVersions,
				allowUnversionedLspDiagnostics: false,
			});
		}
	});
}

async function runLspWritethrough(args: RunWritethroughArgs): Promise<FileDiagnosticsResult | undefined> {
	const { dst, content, cwd, options, signal, file, deferred } = args;
	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);
	if (servers.length === 0) {
		return writethroughNoop(dst, content, signal, file);
	}
	const { lspServers, customLinterServers } = splitServers(servers);

	const writeContent = async (value: string) => (file ? file.write(value) : Bun.write(dst, value));
	const getWritePromise = once(() => writeContent(content));
	const useCustomFormatter = options.enableFormat && customLinterServers.length > 0;

	const minVersions = options.enableDiagnostics ? await captureDiagnosticVersions(cwd, servers) : undefined;

	const state: WritethroughExecutionState = {
		formatter: undefined,
		diagnostics: undefined,
		expectedDocumentVersions: undefined,
		timedOut: false,
	};

	try {
		await executeWritethroughCore(
			args,
			servers,
			lspServers,
			customLinterServers,
			useCustomFormatter,
			minVersions,
			getWritePromise,
			state,
		);
	} catch {
		if (state.timedOut) {
			state.formatter = undefined;
			state.diagnostics = undefined;
			if (deferred && !deferred.signal.aborted && options.enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions: state.expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await getWritePromise();
	}

	if (state.formatter !== undefined) {
		state.diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		state.diagnostics.formatter = state.formatter;
	}

	return state.diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		const deferredInner = bundle
			? ({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const)
			: undefined;
		const diag = await runLspWritethrough({
			dst: entry.dst,
			content: entry.content,
			cwd,
			options,
			signal,
			file: entry.file,
			deferred: deferredInner,
		});
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
	};
	if (!resolvedOptions.enableFormat && !resolvedOptions.enableDiagnostics) {
		return writethroughNoop;
	}
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner = bundle
				? ({
						onDeferredDiagnostics: bundle.onDeferredDiagnostics,
						signal: bundle.signal,
					} as const)
				: undefined;
			const diagnostics = await runLspWritethrough({
				dst,
				content,
				cwd,
				options: resolvedOptions,
				signal,
				file,
				deferred: deferredInner,
			});
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, content, file });

		if (!batch.flush) {
			await writethroughNoop(dst, content, signal, file);
			return undefined;
		}

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}

interface ExecuteFileActionParams {
	action:
		| "definition"
		| "type_definition"
		| "implementation"
		| "references"
		| "hover"
		| "code_actions"
		| "symbols"
		| "rename"
		| "reload";
	resolvedFile: string;
	serverInfo: [string, ServerConfig];
	params: LspParams;
	signal: AbortSignal | undefined;
	session: ToolSession;
}

async function dispatchFileAction(args: ExecuteFileActionParams): Promise<string> {
	const { action, resolvedFile, serverInfo, params, signal, session } = args;
	const [serverName, serverConfig] = serverInfo;
	const ctx = await prepareFileActionContext({
		resolvedFile,
		serverConfig,
		serverName,
		line: params.line,
		symbol: params.symbol,
		cwd: session.cwd,
		signal,
		session,
		action,
	});

	switch (action) {
		case "definition":
			return handleDefinitionAction(ctx);
		case "type_definition":
			return handleTypeDefinitionAction(ctx);
		case "implementation":
			return handleImplementationAction(ctx);
		case "references":
			return handleReferencesAction(ctx);
		case "hover":
			return handleHoverAction(ctx);
		case "code_actions":
			return handleCodeActionsAction({ ctx, apply: params.apply, query: params.query });
		case "symbols":
			return handleSymbolsAction(ctx);
		case "rename":
			return handleRenameAction({
				ctx,
				new_name: params.new_name ?? "",
				apply: params.apply,
			});
		case "reload":
			return reloadServer(ctx.client, serverName, signal);
		default:
			return `Unknown action: ${String(action)}`;
	}
}

function isFileRequiredForAction(action: string, file: string | undefined): boolean {
	const isEmpty = file === null || file === undefined || file === "";
	return isEmpty && action !== "reload";
}

/**
 * LSP tool for language server protocol operations.
 */
export class LspTool implements AgentTool<typeof lspSchema, LspToolDetails, Theme> {
	readonly name = "lsp";
	readonly label = "LSP";
	readonly description: string;
	readonly parameters = lspSchema;
	readonly renderCall = renderCall;
	readonly renderResult = renderResult;
	readonly mergeCallAndResult = true;
	readonly inline = true;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(lspDescription);
	}

	static createIf(session: ToolSession): LspTool | null {
		return session.enableLsp === false ? null : new LspTool(session);
	}

	async execute(
		_toolCallId: string,
		params: LspParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LspToolDetails>> {
		const { action, file, query, new_name, apply, timeout } = params;
		const timeoutSec = clampTimeout("lsp", timeout);
		const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
		const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		throwIfAborted(effectiveSignal);

		const config = getConfig(this.session.cwd);

		if (action === "status") {
			return handleStatusAction({ cwd: this.session.cwd, servers: config.servers, params });
		}

		if (action === "diagnostics") {
			return this.handleDiagnostics(file, params, timeoutSec, effectiveSignal, config);
		}

		const isWorkspace = file === "*";

		if (isFileRequiredForAction(action, file)) {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace scope where supported.",
					},
				],
				details: { action, success: false },
			};
		}

		const fileSpecified = file !== null && file !== undefined && file !== "";
		const resolvedFile = fileSpecified && !isWorkspace ? resolveToCwd(file, this.session.cwd) : null;

		if (action === "symbols" && (isWorkspace || resolvedFile === null)) {
			const normalizedQuery = query?.trim() ?? "";
			if (normalizedQuery === "") {
				return {
					content: [{ type: "text", text: "Error: query parameter required for workspace symbol search" }],
					details: { action, success: false, request: params },
				};
			}
			return handleWorkspaceSymbols({
				servers: getLspServers(config),
				cwd: this.session.cwd,
				signal: effectiveSignal,
				normalizedQuery,
				params,
			});
		}

		if (action === "reload" && (isWorkspace || resolvedFile === null)) {
			return handleWorkspaceReload(getLspServers(config), this.session.cwd, effectiveSignal, params);
		}

		const serverInfo = resolvedFile !== null ? getLspServerForFile(config, resolvedFile) : null;
		if (!serverInfo || resolvedFile === null) {
			return {
				content: [{ type: "text", text: "No language server found for this action" }],
				details: { action, success: false },
			};
		}

		return this.executeFileAction({
			action,
			resolvedFile,
			serverInfo,
			params: { ...params, query, new_name, apply },
			signal: effectiveSignal,
			session: this.session,
		});
	}

	private async handleDiagnostics(
		file: string | undefined,
		params: LspParams,
		timeoutSec: number,
		signal: AbortSignal,
		config: LspConfig,
	): Promise<AgentToolResult<LspToolDetails>> {
		if (file === "*") {
			const result = await runWorkspaceDiagnostics(this.session.cwd, signal);
			return {
				content: [
					{
						type: "text",
						text: `Workspace diagnostics (${result.projectType.description}):\n${result.output}`,
					},
				],
				details: { action: "diagnostics", success: true, request: params },
			};
		}

		if (file === null || file === undefined || file === "") {
			return {
				content: [
					{
						type: "text",
						text: "Error: file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
					},
				],
				details: { action: "diagnostics", success: false, request: params },
			};
		}

		return handleDiagnosticsAction({
			action: "diagnostics",
			file,
			timeoutSec,
			cwd: this.session.cwd,
			signal,
			getServers: filePath => getServersForFile(config, filePath),
			params,
		});
	}

	private async executeFileAction(args: ExecuteFileActionParams): Promise<AgentToolResult<LspToolDetails>> {
		const { action, params, serverInfo } = args;
		const [serverName] = serverInfo;
		try {
			if (action === "rename") {
				const newName = params.new_name ?? "";
				if (newName === "") {
					return {
						content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
						details: { action, serverName, success: false },
					};
				}
			}

			const output = await dispatchFileAction(args);
			return {
				content: [{ type: "text", text: output }],
				details: { serverName, action, success: true, request: params },
			};
		} catch (error) {
			if (error instanceof ToolAbortError || args.signal?.aborted) {
				throw new ToolAbortError();
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `LSP error: ${errorMessage}` }],
				details: { serverName, action, success: false, request: params },
			};
		}
	}
}
