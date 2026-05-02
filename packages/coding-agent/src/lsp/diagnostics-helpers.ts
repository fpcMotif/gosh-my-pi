import { type Theme, theme } from "../modes/theme/theme";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { getOrCreateClient, refreshFile, sendRequest, waitForProjectLoaded } from "./client";
import { getLinterClient } from "./clients";
import { type Diagnostic, type LspClient, type ServerConfig } from "./types";
import {
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatGroupedDiagnosticMessages,
	sortDiagnostics,
} from "./utils";

interface PublishedDiagnosticsLike {
	diagnostics: Diagnostic[];
	version: number | null;
}

function getAcceptedDiagnostics(
	publishedDiagnostics: PublishedDiagnosticsLike | undefined,
	expectedDocumentVersion?: number,
	allowUnversioned = true,
): Diagnostic[] | undefined {
	if (!publishedDiagnostics) {
		return undefined;
	}
	if (expectedDocumentVersion === undefined) {
		return publishedDiagnostics.diagnostics;
	}
	if (publishedDiagnostics.version === expectedDocumentVersion) {
		return publishedDiagnostics.diagnostics;
	}
	if (allowUnversioned && publishedDiagnostics.version === null) {
		return publishedDiagnostics.diagnostics;
	}
	return undefined;
}

export interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	allowUnversioned?: boolean;
}

interface PollAttemptResult {
	done: boolean;
	value?: Diagnostic[];
}

function pollOnce(client: LspClient, uri: string, options: WaitForDiagnosticsOptions): PollAttemptResult {
	const { signal, minVersion, expectedDocumentVersion, allowUnversioned = true } = options;
	throwIfAborted(signal);
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	const diagnostics = getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned);
	if (diagnostics !== undefined && versionOk) {
		return { done: true, value: diagnostics };
	}
	return { done: false };
}

async function pollLoop(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions,
	timeoutMs: number,
): Promise<Diagnostic[] | undefined> {
	const start = Date.now();
	const attempt = (): PollAttemptResult => pollOnce(client, uri, options);
	const step = async (): Promise<Diagnostic[] | undefined> => {
		if (Date.now() - start >= timeoutMs) return undefined;
		const result = attempt();
		if (result.done) return result.value;
		await Bun.sleep(100);
		return step();
	};
	return step();
}

export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, minVersion, expectedDocumentVersion, allowUnversioned = true } = options;
	const value = await pollLoop(client, uri, options, timeoutMs);
	if (value !== undefined) return value;

	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned) ?? [];
}

const RELOAD_METHODS = ["rust-analyzer/reloadWorkspace", "workspace/didChangeConfiguration"];

async function tryReloadMethod(client: LspClient, method: string, signal: AbortSignal | undefined): Promise<boolean> {
	try {
		await sendRequest(client, method, method.includes("Configuration") ? { settings: {} } : null, signal);
		return true;
	} catch {
		return false;
	}
}

async function tryReloadMethodsRecursive(
	client: LspClient,
	methods: readonly string[],
	signal: AbortSignal | undefined,
	index: number,
): Promise<boolean> {
	if (index >= methods.length) return false;
	const succeeded = await tryReloadMethod(client, methods[index], signal);
	if (succeeded) return true;
	return tryReloadMethodsRecursive(client, methods, signal, index + 1);
}

export async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	const reloaded = await tryReloadMethodsRecursive(client, RELOAD_METHODS, signal, 0);
	if (reloaded) {
		return `Reloaded ${serverName}`;
	}
	client.proc.kill();
	return `Restarted ${serverName}`;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && serverConfig.isLinter !== true;
}

export function dedupeDiagnostics(allDiagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const unique: Diagnostic[] = [];
	for (const d of allDiagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(d);
		}
	}
	return unique;
}

interface CollectFileDiagnosticsArgs {
	servers: Array<[string, ServerConfig]>;
	target: string;
	resolved: string;
	uri: string;
	cwd: string;
	signal: AbortSignal | undefined;
	diagnosticsWaitTimeoutMs: number;
	allServerNames: Set<string>;
}

