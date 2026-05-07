/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Wire vocabulary: omp-rpc/v1 (see ./wire/README.md). Outbound events are
 * translated through ./wire/translate.ts; internal-only events are dropped.
 * Commands are documented as v1 by reference (see rpc-types.ts).
 *
 * Protocol:
 * - Handshake: server emits {type: "ready", schema: "omp-rpc/v1"} on startup
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: WireEventV1 (10 variants), translated from internal AgentSessionEvent
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { $env, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import { runExtensionCompact, runExtensionSetModel } from "../../extensibility/extensions/compact-handler";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import type { OAuthProviderId } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { formatModelString, parseModelString } from "../../config/model-resolver";
import { getKnownRoleIds } from "../../config/model-registry";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { RequestCorrelator } from "./request-correlator";
import { RpcOAuthController } from "./rpc-oauth-controller";
import { AuthMethod } from "./rpc-types";
import type {
	RpcModelCatalog,
	RpcModelCatalogEntry,
	RpcModelCatalogRole,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types";
import { toWireEvent } from "./wire/translate";
import { OMP_RPC_SCHEMA_V1, type WireFrame } from "./wire/v1";

// Re-export types for consumers
export type * from "./rpc-types";

type RpcOutput = (frame: WireFrame) => void;

type AuthProviderMetadata = {
	id: string;
	name: string;
	available: boolean;
};

const BUILTIN_AUTH_PROVIDERS: readonly AuthProviderMetadata[] = [
	{ id: "openai-codex", name: "OpenAI Codex", available: true },
	{ id: "kimi", name: "Kimi", available: true },
	{ id: "moonshot", name: "Moonshot", available: true },
	{ id: "zai", name: "zAI", available: true },
	{ id: "kagi", name: "Kagi", available: true },
	{ id: "parallel", name: "Parallel", available: true },
	{ id: "tavily", name: "Tavily", available: true },
	{ id: "minimax-code", name: "MiniMax Code", available: true },
];

function oauthProviderAvailable(provider: unknown): boolean {
	if (provider === null || provider === undefined || typeof provider !== "object") return true;
	if (!("available" in provider)) return true;
	return provider.available !== false;
}

function getAuthProviderMetadata(): AuthProviderMetadata[] {
	const providers = new Map<string, AuthProviderMetadata>();
	for (const provider of BUILTIN_AUTH_PROVIDERS) {
		providers.set(provider.id, provider);
	}
	for (const provider of getOAuthProviders()) {
		providers.set(String(provider.id), {
			id: String(provider.id),
			name: provider.name,
			available: oauthProviderAvailable(provider),
		});
	}
	return Array.from(providers.values());
}

export function buildRpcModelCatalog(session: AgentSession): RpcModelCatalog {
	const availableModels = session.getAvailableModels();
	const available = new Set(availableModels.map(formatModelString));
	const authenticated = new Set(session.modelRegistry.authStorage.list());
	const oauthProviders = new Map(
		getAuthProviderMetadata().map(provider => [
			provider.id,
			{
				name: provider.name,
				available: provider.available,
			},
		]),
	);

	const roles: RpcModelCatalogRole[] = getKnownRoleIds(session.settings).map(role => {
		const selector = session.settings.getModelRole(role);
		const parsed = selector ? parseModelString(selector) : undefined;
		return {
			role,
			selector,
			provider: parsed?.provider,
			modelId: parsed?.id,
		};
	});

	const rolesByModel = new Map<string, string[]>();
	for (const role of roles) {
		if (!role.provider || !role.modelId) continue;
		const key = `${role.provider}/${role.modelId}`;
		const roleList = rolesByModel.get(key) ?? [];
		roleList.push(role.role);
		rolesByModel.set(key, roleList);
	}

	const current = session.model;
	const models: RpcModelCatalogEntry[] = session.modelRegistry.getAll().map(model => {
		const key = formatModelString(model);
		const oauthProvider = oauthProviders.get(model.provider);
		return {
			provider: model.provider,
			providerName: oauthProvider?.name ?? model.provider,
			id: model.id,
			name: model.name,
			available: available.has(key),
			authenticated: authenticated.has(model.provider),
			loginSupported: oauthProvider !== undefined,
			loginAvailable: oauthProvider?.available === true,
			current: current?.provider === model.provider && current.id === model.id,
			roles: rolesByModel.get(key) ?? [],
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			supportsImages: model.input.includes("image"),
		};
	});

	return {
		models,
		roles,
		current,
	};
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut === true) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function requestRpcEditor(
	correlator: RequestCorrelator,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	const { id, promise } = correlator.register<RpcExtensionUIResponse | undefined>({
		signal: dialogOptions?.signal,
		defaultValue: undefined,
		onAbort: () => {
			// Notify the host to dismiss the editor; correlator already cleans up locally.
			output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "cancel",
				targetId: id,
			} as RpcExtensionUIRequest);
		},
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	const response = await promise;
	if (response === undefined) return undefined;
	if ("cancelled" in response && response.cancelled) return undefined;
	if ("value" in response) return response.value;
	return undefined;
}

/**
 * Outcome of resolving the `auth.login` provider when none was supplied
 * on the command. Either a usable provider id (direct or picker-driven)
 * or a typed error suitable for an `RpcResponse.error` payload.
 */
export type AuthLoginProviderResolution = { ok: true; provider: string } | { ok: false; error: string };

/**
 * Resolve the provider id for an `auth.login` dispatch.
 *
 * - Non-empty `commandProvider` → return it directly.
 * - Empty / missing `commandProvider` → emit a correlated
 *   `auth.pick_provider` extension_ui_request, await the host's
 *   reply, and return the picked id (or a typed error if the picker
 *   was cancelled or the reply was malformed).
 *
 * Extracted as a free function so the picker choreography is unit
 * testable without an `AgentSession`. The wire shape produced here is
 * type-locked against `RpcExtensionUIRequest`'s `auth.pick_provider`
 * variant: any drift in the frame fields becomes a TS compile error.
 *
 * See ADR 0002 for the wire contract; see CONTEXT.md
 * "authCLIDriver / Provider-required contract" for the host-side
 * routing.
 */
export async function resolveAuthLoginProvider(
	commandProvider: string | undefined,
	correlator: RequestCorrelator,
	output: RpcOutput,
	listAvailableProviderIds: () => string[],
): Promise<AuthLoginProviderResolution> {
	if (commandProvider !== undefined && commandProvider !== "") {
		return { ok: true, provider: commandProvider };
	}
	const options = listAvailableProviderIds();
	if (options.length === 0) {
		return { ok: false, error: "no providers available" };
	}
	const { id, promise } = correlator.register<RpcExtensionUIResponse | undefined>({
		defaultValue: undefined,
	});
	output({
		type: "extension_ui_request",
		id,
		method: AuthMethod.PickProvider,
		options,
		defaultId: options[0],
	} as RpcExtensionUIRequest);
	const reply = await promise;
	if (reply === undefined || ("cancelled" in reply && reply.cancelled === true)) {
		return { ok: false, error: "auth.login cancelled" };
	}
	if (!("value" in reply) || typeof reply.value !== "string" || reply.value === "") {
		return { ok: false, error: "auth.login picker returned invalid response" };
	}
	return { ok: true, provider: reply.value };
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession): Promise<never> {
	// Signal to RPC clients that the server is ready, with the wire schema
	// version. Hosts SHOULD verify schema === "omp-rpc/v1".
	process.stdout.write(`${JSON.stringify({ type: "ready", schema: OMP_RPC_SCHEMA_V1 })}\n`);
	const output = (frame: WireFrame) => {
		process.stdout.write(`${JSON.stringify(frame)}\n`);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const errorResp = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const runAuthCommand = async <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		body: () => Promise<object | null | undefined>,
		onError?: (message: string) => void,
	): Promise<RpcResponse> => {
		try {
			const data = await body();
			return success(id, command, data ?? null);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onError?.(message);
			return errorResp(id, command, message);
		}
	};

	const extensionUIRequests = new RequestCorrelator();
	const hostToolBridge = new RpcHostToolBridge(output);

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private correlator: RequestCorrelator,
			private output: (frame: WireFrame) => void,
		) {}

		/**
		 * Helper for dialog methods. Registers a correlated request, emits the
		 * extension_ui_request frame, and parses the response when it arrives.
		 * Signal abort and timeout are handled by the correlator.
		 */
		async #createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			const { id, promise } = this.correlator.register<RpcExtensionUIResponse | undefined>({
				signal: opts?.signal,
				timeoutMs: opts?.timeout,
				defaultValue: undefined,
				onTimeout: () => opts?.onTimeout?.(),
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			const response = await promise;
			if (response === undefined) return defaultValue;
			return parseResponse(response);
		}

		select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "select", title, options, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut === true) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.correlator, this.output, title, prefill, dialogOptions, editorOptions);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Set up extensions with RPC-based UI context
	const extensionRunner = session.extensionRunner;
	if (extensionRunner) {
		extensionRunner.initialize(
			// ExtensionActions
			{
				sendMessage: (message, options) => {
					session.sendCustomMessage(message, options).catch((error: Error) => {
						output(errorResp(undefined, "extension_send", error.message));
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch((error: Error) => {
						output(errorResp(undefined, "extension_send_user", error.message));
					});
				},
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => session.getAllToolNames(),
				setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
				getCommands: () => [],
				setModel: model => runExtensionSetModel(session, model),
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await session.sessionManager.setSessionName(name, "user");
				},
			},
			// ExtensionContextActions
			{
				getModel: () => session.agent.state.model,
				isIdle: () => !session.isStreaming,
				abort: () => session.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => {
					shutdownState.requested = true;
				},
				getContextUsage: () => session.getContextUsage(),
				getSystemPrompt: () => session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			// ExtensionCommandContextActions - commands invokable via prompt("/command")
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async options => {
					const success = await session.newSession({ parentSession: options?.parentSession });
					// Note: setup callback runs but no UI feedback in RPC mode
					if (success && options?.setup) {
						await options.setup(session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			new RpcExtensionUIContext(extensionUIRequests, output),
		);
		extensionRunner.onError(err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		});
		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	// Translate internal AgentSessionEvent → v1 wire events. Internal-only
	// events (auto_compaction_*, auto_retry_*, ttsr_*, todo_*, irc_message,
	// retry_fallback_*) translate to null and are dropped — they remain
	// available to in-process subscribers but never reach the wire.
	session.subscribe(event => {
		const wire = toWireEvent(event);
		if (wire !== null) output(wire);
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			case "prompt": {
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
					})
					.catch((error: Error) => output(errorResp(id, "prompt", error.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort();
				session
					.prompt(command.message, { images: command.images })
					.catch((error: Error) => output(errorResp(id, "abort_and_prompt", error.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session": {
				const options =
					command.parentSession !== null && command.parentSession !== undefined && command.parentSession !== ""
						? { parentSession: command.parentSession }
						: undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, "new_session", { cancelled });
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				};
				return success(id, "get_state", state);
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "models.catalog": {
				return success(id, "models.catalog", buildRpcModelCatalog(session));
			}

			case "set_model": {
				// Backward compatibility for older Go bridge builds that used
				// a synthetic placeholder before models.catalog existed.
				if (command.provider === "gmp" && command.modelId === "gmp-backend") {
					return success(id, "set_model", session.model ?? null);
				}
				const model = session.modelRegistry.find(command.provider, command.modelId);
				if (!model) {
					return errorResp(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model, command.role ?? "default");
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (level === undefined) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, "switch_session", { cancelled });
			}

			case "branch": {
				const result = await session.branch(command.entryId);
				return success(id, "branch", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return errorResp(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return errorResp(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "auth.login": {
				// Empty / missing provider triggers backend-driven picker via
				// correlated auth.pick_provider extension_ui_request. The Go
				// side (Bubble Tea dialog.GmpAuth and CLI authCLIDriver) both
				// already route this method; only the backend emit was missing.
				// See ADR 0002.
				const resolved = await resolveAuthLoginProvider(command.provider, extensionUIRequests, output, () =>
					getAuthProviderMetadata()
						.filter(p => p.available)
						.map(p => p.id),
				);
				if (!resolved.ok) {
					return errorResp(id, "auth.login", resolved.error);
				}
				const provider = resolved.provider;
				const controller = new RpcOAuthController({
					provider,
					correlator: extensionUIRequests,
					output,
				});
				return runAuthCommand(
					id,
					"auth.login",
					async () => {
						await session.modelRegistry.authStorage.login(provider as OAuthProviderId, {
							onAuth: info => controller.onAuth(info),
							onProgress: msg => controller.onProgress(msg),
							onPrompt: prompt => controller.onPrompt(prompt),
							onManualCodeInput: () => controller.onManualCodeInput(),
						});
						// Snapshot the post-login authenticated provider list so
						// the Go-side workspace refreshes its catalog without an
						// extra round-trip. AuthStorage.list() is the source of
						// truth for "who has stored credentials".
						controller.emitResult(true, undefined, session.modelRegistry.authStorage.list());
						return { provider, ok: true };
					},
					message => controller.emitResult(false, message),
				);
			}

			case "auth.logout": {
				const provider = command.provider;
				return runAuthCommand(id, "auth.logout", async () => {
					await session.modelRegistry.authStorage.logout(provider);
					return { provider };
				});
			}

			case "providers.list_supported": {
				// All OAuth providers gmp can authenticate. The Go-side TUI
				// uses this to populate its interactive /login picker so the
				// list always tracks pi-ai's known providers.
				return success(id, "providers.list_supported", { providers: getAuthProviderMetadata() });
			}

			case "providers.list_authenticated": {
				// Currently-authenticated providers (i.e. those with stored
				// credentials in AuthStorage). Returned as raw ids; the
				// caller pairs them with the supported list when display
				// names are needed.
				return success(id, "providers.list_authenticated", {
					providers: session.modelRegistry.authStorage.list(),
				});
			}

			default: {
				const unknownCommand = command as { type: string };
				return errorResp(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownState.requested) return;

		if (extensionRunner?.hasHandlers("session_shutdown") === true) {
			await extensionRunner.emit({ type: "session_shutdown" });
		}

		process.exit(0);
	}

	// Listen for JSON input using Bun's stdin
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		try {
			// Handle extension UI responses — route via correlator. Stale ids are no-ops.
			if ((parsed as RpcExtensionUIResponse).type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				extensionUIRequests.resolve(response.id, response);
				continue;
			}

			if (isRpcHostToolResult(parsed)) {
				hostToolBridge.handleResult(parsed);
				continue;
			}

			if (isRpcHostToolUpdate(parsed)) {
				hostToolBridge.handleUpdate(parsed);
				continue;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			output(errorResp(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	// stdin closed — RPC client is gone, exit cleanly
	hostToolBridge.rejectAllPending("RPC client disconnected before host tool execution completed");
	process.exit(0);
}
