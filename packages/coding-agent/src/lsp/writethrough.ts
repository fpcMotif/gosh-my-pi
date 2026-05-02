import { once, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { getOrCreateClient, notifySaved, sendRequest, syncContent } from "./client";
import { getLinterClient } from "./clients";
import { type LspConfig, getServersForFile } from "./config";
import { applyTextEditsToString } from "./edits";
import type { ServerConfig, TextEdit } from "./types";
import { fileToUri } from "./utils";

export type ServerVersionMap = Map<string, number>;

export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}

export interface FileDiagnosticsResult {
	server?: string;
	messages: string[];
	summary: string;
	errored: boolean;
	formatter?: FileFormatResult;
}

export interface WritethroughOptions {
	enableFormat?: boolean;
	enableDiagnostics?: boolean;
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	deferredSignal?: AbortSignal;
}

export type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
};

export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

export interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

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

const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 3,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted;
}

interface FormatAttemptResult {
	done: boolean;
	value?: string;
}

async function attemptFormatWithServer(
	serverName: string,
	serverConfig: ServerConfig,
	uri: string,
	absolutePath: string,
	content: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<FormatAttemptResult> {
	throwIfAborted(signal);
	if (serverConfig.createClient) {
		const linterClient = getLinterClient(serverName, serverConfig, cwd);
		const formatted = await linterClient.format(absolutePath, content);
		return { done: true, value: formatted };
	}

	const client = await getOrCreateClient(serverConfig, cwd);
	throwIfAborted(signal);

	const caps = client.serverCapabilities;
	if (caps?.documentFormattingProvider === null || caps?.documentFormattingProvider === undefined) {
		return { done: false };
	}

	const edits = (await sendRequest(
		client,
		"textDocument/formatting",
		{ textDocument: { uri }, options: DEFAULT_FORMAT_OPTIONS },
		signal,
	)) as TextEdit[] | null;

	if (!edits || edits.length === 0) {
		return { done: true, value: content };
	}

	return { done: true, value: applyTextEditsToString(content, edits) };
}

async function tryFormatRecursive(
	servers: Array<[string, ServerConfig]>,
	index: number,
	uri: string,
	absolutePath: string,
	content: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	if (index >= servers.length) return content;
	const [serverName, serverConfig] = servers[index];
	try {
		const attempt = await attemptFormatWithServer(serverName, serverConfig, uri, absolutePath, content, cwd, signal);
		if (attempt.done) return attempt.value ?? content;
	} catch (error) {
		if (error instanceof ToolAbortError || isAbortedSignal(signal)) {
			throw error;
		}
	}
	return tryFormatRecursive(servers, index + 1, uri, absolutePath, content, cwd, signal);
}

export async function formatContent(
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
	return tryFormatRecursive(servers, 0, uri, absolutePath, content, cwd, signal);
}

export async function syncFileContent(
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

export async function notifyFileSaved(
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

export async function captureDiagnosticVersions(
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

export async function captureOpenFileVersions(
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

const DIAGNOSTIC_MESSAGE_LIMIT = 50;

function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
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

export function mergeDiagnostics(
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

export interface SplitServersResult {
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
}

export function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

export function splitServers(servers: Array<[string, ServerConfig]>): SplitServersResult {
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

interface ScheduleDeferredArgs {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
	getDiagnostics: GetDiagnosticsFn;
}

export type GetDiagnosticsFn = (
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: {
		signal?: AbortSignal;
		minVersions?: ServerVersionMap;
		expectedDocumentVersions?: ServerVersionMap;
		allowUnversionedLspDiagnostics?: boolean;
	},
) => Promise<FileDiagnosticsResult | undefined>;

async function scheduleDeferredDiagnosticsFetch(args: ScheduleDeferredArgs): Promise<void> {
	try {
		const deferredTimeout = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([args.signal, deferredTimeout]);
		const diagnostics = await args.getDiagnostics(args.dst, args.cwd, args.servers, {
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

export interface RunWritethroughArgs {
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
	getDiagnostics: GetDiagnosticsFn;
}

interface FormatStageResult {
	finalContent: string;
	formatter: FileFormatResult | undefined;
}

function classifyFormatResult(formatted: string, original: string): FileFormatResult {
	return formatted === original ? FileFormatResult.UNCHANGED : FileFormatResult.FORMATTED;
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
	const formatter = classifyFormatResult(finalContent, content);
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
		formatter = classifyFormatResult(finalContent, content);
	}

	if (finalContent === content) {
		return { finalContent, formatter };
	}

	await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
	return { finalContent, formatter };
}

interface WritethroughExecutionState {
	formatter: FileFormatResult | undefined;
	diagnostics: FileDiagnosticsResult | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	timedOut: boolean;
}

interface ExecuteCoreArgs {
	args: RunWritethroughArgs;
	servers: Array<[string, ServerConfig]>;
	lspServers: Array<[string, ServerConfig]>;
	customLinterServers: Array<[string, ServerConfig]>;
	useCustomFormatter: boolean;
	minVersions: ServerVersionMap | undefined;
	getWritePromise: () => Promise<unknown>;
	state: WritethroughExecutionState;
}

async function executeWritethroughCore(execArgs: ExecuteCoreArgs): Promise<void> {
	const { args, servers, lspServers, customLinterServers, useCustomFormatter, minVersions, getWritePromise, state } =
		execArgs;
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
			state.diagnostics = await args.getDiagnostics(dst, cwd, servers, {
				signal: operationSignal,
				minVersions,
				expectedDocumentVersions: state.expectedDocumentVersions,
				allowUnversionedLspDiagnostics: false,
			});
		}
	});
}

function maybeScheduleDeferred(
	args: RunWritethroughArgs,
	state: WritethroughExecutionState,
	servers: Array<[string, ServerConfig]>,
	minVersions: ServerVersionMap | undefined,
): void {
	const { deferred, options, dst, cwd } = args;
	if (!deferred || deferred.signal.aborted || !options.enableDiagnostics) return;
	void scheduleDeferredDiagnosticsFetch({
		dst,
		cwd,
		servers,
		minVersions,
		expectedDocumentVersions: state.expectedDocumentVersions,
		signal: deferred.signal,
		callback: deferred.onDeferredDiagnostics,
		getDiagnostics: args.getDiagnostics,
	});
}

export async function runLspWritethrough(args: RunWritethroughArgs): Promise<FileDiagnosticsResult | undefined> {
	const { dst, content, cwd, options, signal, file } = args;
	const config = getConfigSafe(cwd, args.getConfig);
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
		await executeWritethroughCore({
			args,
			servers,
			lspServers,
			customLinterServers,
			useCustomFormatter,
			minVersions,
			getWritePromise,
			state,
		});
	} catch {
		if (state.timedOut) {
			state.formatter = undefined;
			state.diagnostics = undefined;
			maybeScheduleDeferred(args, state, servers, minVersions);
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

declare module "./writethrough" {
	interface RunWritethroughArgs {
		getConfig?: (cwd: string) => LspConfig;
	}
}

function getConfigSafe(cwd: string, resolver: ((cwd: string) => LspConfig) | undefined): LspConfig {
	if (resolver) return resolver(cwd);
	throw new Error("getConfig resolver not provided");
}

interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

export function getOrCreateWritethroughBatch(
	id: string,
	options: ResolvedWritethroughOptions,
): LspWritethroughBatchState {
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

export function deleteWritethroughBatch(id: string): void {
	writethroughBatches.delete(id);
}

export function getWritethroughBatch(id: string): LspWritethroughBatchState | undefined {
	return writethroughBatches.get(id);
}

interface FlushBatchArgs {
	batch: PendingWritethrough[];
	cwd: string;
	options: ResolvedWritethroughOptions;
	signal?: AbortSignal;
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined;
	getDiagnostics: GetDiagnosticsFn;
	getConfig: (cwd: string) => LspConfig;
}

async function flushOneEntry(
	entry: PendingWritethrough,
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal: AbortSignal | undefined,
	getDeferred: ((dst: string) => WritethroughDeferredHandle | undefined) | undefined,
	getDiagnostics: GetDiagnosticsFn,
	getConfig: (cwd: string) => LspConfig,
): Promise<FileDiagnosticsResult | undefined> {
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
		getDiagnostics,
		getConfig,
	});
	bundle?.finalize(diag);
	return diag;
}

export async function flushWritethroughBatch(args: FlushBatchArgs): Promise<FileDiagnosticsResult | undefined> {
	const { batch, cwd, options, signal, getDeferred, getDiagnostics, getConfig } = args;
	if (batch.length === 0) {
		return undefined;
	}
	const promises = batch.map(entry =>
		flushOneEntry(entry, cwd, options, signal, getDeferred, getDiagnostics, getConfig),
	);
	const results = await Promise.all(promises);
	return mergeDiagnostics(results, options);
}