async function collectDiagnosticsForServer(
	serverName: string,
	serverConfig: ServerConfig,
	args: CollectFileDiagnosticsArgs,
): Promise<Diagnostic[]> {
	const { resolved, uri, cwd, signal, diagnosticsWaitTimeoutMs } = args;
	throwIfAborted(signal);
	if (serverConfig.createClient) {
		const linterClient = getLinterClient(serverName, serverConfig, cwd);
		return linterClient.lint(resolved);
	}
	const client = await getOrCreateClient(serverConfig, cwd);
	if (isProjectAwareLspServer(serverConfig)) {
		await waitForProjectLoaded(client, signal);
		throwIfAborted(signal);
	}
	const minVersion = client.diagnosticsVersion;
	await refreshFile(client, resolved, signal);
	const expectedDocumentVersion = client.openFiles.get(uri)?.version;
	return waitForDiagnostics(client, uri, {
		timeoutMs: diagnosticsWaitTimeoutMs,
		signal,
		minVersion,
		expectedDocumentVersion,
	});
}

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

async function collectFileDiagnostics(args: CollectFileDiagnosticsArgs): Promise<Diagnostic[]> {
	const results = await Promise.allSettled(
		args.servers.map(([serverName, serverConfig]) => {
			args.allServerNames.add(serverName);
			return collectDiagnosticsForServer(serverName, serverConfig, args);
		}),
	);

	const allDiagnostics: Diagnostic[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			allDiagnostics.push(...result.value);
		} else if (result.reason instanceof ToolAbortError || isAbortedSignal(args.signal)) {
			throw result.reason instanceof Error ? result.reason : new ToolAbortError();
		}
	}
	return allDiagnostics;
}

interface DiagnosticTargetResult {
	output: string[];
	hasDiagnostics: boolean;
}

interface ProcessTargetArgs {
	target: string;
	cwd: string;
	signal: AbortSignal | undefined;
	getServers: (filePath: string) => Array<[string, ServerConfig]>;
	allServerNames: Set<string>;
	diagnosticsWaitTimeoutMs: number;
}

async function processTargetForDiagnostics(args: ProcessTargetArgs): Promise<DiagnosticTargetResult> {
	const { target, cwd, signal, getServers, allServerNames, diagnosticsWaitTimeoutMs } = args;
	throwIfAborted(signal);
	const resolved = resolveToCwd(target, cwd);
	const servers = getServers(resolved);
	if (servers.length === 0) {
		return {
			output: [`${theme.status.error} ${target}: No language server found`],
			hasDiagnostics: false,
		};
	}

	const uri = fileToUri(resolved);
	const relPath = formatPathRelativeToCwd(resolved, cwd);
	const allDiagnostics = await collectFileDiagnostics({
		servers,
		target,
		resolved,
		uri,
		cwd,
		signal,
		diagnosticsWaitTimeoutMs,
		allServerNames,
	});

	const uniqueDiagnostics = dedupeDiagnostics(allDiagnostics);
	sortDiagnostics(uniqueDiagnostics);

	if (uniqueDiagnostics.length === 0) {
		return {
			output: [`${theme.status.success} ${relPath}: no issues`],
			hasDiagnostics: false,
		};
	}
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	return {
		output: [`${theme.status.error} ${relPath}: ${summary}`, formatGroupedDiagnosticMessages(formatted)],
		hasDiagnostics: true,
	};
}

export interface ProcessAllTargetsArgs {
	targets: readonly string[];
	cwd: string;
	signal: AbortSignal | undefined;
	getServers: (filePath: string) => Array<[string, ServerConfig]>;
	allServerNames: Set<string>;
	diagnosticsWaitTimeoutMs: number;
}

export async function processAllTargets(args: ProcessAllTargetsArgs): Promise<string[]> {
	const promises = args.targets.map(target =>
		processTargetForDiagnostics({
			target,
			cwd: args.cwd,
			signal: args.signal,
			getServers: args.getServers,
			allServerNames: args.allServerNames,
			diagnosticsWaitTimeoutMs: args.diagnosticsWaitTimeoutMs,
		}),
	);
	const results = await Promise.all(promises);
	return results.flatMap(r => r.output);
}

export interface CollectFileDiagnosticsExtArgs {
	servers: Array<[string, ServerConfig]>;
	resolved: string;
	uri: string;
	cwd: string;
	signal: AbortSignal | undefined;
	diagnosticsWaitTimeoutMs: number;
	allServerNames: Set<string>;
}

export async function collectFileDiagnosticsExternal(args: CollectFileDiagnosticsExtArgs): Promise<Diagnostic[]> {
	return collectFileDiagnostics({
		...args,
		target: args.resolved,
	});
}

export type ThemeRef = Theme;
