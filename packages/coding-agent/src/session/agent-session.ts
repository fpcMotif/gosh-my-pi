/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	type Agent,
	AgentBusyError,
	type AgentErrorKind,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	Usage,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { Effort, getSupportedEfforts, isContextOverflow, modelsAreEqual, streamSimple } from "@oh-my-pi/pi-ai";
import { killTree, MacOSPowerAssertion } from "@oh-my-pi/pi-natives";
import {
	abortableSleep,
	getAgentDbPath,
	isEnoent,
	logger,
	prompt,
	Snowflake,
	setNativeKillTree,
} from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import { MODEL_ROLE_IDS, type ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	formatModelString,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { BashResult } from "../exec/bash-executor";
import { exportSessionToHtml } from "../export/html";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import type { PythonResult } from "../ipy/executor";
import {
	type DiscoverableMCPSearchIndex,
	type DiscoverableMCPTool,
	isMCPToolName,
} from "../mcp/discoverable-tool-metadata";
import { getCurrentThemeName, theme } from "../modes/theme/theme";
import type { PlanModeState } from "../plan-mode/state";
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import autoHandoffThresholdFocusPrompt from "../prompts/system/auto-handoff-threshold-focus.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import handoffDocumentPrompt from "../prompts/system/handoff-document.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with { type: "text" };
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { deobfuscateSessionContext, type SecretObfuscator } from "../secrets/obfuscator";
import { resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import type { CheckpointState } from "../tools/checkpoint";
import { outputMeta } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { isAutoQaEnabled } from "../tools/report-tool-issue";
import type { TodoItem, TodoPhase } from "../tools/todo-write";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { buildNamedToolChoice } from "../utils/tool-choice";
import {
	type CompactionResult,
	calculateContextTokens,
	calculatePromptTokens,
	type BranchSummaryCompleter,
	collectEntriesForBranchSummary,
	compact,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "./compaction/pruning";
import { type CompactionSummaryMessage, type CustomMessage, convertToLlm, type FileMentionMessage } from "./messages";
import { ActiveRetryFallback } from "./active-retry-fallback";
import { BackgroundExchangeQueue } from "./background-exchange-queue";
import { BashController } from "./bash-controller";
import { runCompactionWithRetry } from "./compaction-retry";
import { MCPSelectionStore } from "./mcp-selection-store";
import { PendingSessionMessages } from "./pending-session-messages";
import { PlanModeController } from "./plan-mode-controller";
import { ProviderSessionPool } from "./provider-session-pool";
import { PythonController } from "./python-controller";
import { TtsrEngine } from "./ttsr-engine";
import { formatRetryFallbackSelector, RetryFallbackPolicy } from "./retry-fallback-policy";
import { RetryController } from "./retry-controller";
import { StreamingEditGuard } from "./streaming-edit-guard";
import { formatSessionDumpText } from "./session-dump-format";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	NewSessionOptions,
	SessionContext,
	SessionManager,
} from "./session-manager";
import { getLatestCompactionEntry } from "./session-manager";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { TodoPhaseState } from "./todo-phase-state";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle"; action: "context-full" | "handoff" }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Async background jobs launched by tools */
	asyncJobManager?: AsyncJobManager;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ThinkingLevel;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/** Skill loading warnings (already captured by SDK) */
	skillWarnings?: SkillWarning[];
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<string>;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Logical owner for retained Python kernels created by this session. */
	pythonKernelOwnerId?: string;
	/** Agent identity (registry id like "0-Main" or "3-Alice") used for IRC routing. */
	agentId?: string;
	/** Shared agent registry (for forwarding IRC observations to the main session UI). */
	agentRegistry?: AgentRegistry;
	/** Completion override for branch summaries, mainly used by local tests. */
	branchSummaryCompleter?: BranchSummaryCompleter;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
}

/** Result from handoff() */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

interface HandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#asyncJobManager: AsyncJobManager | undefined = undefined;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#eventListeners: AgentSessionEventListener[] = [];

	#pendingMessages = new PendingSessionMessages();
	#planMode: PlanModeController;

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;
	#branchSummaryCompleter: BranchSummaryCompleter | undefined = undefined;

	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	#retry: RetryController;
	#activeRetryFallback: ActiveRetryFallback;
	#retryFallbackPolicy: RetryFallbackPolicy;
	#todoReminderCount = 0;
	#todoPhaseState: TodoPhaseState;
	#toolChoiceQueue = new ToolChoiceQueue();

	#bash: BashController;

	#python: PythonController;
	#pythonKernelOwnerId: string;

	#backgroundExchanges: BackgroundExchangeQueue;
	#agentId: string | undefined;
	#agentRegistry: AgentRegistry | undefined;
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;

	#skills: Skill[];
	#skillWarnings: SkillWarning[];

	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;

	#modelRegistry: ModelRegistry;

	#toolRegistry: Map<string, AgentTool>;
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt: ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<string>) | undefined;
	#baseSystemPrompt: string;
	#mcp: MCPSelectionStore;
	#rpcHostToolNames = new Set<string>();

	#ttsr: TtsrEngine;
	#postPromptTasks = new Set<Promise<void>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditGuard: StreamingEditGuard;
	#promptInFlightCount = 0;
	#obfuscator: SecretObfuscator | undefined;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	#promptGeneration = 0;
	#providerSessions = new ProviderSessionPool();

	#startPowerAssertion(): void {
		if (process.platform !== "darwin") {
			return;
		}
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({ reason: "Oh My Pi agent session" });
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#stopPowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) {
			return;
		}
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	constructor(config: AgentSessionConfig) {
		setNativeKillTree(killTree);

		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#startPowerAssertion();
		this.#asyncJobManager = config.asyncJobManager;
		this.#pythonKernelOwnerId = config.pythonKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#scopedModels = config.scopedModels ?? [];
		this.#thinkingLevel = config.thinkingLevel;
		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#modelRegistry = config.modelRegistry;
		this.#retryFallbackPolicy = new RetryFallbackPolicy({
			settings: this.settings,
			modelRegistry: this.#modelRegistry,
		});
		this.configWarnings.push(...this.#retryFallbackPolicy.validateChains());
		this.#activeRetryFallback = new ActiveRetryFallback({
			sessionId: this.sessionId,
			modelRegistry: this.#modelRegistry,
			sessionManager: this.sessionManager,
			settings: this.settings,
			policy: this.#retryFallbackPolicy,
			getModel: () => this.model,
			getThinkingLevel: () => this.thinkingLevel,
			setModelWithReset: model => this.#setModelWithProviderSessionReset(model),
			setThinkingLevel: level => this.setThinkingLevel(level),
			emitFallbackApplied: payload => this.#emitSessionEvent({ type: "retry_fallback_applied", ...payload }),
		});
		this.#retry = new RetryController({
			sessionId: this.sessionId,
			settings: this.settings,
			agent: this.agent,
			modelRegistry: this.#modelRegistry,
			retryFallbackPolicy: this.#retryFallbackPolicy,
			activeRetryFallback: this.#activeRetryFallback,
			getModel: () => this.model,
			getModelSelector: () => (this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined),
			getPromptGeneration: () => this.#promptGeneration,
			emitSessionEvent: event => this.#emitSessionEvent(event),
			scheduleAgentContinue: options => this.#scheduleAgentContinue(options),
		});
		this.#streamingEditGuard = new StreamingEditGuard({
			settings: this.settings,
			abortAgent: () => this.agent.abort(),
			resolveFsPath: filePath => this.#resolveSessionFsPath(filePath),
			getCwd: () => this.sessionManager.getCwd(),
			getObfuscator: () => this.#obfuscator,
		});
		this.#bash = new BashController({
			sessionId: this.sessionId,
			agent: this.agent,
			sessionManager: this.sessionManager,
			isStreaming: () => this.isStreaming,
			extensionRunner: this.#extensionRunner,
		});
		this.#python = new PythonController({
			kernelOwnerId: this.#pythonKernelOwnerId,
			agent: this.agent,
			sessionManager: this.sessionManager,
			settings: this.settings,
			isStreaming: () => this.isStreaming,
			extensionRunner: this.#extensionRunner,
		});
		this.#backgroundExchanges = new BackgroundExchangeQueue({
			isStreaming: () => this.isStreaming,
			emitMessageEvent: event => this.agent.emitExternalEvent(event),
		});
		this.#planMode = new PlanModeController({
			getLocalProtocolOptions: () => this.#localProtocolOptions(),
			getCwd: () => this.sessionManager.getCwd(),
		});
		this.#todoPhaseState = new TodoPhaseState({
			getClearDelaySec: () => this.settings.get("tasks.todoClearDelay"),
			onAutoClear: () => this.#emit({ type: "todo_auto_clear" }),
		});
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#onPayload = config.onPayload;
		this.#onResponse = config.onResponse;
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#mcp = new MCPSelectionStore(
			{
				toolRegistry: this.#toolRegistry,
				sessionManager: this.sessionManager,
				getActiveToolNames: () => this.getActiveToolNames(),
			},
			{
				enabled: config.mcpDiscoveryEnabled ?? false,
				initialSelected: config.initialSelectedMCPToolNames ?? [],
				defaultServerNames: config.defaultSelectedMCPServerNames ?? [],
				defaultToolNames: config.defaultSelectedMCPToolNames ?? [],
			},
		);
		this.#mcp.setDiscoverableFromRegistry();
		this.#mcp.pruneSelected();
		const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames;
		const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (
			this.#mcp.isEnabled &&
			persistInitialMCPToolSelection &&
			!this.#mcp.selectionsMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
		) {
			this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
		}
		this.#mcp.rememberSessionDefault(this.sessionManager.getSessionFile(), this.#mcp.getConfiguredDefaults());
		this.#ttsr = new TtsrEngine({ sessionManager: this.sessionManager }, config.ttsrManager);
		this.#obfuscator = config.obfuscator;
		this.#agentId = config.agentId;
		this.#agentRegistry = config.agentRegistry;
		this.#branchSummaryCompleter = config.branchSummaryCompleter;
		this.agent.setAssistantMessageEventInterceptor(assistantMessageEvent => {
			const message =
				assistantMessageEvent.type === "done"
					? assistantMessageEvent.message
					: assistantMessageEvent.type === "error"
						? assistantMessageEvent.error
						: assistantMessageEvent.partial;
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#streamingEditGuard.preCache(event);
			this.#streamingEditGuard.maybeAbort(event);
		});
		this.agent.providerSessionState = this.#providerSessions.state;
		this.#syncTodoPhasesFromBranch();

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	/** Advance the tool-choice queue and return the next directive for the upcoming LLM call. */
	nextToolChoice(): ToolChoice | undefined {
		return this.#toolChoiceQueue.nextToolChoice();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessions.state;
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsr.manager;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsr.isAbortPending;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		if (!this.#asyncJobManager) return null;
		const running = this.#asyncJobManager.getRunningJobs().map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = this.#asyncJobManager.getRecentJobs(options?.recentLimit ?? 5).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		return { running, recent };
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			l(event);
		}
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this.#getUserMessageText(event.message);
			if (messageText) {
				this.#pendingMessages.removeVisibleMessage(messageText);
			}
		}

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = obfuscator.deobfuscateObject(message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		await this.#emitSessionEvent(displayEvent);

		if (event.type === "turn_start") {
			this.#streamingEditGuard.reset();
			// TTSR: Reset buffer on turn start
			this.#ttsr.manager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsr.manager) {
			this.#ttsr.manager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "yield" && event.isError !== true) {
			this.#lastSuccessfulYieldToolCallId = event.toolCallId;
		}
		if (event.type === "turn_end" && this.#pendingRewindReport) {
			const report = this.#pendingRewindReport;
			this.#pendingRewindReport = undefined;
			await this.#applyRewind(report);
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsr.manager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				matchContext = this.#ttsr.getToolMatchContext(event.message, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const matches = this.#ttsr.manager.checkDelta(assistantEvent.delta, matchContext);
				if (matches.length > 0) {
					// Queue rules for injection; mark as injected only after successful enqueue.

					this.#ttsr.addRules(matches);

					if (this.#ttsr.shouldInterruptForMatch(matches, matchContext)) {
						// Abort the stream immediately — do not gate on extension callbacks
						this.#ttsr.setAbortPending(true);
						this.#ttsr.ensureResumePromise();
						this.agent.abort();
						// Notify extensions (fire-and-forget, does not block abort)
						this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
						// Schedule retry after a short delay
						const retryToken = this.#ttsr.nextRetryToken();
						const generation = this.#promptGeneration;
						const targetMessageTimestamp =
							event.message.role === "assistant" ? event.message.timestamp : undefined;
						this.#schedulePostPromptTask(
							async () => {
								if (this.#ttsr.retryToken !== retryToken) {
									this.#ttsr.resolveResume();
									return;
								}

								const targetAssistantIndex = this.#ttsr.findAssistantIndex(
									this.agent.state.messages,
									targetMessageTimestamp,
								);
								if (
									!this.#ttsr.isAbortPending ||
									this.#promptGeneration !== generation ||
									targetAssistantIndex === -1
								) {
									this.#ttsr.setAbortPending(false);
									this.#ttsr.clearPending();
									this.#ttsr.resolveResume();
									return;
								}
								this.#ttsr.setAbortPending(false);
								const ttsrSettings = this.#ttsr.manager?.getSettings();
								if (ttsrSettings?.contextMode === "discard") {
									// Remove the partial/aborted assistant turn from agent state
									this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
								}
								// Inject TTSR rules as system reminder before retry
								const injection = this.#ttsr.consume();
								if (injection) {
									const details = { rules: injection.rules.map(rule => rule.name) };
									this.agent.appendMessage({
										role: "custom",
										customType: "ttsr-injection",
										content: injection.content,
										display: false,
										details,
										attribution: "agent",
										timestamp: Date.now(),
									});
									this.sessionManager.appendCustomMessageEntry(
										"ttsr-injection",
										injection.content,
										false,
										details,
										"agent",
									);
									this.#ttsr.markInjected(details.rules);
								}
								try {
									await this.agent.continue();
								} catch {
									this.#ttsr.resolveResume();
								}
							},
							{ delayMs: 50 },
						);
						return;
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			this.#streamingEditGuard.preCache(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#streamingEditGuard.maybeAbort(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a hook/custom message
			if (event.message.role === "hookMessage" || event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.attribution ?? "agent",
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					this.#ttsr.markInjected(this.#ttsr.extractRuleNamesFromDetails(event.message.details));
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "developer" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "fileMention"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on the TTSR abort flag, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when TTSR is mid-abort (continuation is imminent).
				if (!this.#ttsr.isAbortPending) {
					this.#ttsr.resolveResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					this.#retry.attempt > 0
				) {
					const activeRole = this.#activeRetryFallback.role;
					if (activeRole !== undefined && this.model) {
						await this.#emitSessionEvent({
							type: "retry_fallback_succeeded",
							model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
							role: activeRole,
						});
					}
					const successfulAttempt = this.#retry.consumeSuccessfulAttempt();
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: successfulAttempt,
					});
				}
			}

			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
					toolName?: string;
					details?: { path?: string; phases?: TodoPhase[]; report?: string; startedAt?: string };
					isError?: boolean;
					content?: Array<TextContent | ImageContent>;
				};
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				if (toolName === "edit" && details?.path !== null && details?.path !== undefined && details?.path !== "") {
					this.#streamingEditGuard.invalidateForPath(details.path);
				}
				if (toolName === "todo_write" && isError !== true && Array.isArray(details?.phases)) {
					this.setTodoPhases(details.phases);
				}
				if (toolName === "todo_write" && isError === true) {
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo_write failed, so todo progress is not visible to the user.",
						errorText !== null && errorText !== undefined && errorText !== ""
							? `Failure: ${errorText}`
							: "Failure: todo_write returned an error.",
						"Fix the todo payload and call todo_write again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-write-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (toolName === "checkpoint" && isError !== true) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt: details?.startedAt ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
				}
				if (toolName === "rewind" && isError !== true && this.#checkpointState) {
					const detailReport = typeof details?.report === "string" ? details.report.trim() : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const fallbackAssistant = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
			if (
				msg.stopReason === "error" &&
				msg.provider === "github-copilot" &&
				msg.errorMessage?.includes("GitHub Copilot authentication failed") === true
			) {
				await this.#modelRegistry.authStorage.remove("github-copilot");
			}

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			if (this.#assistantEndedWithSuccessfulYield(msg)) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			// Check for retryable errors first (overloaded, rate limit, server errors)
			const errorKind = event.errorKind;
			if (this.#retry.isRetryable(msg, errorKind)) {
				const didRetry = await this.#retry.handle(msg, errorKind);
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}
			this.#retry.resolve();

			if (msg.stopReason === "aborted" && this.#checkpointState) {
				this.#checkpointState = undefined;
				this.#pendingRewindReport = undefined;
			}
			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			await compactionTask;
			// Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				return;
			}
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				if (this.#enforceRewindBeforeYield()) {
					return;
				}
				await this.#checkTodoCompletion();
			}
		}
	};

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<void>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: () => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await abortableSleep(delayMs, signal);
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.();
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.();
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#scheduleAgentContinue(options?: {
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onSkip?: () => void;
		onError?: () => void;
	}): void {
		this.#schedulePostPromptTask(
			async () => {
				if (options?.shouldContinue && !options.shouldContinue()) {
					options.onSkip?.();
					return;
				}
				try {
					await this.#activeRetryFallback.maybeRestorePrimary();
					await this.agent.continue();
				} catch {
					options?.onError?.();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: options?.onSkip,
			},
		);
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{ skipPostPromptRecoveryWait: true },
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				await continuePrompt();
			},
			{ generation },
		);
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#ttsr.resolveResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(): Promise<void> {
		while (true) {
			const retryPromise = this.#retry.waitFor();
			if (retryPromise) {
				await retryPromise;
				continue;
			}
			const ttsrResume = this.#ttsr.getResumePromise();
			if (ttsrResume) {
				await ttsrResume;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (this.#ttsr.isAbortPending || !this.#ttsr.hasPending()) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#ttsr.clearPending();
			return;
		}

		const injection = this.#ttsr.consume();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ttsr.ensureResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#ttsr.resolveResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#ttsr.resolveResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#ttsr.resolveResume();
			},
		});
	}

	/** Extract text content from a message */
	#getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter(c => c.type === "text");
		const text = textBlocks.map(c => (c as TextContent).text).join("");
		if (text.length > 0) return text;
		const hasImages = content.some(c => c.type === "image");
		return hasImages ? "[Image]" : "";
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs (agent://, skill://, rule://, mcp://,
	 *   artifact://) have no stable filesystem path; this returns `undefined`
	 *   so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (
			normalized.startsWith("agent://") ||
			normalized.startsWith("skill://") ||
			normalized.startsWith("rule://") ||
			normalized.startsWith("mcp://") ||
			normalized.startsWith("artifact://")
		) {
			return undefined;
		}
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.#extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		this.#python.markDisposing();
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown") === true) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		await this.#cancelPostPromptTasks();
		this.#todoPhaseState.dispose();
		const drained = await this.#asyncJobManager?.dispose({ timeoutMs: 3_000 });
		const deliveryState = this.#asyncJobManager?.getDeliveryState();
		if (drained === false && deliveryState) {
			logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
		}
		const pythonExecutionsSettled = await this.#python.prepareForDispose();
		if (!pythonExecutionsSettled) {
			logger.warn(
				"Detaching retained Python kernel ownership during dispose while Python execution is still active",
			);
		}
		await this.#python.disposeKernel();
		this.#stopPowerAssertion();
		await this.sessionManager.close();
		this.#providerSessions.closeAll("dispose");
		this.#disconnectFromAgent();
		this.#eventListeners = [];
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.agent.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retry.attempt;
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getActiveToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	async #syncEditToolModeAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		if (previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit")) {
			await this.refreshBaseSystemPrompt();
		}
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcp.isEnabled;
	}

	getDiscoverableMCPTools(): DiscoverableMCPTool[] {
		return this.#mcp.getDiscoverableTools();
	}

	getDiscoverableMCPSearchIndex(): DiscoverableMCPSearchIndex {
		return this.#mcp.getSearchIndex();
	}

	getSelectedMCPToolNames(): string[] {
		return this.#mcp.getSelectedToolNames();
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const activated = this.#mcp.collectActivatable(toolNames);
		if (activated.length === 0) {
			return [];
		}
		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.#mcp.getSelectedSnapshot()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
		return activated;
	}

	async #applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		toolNames = [...new Set(toolNames.map(name => name.toLowerCase()))];
		const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		// Auto-QA tool must survive any runtime tool-set mutation.
		if (isAutoQaEnabled(this.settings) && !validToolNames.includes("report_tool_issue")) {
			const qaTool = this.#toolRegistry.get("report_tool_issue");
			if (qaTool) {
				tools.push(qaTool);
				validToolNames.push("report_tool_issue");
			}
		}
		this.#mcp.setSelectedFromActive(validToolNames);
		this.agent.setTools(tools);

		// Rebuild base system prompt with new tool set
		if (this.#rebuildSystemPrompt) {
			this.#baseSystemPrompt = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
			this.agent.setSystemPrompt(this.#baseSystemPrompt);
		}
		if (options?.persistMCPSelection !== false) {
			this.#mcp.persistIfChanged(previousSelectedMCPToolNames);
		}
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#applyActiveToolsByName(toolNames);
	}

	async #restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcp.isEnabled) return;
		const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames = options?.fallbackSelectedMCPToolNames ?? this.#mcp.getConfiguredDefaults();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#mcp.filterSelectable(sessionContext.selectedMCPToolNames)
			: this.#mcp.filterSelectable(fallbackSelectedMCPToolNames);
		this.#mcp.rememberSessionDefault(this.sessionFile, this.#mcp.getConfiguredDefaults());
		await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}
	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		this.#baseSystemPrompt = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 */
	async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const existingNames = Array.from(this.#toolRegistry.keys());
		for (const name of existingNames) {
			if (isMCPToolName(name)) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
		});

		for (const customTool of mcpTools) {
			const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool;
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		this.#mcp.setDiscoverableFromRegistry();
		this.#mcp.pruneSelected();
		if (!this.buildDisplaySessionContext().hasPersistedMCPToolSelection) {
			this.#mcp.unionSelectedWithConfiguredDefaults();
		}
		this.#mcp.rememberSessionDefault(this.sessionFile, this.#mcp.getConfiguredDefaults());

		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(tool, this.#extensionRunner) : tool
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => tool.hidden !== true && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator);
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions): SimpleStreamOptions {
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		if (!sessionOnPayload && !sessionOnResponse) return options;

		const preparedOptions: SimpleStreamOptions = { ...options };

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planMode.getState();
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planMode.setState(state);
	}

	markPlanReferenceSent(): void {
		this.#planMode.markReferenceSent();
	}

	setPlanReferencePath(path: string): void {
		this.#planMode.setReferencePath(path);
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (!state) {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#planMode.buildActiveMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueFollowUp(expandedText, options?.images);
			} else {
				await this.#queueSteer(expandedText, options?.images);
			}
			return;
		}

		// Skip eager todo prelude when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			options?.synthetic !== true && !hasPendingUserDirective
				? this.#createEagerTodoPrelude(expandedText)
				: undefined;

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (options?.images) {
			userContent.push(...options.images);
		}

		const promptAttribution = options?.attribution ?? (options?.synthetic === true ? "agent" : "user");
		const message =
			options?.synthetic === true
				? {
						role: "developer" as const,
						content: userContent,
						attribution: promptAttribution,
						timestamp: Date.now(),
					}
				: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		if (eagerTodoPrelude) {
			this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
				label: "eager-todo",
			});
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				prependMessages: eagerTodoPrelude ? [eagerTodoPrelude.message] : undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		if (options?.synthetic !== true) {
			await this.#enforcePlanModeToolDecision();
		}
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice">,
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			await this.sendCustomMessage(message, { deliverAs: options.streamingBehavior });
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, options);
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
		},
	): Promise<void> {
		this.#promptInFlightCount++;
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#bash.flushPending();
			this.#python.flushPending();
			this.#backgroundExchanges.flushPending();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;

			await this.#activeRetryFallback.maybeRestorePrimary();

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (apiKey === null || apiKey === undefined || apiKey === "") {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && options?.skipCompactionCheck !== true) {
				await this.#checkCompaction(lastAssistant, false);
			}

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#planMode.buildReferenceMessage();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#planMode.buildActiveMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingMessages.takeNextTurn()) {
				messages.push(msg);
			}

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
				});
				messages.push(...fileMentionMessages);
			}

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					this.#baseSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						messages.push({
							role: "custom",
							customType: msg.customType,
							content: msg.content,
							display: msg.display,
							details: msg.details,
							attribution: msg.attribution ?? promptAttribution ?? (message.role === "user" ? "user" : "agent"),
							timestamp: Date.now(),
						});
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(this.#baseSystemPrompt);
				}
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			if (options?.skipPostPromptRecoveryWait !== true) {
				await this.#waitForPostPromptRecovery();
			}
		} finally {
			this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (error) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: error instanceof Error ? error.message : String(error),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose();
				process.exit(0);
			},
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (error) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: error instanceof Error ? error.message : String(error),
				});
			} else {
				const message = error instanceof Error ? error.message : String(error);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	async #queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#pendingMessages.addSteering(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	async #queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#pendingMessages.addFollowUp(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
		// When fully idle AND the session is in a resumable assistant-ended state,
		// schedule an immediate continue so the queued follow-up is delivered
		// without waiting for the next user turn. We gate on isStreaming (model
		// actively producing), isRetrying (auto-retry backoff is sleeping between
		// attempts), and the last message being assistant —
		// agent.continue() only dequeues follow-ups from an assistant-ended state;
		// resuming from user/toolResult state runs an extra model call on the
		// stale prompt before draining the queue.
		if (this.#canAutoContinueForFollowUp()) {
			this.#scheduleAgentContinue({
				shouldContinue: () => this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages(),
			});
		}
	}

	/**
	 * Gate for idle-path follow-up auto-continue. See `#queueFollowUp` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingMessages.addNextTurn(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (!this.#pendingMessages.scheduleHiddenNextTurn(generation)) {
			return;
		}
		this.#schedulePostPromptTask(
			async () => {
				this.#pendingMessages.clearScheduledHiddenNextTurn(generation);
				if (!this.#pendingMessages.hasNextTurn()) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					this.#pendingMessages.clearScheduledHiddenNextTurn(generation);
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (!this.#pendingMessages.hasNextTurn()) {
			return;
		}

		const queuedMessages = this.#pendingMessages.takeNextTurn();
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingMessages.restoreNextTurn(queuedMessages);
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(appMessage, options?.triggerTurn ?? false);
				return;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
			return;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn === true) {
				await this.agent.prompt(appMessage);
				return;
			}
			this.agent.appendMessage(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution ?? "agent",
			);
			return;
		}

		if (options?.triggerTurn === true) {
			await this.agent.prompt(appMessage);
			return;
		}

		this.agent.appendMessage(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution ?? "agent",
		);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
		});
	}

	/**
	 * Clear queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const messages = this.#pendingMessages.clearVisibleQueues();
		this.agent.clearAllQueues();
		return messages;
	}

	/** Number of pending messages (includes steering, follow-up, and next-turn messages) */
	get queuedMessageCount(): number {
		return this.#pendingMessages.count;
	}

	/** Get pending messages (read-only) */
	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return this.#pendingMessages.getVisibleMessages();
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 */
	popLastQueuedMessage(): string | undefined {
		// Pop from steering first (LIFO)
		const steeringMessage = this.#pendingMessages.popSteering();
		if (steeringMessage !== undefined) {
			this.agent.popLastSteer();
			return steeringMessage;
		}
		// Then from follow-up
		const followUpMessage = this.#pendingMessages.popFollowUp();
		if (followUpMessage !== undefined) {
			this.agent.popLastFollowUp();
			return followUpMessage;
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#todoPhaseState.get();
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todoPhaseState.set(phases);
	}

	#syncTodoPhasesFromBranch(): void {
		this.#todoPhaseState.syncFromBranch(this.sessionManager.getBranch());
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.#promptGeneration++;
		this.#pendingMessages.clearScheduledHiddenNextTurn();
		this.abortCompaction();
		this.abortHandoff();
		this.abortBash();
		this.abortPython();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		await this.agent.waitForIdle();
		// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
		// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
		// a subsequent prompt() can incorrectly observe the session as busy after an abort.
		this.#promptInFlightCount = 0;
		// Safety net: if the agent loop aborted without producing an assistant
		// message (e.g. failed before the first stream), the in-flight yield was
		// never resolved or rejected by the normal message_end path. Reject it now
		// so any requeue callback still fires and the queue stays consistent.
		if (this.#toolChoiceQueue.hasInFlight) {
			this.#toolChoiceQueue.reject("aborted");
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#mcp.isEnabled
			? [...this.#getActiveNonMCPToolNames(), ...this.#mcp.getSelectableExplicitDefaults()]
			: undefined;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch") === true) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel === true) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#asyncJobManager?.cancelAll();
		this.#providerSessions.closeAll("new session");
		this.agent.reset();
		if (
			options?.drop === true &&
			previousSessionFile !== null &&
			previousSessionFile !== undefined &&
			previousSessionFile !== ""
		) {
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (error) {
				logger.error("Failed to delete session during /drop", { error });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);
		this.setTodoPhases([]);
		this.agent.sessionId = this.sessionManager.getSessionId();
		this.#pendingMessages.reset();

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
		this.sessionManager.appendServiceTierChange(this.serviceTier ?? null);
		if (nextDiscoverySessionToolNames) {
			await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#mcp.rememberSessionDefault(this.sessionFile, this.#mcp.getConfiguredDefaults());

		this.#todoReminderCount = 0;
		this.#planMode.reset();
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		return this.sessionManager.setSessionName(name, source);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch") === true) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel === true) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Update agent session ID
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates API key, saves to session and settings.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: { selector?: string; thinkingLevel?: ThinkingLevel },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#activeRetryFallback.clear();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
		this.settings.setModelRole(
			role,
			this.#formatRoleModelValue(role, model, options?.selector, options?.thinkingLevel),
		);
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level.
		this.setThinkingLevel(model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates API key, saves to session log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(model: Model, thinkingLevel?: ThinkingLevel): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#activeRetryFallback.clear();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level.
		this.setThinkingLevel(thinkingLevel ?? model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param options - Optional settings: `temporary` to not persist to settings
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		options?: { temporary?: boolean },
	): Promise<RoleModelCycleResult | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = { usageOrder: this.settings.getStorage()?.getModelUsageOrder() };
		const roleModels: Array<{
			role: string;
			model: Model;
			thinkingLevel?: ThinkingLevel;
			explicitThinkingLevel: boolean;
		}> = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (roleModelStr === null || roleModelStr === undefined || roleModelStr === "") continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.model) continue;

			roleModels.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (roleModels.length <= 1) return undefined;

		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex =
			lastRole !== null && lastRole !== undefined && lastRole !== ""
				? roleModels.findIndex(entry => entry.role === lastRole)
				: -1;
		if (currentIndex === -1) {
			currentIndex = roleModels.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		const nextIndex = (currentIndex + 1) % roleModels.length;
		const next = roleModels[nextIndex];

		if (options?.temporary === true) {
			await this.setModelTemporary(next.model, next.explicitThinkingLevel ? next.thinkingLevel : undefined);
		} else {
			await this.setModel(next.model, next.role);
			if (next.explicitThinkingLevel && next.thinkingLevel !== undefined) {
				this.setThinkingLevel(next.thinkingLevel);
			}
		}

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey !== null && apiKey !== undefined && apiKey !== "") {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#activeRetryFallback.clear();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", next.model));
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level
		this.setThinkingLevel(next.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#activeRetryFallback.clear();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", nextModel));
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level for the newly selected model
		this.setThinkingLevel(this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys.
	 */
	getAvailableModels(): Model[] {
		return this.#modelRegistry.getAvailable();
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Saves the effective metadata-clamped level to session and settings only if it changes.
	 */
	setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);
		const isChanging = effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.agent.setThinkingLevel(toReasoningEffort(effectiveLevel) ?? Effort.Medium);

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.settings.set("defaultThinkingLevel", effectiveLevel);
			}
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (this.model?.reasoning !== true) return undefined;

		const levels = [ThinkingLevel.Off, ...this.getAvailableThinkingLevels()];
		const currentLevel = this.thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : this.thinkingLevel;
		const currentIndex = currentLevel !== undefined ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	isFastModeEnabled(): boolean {
		return this.serviceTier === "priority";
	}

	setServiceTier(serviceTier: ServiceTier | undefined): void {
		if (this.serviceTier === serviceTier) return;
		this.agent.serviceTier = serviceTier;
		this.sessionManager.appendServiceTierChange(serviceTier ?? null);
	}

	setFastMode(enabled: boolean): void {
		this.setServiceTier(enabled ? "priority" : undefined);
	}

	toggleFastMode(): boolean {
		const enabled = !this.isFastModeEnabled();
		this.setFastMode(enabled);
		return enabled;
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const result = pruneToolOutputs(branchEntries, DEFAULT_PRUNE_CONFIG);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#providerSessions.closeForCodexHistoryRewrite(this.model);
		return result;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		this.#disconnectFromAgent();
		await this.abort();
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		try {
			if (!this.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.settings.getGroup("compaction");
			const compactionModel = this.model;
			const apiKey = await this.#modelRegistry.getApiKey(compactionModel, this.sessionId);
			if (apiKey === null || apiKey === undefined || apiKey === "") {
				throw new Error(`No API key for ${compactionModel.provider}`);
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let hookContext: string[] | undefined;
			let hookPrompt: string | undefined;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact") === true) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel === true) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
				const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
				const result = (await this.#extensionRunner.emit({
					type: "session.compacting",
					sessionId: this.sessionId,
					messages: compactMessages,
				})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

				hookContext = result?.context;
				hookPrompt = result?.prompt;
				preserveData = result?.preserveData;
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (hookCompaction) {
				// Extension provided compaction content
				summary = hookCompaction.summary;
				shortSummary = hookCompaction.shortSummary;
				firstKeptEntryId = hookCompaction.firstKeptEntryId;
				tokensBefore = hookCompaction.tokensBefore;
				details = hookCompaction.details;
				preserveData ??= hookCompaction.preserveData;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					compactionModel,
					apiKey,
					customInstructions,
					compactionAbortController.signal,
					{ promptOverride: hookPrompt, extraContext: hookContext, remoteInstructions: this.#baseSystemPrompt },
				);
				summary = result.summary;
				shortSummary = result.shortSummary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
				preserveData = { ...preserveData, ...result.preserveData };
			}

			if (compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#providerSessions.closeForCodexHistoryRewrite(this.model);

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document by asking the agent, then start a new session with it.
	 *
	 * This prompts the current agent to write a comprehensive handoff document,
	 * waits for completion, then starts a fresh session with the handoff as context.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: HandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onHandoffAbort = () => {
			this.agent.abort();
		};
		handoffSignal.addEventListener("abort", onHandoffAbort, { once: true });
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		// Build the handoff prompt
		const handoffPrompt = prompt.render(handoffDocumentPrompt, {
			additionalFocus: customInstructions,
		});

		// Create a promise that resolves when the agent completes
		let handoffText: string | undefined;
		const { promise: completionPromise, resolve: resolveCompletion } = Promise.withResolvers<void>();
		let handoffCancelled = false;
		const unsubscribeRef: { fn: (() => void) | undefined } = { fn: undefined };
		const onCompletionAbort = () => {
			unsubscribeRef.fn?.();
			handoffCancelled = true;
			resolveCompletion();
		};
		if (handoffSignal.aborted) {
			onCompletionAbort();
		} else {
			handoffSignal.addEventListener("abort", onCompletionAbort, { once: true });
		}
		unsubscribeRef.fn = this.subscribe(event => {
			if (event.type === "agent_end") {
				unsubscribeRef.fn?.();
				handoffSignal.removeEventListener("abort", onCompletionAbort);
				// Extract text from the last assistant message
				const messages = this.agent.state.messages;
				for (let i = messages.length - 1; i >= 0; i--) {
					const msg = messages[i];
					if (msg.role === "assistant") {
						const content = (msg as AssistantMessage).content;
						const textParts = content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text);
						if (textParts.length > 0) {
							handoffText = textParts.join("\n");
							break;
						}
					}
				}
				resolveCompletion();
			}
		});

		try {
			// Send the prompt and wait for completion
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			this.#promptInFlightCount++;
			try {
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				await this.#promptAgentWithIdleRetry([
					{
						role: "developer",
						content: [{ type: "text", text: handoffPrompt }],
						attribution: "agent",
						timestamp: Date.now(),
					},
				]);
			} finally {
				this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
			}
			await completionPromise;

			if (handoffCancelled || handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (handoffText === null || handoffText === undefined || handoffText === "") {
				return undefined;
			}

			// Start a new session
			await this.sessionManager.flush();
			this.#asyncJobManager?.cancelAll();
			await this.sessionManager.newSession();
			this.agent.reset();
			this.agent.sessionId = this.sessionManager.getSessionId();
			this.#pendingMessages.reset();
			this.#todoReminderCount = 0;

			// Inject the handoff document as a custom message
			const handoffContent = `<handoff-context>\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			let savedPath: string | undefined;
			if (options?.autoTriggered === true && this.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.sessionManager.getArtifactsDir();
				if (artifactsDir !== null && artifactsDir !== undefined && artifactsDir !== "") {
					const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
					const handoffFilePath = path.join(artifactsDir, `handoff-${fileTimestamp}.md`);
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			// Rebuild agent messages from session
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();

			return { document: handoffText, savedPath };
		} finally {
			unsubscribeRef.fn?.();
			handoffSignal.removeEventListener("abort", onCompletionAbort);
			handoffSignal.removeEventListener("abort", onHandoffAbort);
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Three cases (in order):
	 * 1. Overflow + promotion: promote to larger model, retry without maintenance
	 * 2. Overflow + no promotion target: run context maintenance, auto-retry on same model
	 * 3. Threshold: Context over threshold, run context maintenance (no auto-retry)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async #checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel === true && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
				await this.#runAutoCompaction("overflow", true);
			}
			return;
		}
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return;

		// Case 2: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return;
		const pruneResult = await this.#pruneToolOutputs();
		let contextTokens = calculateContextTokens(assistantMessage.usage);
		if (pruneResult) {
			contextTokens = Math.max(0, contextTokens - pruneResult.tokensSaved);
		}
		if (shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				await this.#runAutoCompaction("threshold", false);
			}
		}
	}
	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (toolCallId === null || toolCallId === undefined || toolCallId === "") return false;
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	async #applyRewind(report: string): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		const safeCount = Math.max(0, Math.min(checkpointState.checkpointMessageCount, this.agent.state.messages.length));
		this.agent.replaceMessages(this.agent.state.messages.slice(0, safeCount));
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}
		const details = { startedAt: checkpointState.startedAt, rewoundAt: new Date().toISOString() };
		this.agent.appendMessage({
			role: "custom",
			customType: "rewind-report",
			content: report,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry("rewind-report", report, false, details, "agent");
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	async #enforcePlanModeToolDecision(): Promise<void> {
		if (!this.#planMode.isEnabled) {
			return;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return;
		}

		const calledRequiredTool = assistantMessage.content.some(
			content => content.type === "toolCall" && (content.name === "ask" || content.name === "exit_plan_mode"),
		);
		if (calledRequiredTool) {
			return;
		}
		const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("exit_plan_mode");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/exit tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return;
		}

		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
			exitToolName: "exit_plan_mode",
		});

		await this.prompt(reminder, {
			synthetic: true,
			expandPromptTemplates: false,
			toolChoice: "required",
		});
	}

	#createEagerTodoPrelude(promptText: string): { message: AgentMessage; toolChoice: ToolChoice } | undefined {
		const eagerTodosEnabled = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!eagerTodosEnabled || !todosEnabled) {
			return undefined;
		}

		if (this.#planMode.isEnabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
		if (hasPriorUserMessage) {
			return undefined;
		}

		const trimmedPromptText = promptText.trimEnd();
		if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
			return undefined;
		}

		if (!this.#toolRegistry.has("todo_write")) {
			logger.warn("Eager todo enforcement skipped because todo_write is unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return undefined;
		}

		const todoWriteToolChoice = buildNamedToolChoice("todo_write", this.model);
		if (!todoWriteToolChoice) {
			logger.warn("Eager todo enforcement skipped because the current model does not support forcing todo_write", {
				modelApi: this.model?.api,
				modelId: this.model?.id,
			});
			return undefined;
		}

		const eagerTodoReminder = prompt.render(eagerTodoPrompt);

		return {
			message: {
				role: "custom",
				customType: "eager-todo-prelude",
				content: eagerTodoReminder,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			toolChoice: todoWriteToolChoice,
		};
	}
	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(): Promise<void> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			return;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return;
		}

		const phases = this.getTodoPhases();
		if (phases.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		// Inject reminder and continue the conversation
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel);
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#providerSessions.closeForModelSwitch(currentModel, model);
		}
		this.agent.setModel(model);
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value !== null && value !== undefined && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		return (
			JSON.stringify(previousMessages.map(message => this.#normalizeSessionMessageForProviderReplay(message))) !==
			JSON.stringify(nextMessages.map(message => this.#normalizeSessionMessageForProviderReplay(message)))
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (existingRoleValue === null || existingRoleValue === undefined || existingRoleValue === "") return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings);
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel.contextPromotionTarget?.trim();
		if (configuredTarget === null || configuredTarget === undefined || configuredTarget === "") return undefined;

		const parsed = parseModelString(configuredTarget);
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (roleModelStr === null || roleModelStr === undefined || roleModelStr === "") {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: { usageOrder: this.settings.getStorage()?.getModelUsageOrder() },
			modelRegistry: this.#modelRegistry,
		});
	}

	#getCompactionModelCandidates(availableModels: Model[]): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(model);
		};

		const currentModel = this.model;
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, currentModel).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => b.contextWindow - a.contextWindow);
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle",
		willRetry: boolean,
		deferred = false,
	): Promise<void> {
		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return;
		if (reason !== "idle" && !compactionSettings.enabled) return;
		const generation = this.#promptGeneration;
		if (!deferred && reason !== "overflow" && reason !== "idle" && compactionSettings.strategy === "handoff") {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true);
				},
				{ generation },
			);
			return;
		}

		let action: "context-full" | "handoff" =
			compactionSettings.strategy === "handoff" && reason !== "overflow" ? "handoff" : "context-full";
		await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			if (compactionSettings.strategy === "handoff" && reason !== "overflow") {
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: this.#autoCompactionAbortController.signal,
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					if (!autoCompactionSignal.aborted && reason !== "idle" && compactionSettings.autoContinue !== false) {
						this.#scheduleAutoContinuePrompt(generation);
					}
					return;
				}
			}

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				if (!willRetry && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
				}
				return;
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let hookContext: string[] | undefined;
			let hookPrompt: string | undefined;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact") === true) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel === true) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
				const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
				const result = (await this.#extensionRunner.emit({
					type: "session.compacting",
					sessionId: this.sessionId,
					messages: compactMessages,
				})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

				hookContext = result?.context;
				hookPrompt = result?.prompt;
				preserveData = result?.preserveData;
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (hookCompaction) {
				// Extension provided compaction content
				summary = hookCompaction.summary;
				shortSummary = hookCompaction.shortSummary;
				firstKeptEntryId = hookCompaction.firstKeptEntryId;
				tokensBefore = hookCompaction.tokensBefore;
				details = hookCompaction.details;
				preserveData ??= hookCompaction.preserveData;
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;

				for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++) {
					const candidate = candidates[candidateIdx];
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (apiKey === null || apiKey === undefined || apiKey === "") continue;

					const outcome = await runCompactionWithRetry({
						attempt: () =>
							compact(preparation, candidate, apiKey, undefined, autoCompactionSignal, {
								promptOverride: hookPrompt,
								extraContext: hookContext,
								remoteInstructions: this.#baseSystemPrompt,
								initiatorOverride: "agent",
							}),
						retrySettings,
						modelLabel: `${candidate.provider}/${candidate.id}`,
						isLastCandidate: candidateIdx === candidates.length - 1,
						signal: autoCompactionSignal,
					});

					if (outcome.result) {
						compactResult = outcome.result;
						break;
					}
					if (outcome.lastError !== undefined) {
						lastError = outcome.lastError;
					}
				}

				if (!compactResult) {
					if (lastError !== null && lastError !== undefined) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = { ...preserveData, ...compactResult.preserveData };
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#providerSessions.closeForCodexHistoryRewrite(this.model);

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (!willRetry && reason !== "idle" && compactionSettings.autoContinue !== false) {
				this.#scheduleAutoContinuePrompt(generation);
			}

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.replaceMessages(messages.slice(0, -1));
				}

				this.#scheduleAgentContinue({ delayMs: 100, generation });
			} else if (this.agent.hasQueuedMessages()) {
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered.
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
			}
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && this.settings.get("compaction.strategy") === "off") {
			this.settings.set("compaction.strategy", "context-full");
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off";
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	/**
	 * Cancel in-progress retry. Backwards-compatible wrapper around
	 * {@link RetryController.abort}.
	 */
	abortRetry(): void {
		this.#retry.abort();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (error) {
				if (!(error instanceof AgentBusyError)) {
					throw error;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retry.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}

	// =========================================================================
	// Bash Execution — delegated to BashController
	// =========================================================================

	/** Execute a bash command. Adds result to agent context and session. */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<BashResult> {
		return this.#bash.execute(command, onChunk, options);
	}

	/** Record a bash execution result in session history. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this.#bash.recordResult(command, result, options);
	}

	/** Cancel running bash commands. */
	abortBash(): void {
		this.#bash.abort();
	}

	get isBashRunning(): boolean {
		return this.#bash.isRunning;
	}

	get hasPendingBashMessages(): boolean {
		return this.#bash.hasPending;
	}

	// =========================================================================
	// User-Initiated Python Execution — delegated to PythonController
	// =========================================================================

	/** Execute Python in the shared kernel. */
	executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		return this.#python.execute(code, onChunk, options);
	}

	assertPythonExecutionAllowed(): void {
		this.#python.assertAllowed();
	}

	/** Track Python work started outside `executePython` so dispose can wait/abort it. */
	trackPythonExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#python.track(execution, abortController);
	}

	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		this.#python.recordResult(code, result, options);
	}

	abortPython(): void {
		this.#python.abort();
	}

	get isPythonRunning(): boolean {
		return this.#python.isRunning;
	}

	get hasPendingPythonMessages(): boolean {
		return this.#python.hasPending;
	}

	// =========================================================================
	// Background-Channel IRC Exchanges
	// =========================================================================

	/**
	 * Generate an ephemeral reply to a background message (e.g. an IRC ping from
	 * another agent) using this session's current model + system prompt + history.
	 *
	 * The reply is computed via a side-channel `streamSimple` call (analogous to
	 * `/btw`) so it never blocks on the recipient's in-flight tool calls.  After
	 * the reply is generated, both the incoming question and the auto-reply are
	 * queued for injection into the recipient's persisted history so the model
	 * sees the exchange on its next turn.  Injection happens immediately when the
	 * session is idle, otherwise it is deferred until streaming ends.
	 */
	async respondAsBackground(args: {
		from: string;
		message: string;
		awaitReply?: boolean;
		signal?: AbortSignal;
	}): Promise<{ replyText: string | null }> {
		const awaitReply = args.awaitReply !== false;
		const incomingTimestamp = Date.now();
		const incomingRecord: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: `[IRC \`${args.from}\` \u2192 you]\n\n${args.message}`,
			display: true,
			details: { from: args.from, message: args.message },
			attribution: "agent",
			timestamp: incomingTimestamp,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: incomingRecord });
		this.#forwardIrcRelayToMain({
			from: args.from,
			to: this.#agentId ?? "?",
			body: args.message,
			kind: "message",
			timestamp: incomingTimestamp,
		});

		if (!awaitReply) {
			this.#backgroundExchanges.queue([incomingRecord]);
			return { replyText: null };
		}

		const incomingPrompt = prompt.render(ircIncomingTemplate, {
			from: args.from,
			message: args.message,
		});
		const { replyText } = await this.runEphemeralTurn({
			promptText: incomingPrompt,
			signal: args.signal,
		});

		const replyRecord: CustomMessage = {
			role: "custom",
			customType: "irc:autoreply",
			content: `[IRC you \u2192 \`${args.from}\` (auto)]\n\n${replyText}`,
			display: true,
			details: { to: args.from, reply: replyText },
			attribution: "agent",
			timestamp: Date.now(),
		};
		void this.#emitSessionEvent({ type: "irc_message", message: replyRecord });
		this.#forwardIrcRelayToMain({
			from: this.#agentId ?? "?",
			to: args.from,
			body: replyText,
			kind: "reply",
			timestamp: replyRecord.timestamp,
		});
		this.#backgroundExchanges.queue([incomingRecord, replyRecord]);

		return { replyText };
	}

	/**
	 * Forward an IRC exchange observation to the main agent's session UI so the
	 * user can see every IRC conversation in the main transcript, even when the
	 * main agent is not a direct participant. The relay record is display-only:
	 * it is NOT injected into the main agent's persisted history.
	 */
	#forwardIrcRelayToMain(args: {
		from: string;
		to: string;
		body: string;
		kind: "message" | "reply";
		timestamp: number;
	}): void {
		const registry = this.#agentRegistry;
		if (!registry) return;
		// If this session is the main agent, the local emit already reached the main UI.
		if (this.#agentId === MAIN_AGENT_ID) return;
		const mainRef = registry.get(MAIN_AGENT_ID);
		const mainSession = mainRef?.session;
		if (!mainSession || mainSession === this) return;
		const arrow = args.kind === "reply" ? "\u2192 (auto)" : "\u2192";
		const relayRecord: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${args.from}\` ${arrow} \`${args.to}\`]\n\n${args.body}`,
			display: true,
			details: { from: args.from, to: args.to, body: args.body, kind: args.kind },
			attribution: "agent",
			timestamp: args.timestamp,
		};
		mainSession.emitIrcRelayObservation(relayRecord);
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Public so other sessions can forward.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history.  No tools are used; the side request
	 * does not block on, or interfere with, any in-flight main turn.  The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `respondAsBackground` (IRC) and `BtwController` (`/btw`) to share
	 * the snapshot + stream pipeline.  The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context: Context = {
			systemPrompt: this.systemPrompt,
			messages: llmMessages,
		};
		const options = this.prepareSimpleStreamOptions({
			apiKey,
			sessionId: this.sessionId,
			reasoning: toReasoningEffort(this.thinkingLevel),
			serviceTier: this.serviceTier,
			signal: args.signal,
			toolChoice: "none",
		});

		let replyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = streamSimple(model, context, options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				replyText += event.delta;
				if (args.onTextDelta) args.onTextDelta(event.delta);
				continue;
			}
			if (event.type === "done") {
				assistantMessage = event.message;
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage ?? "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		return { replyText: replyText.trim(), assistantMessage };
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant") {
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				const normalized: AssistantMessage = {
					...streaming,
					content: [{ type: "text", text: streamingText }],
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (sessionFile === null || sessionFile === undefined || sessionFile === "") return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession =
			previousSessionFile !== null && previousSessionFile !== undefined && previousSessionFile !== ""
				? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
				: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch") === true) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel === true) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const previousSessionContext = this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousPendingMessages = this.#pendingMessages.capture();
		const previousModel = this.model;
		const previousThinkingLevel = this.#thinkingLevel;
		const previousServiceTier = this.agent.serviceTier;
		const previousSelectedMCPToolNames = this.#mcp.captureSelectedSnapshot();
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFallbackSelectedMCPToolNames =
			previousSessionFile !== null && previousSessionFile !== undefined && previousSessionFile !== ""
				? this.#mcp.getSessionDefault(previousSessionFile)
				: undefined;

		this.#pendingMessages.reset();

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			this.agent.sessionId = this.sessionManager.getSessionId();

			const sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				!switchingToDifferentSession &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			const fallbackSelectedMCPToolNames = this.#mcp.getSessionDefault(sessionPath);
			await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames });

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			if (switchingToDifferentSession) {
				this.#providerSessions.closeAll("session switch");
			} else if (didReloadConversationChange) {
				this.#providerSessions.closeAll("session reload");
			}

			// Restore model if saved
			const defaultModelStr = sessionContext.models.default;
			if (defaultModelStr) {
				const slashIdx = defaultModelStr.indexOf("/");
				if (slashIdx > 0) {
					const provider = defaultModelStr.slice(0, slashIdx);
					const modelId = defaultModelStr.slice(slashIdx + 1);
					const availableModels = this.#modelRegistry.getAvailable();
					const match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) {
						const currentModel = this.model;
						const shouldResetProviderState =
							switchingToDifferentSession ||
							(currentModel !== undefined &&
								(currentModel.provider !== match.provider ||
									currentModel.id !== match.id ||
									currentModel.api !== match.api));
						if (shouldResetProviderState) {
							this.#setModelWithProviderSessionReset(match);
						} else {
							this.agent.setModel(match);
						}
					}
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = this.settings.get("defaultThinkingLevel");
			const configuredServiceTier = this.settings.get("serviceTier");
			const nextThinkingLevel = resolveThinkingLevelForModel(
				this.model,
				hasThinkingEntry ? (sessionContext.thinkingLevel as ThinkingLevel | undefined) : defaultThinkingLevel,
			);
			this.#thinkingLevel = nextThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel) ?? Effort.Medium);
			this.agent.serviceTier = hasServiceTierEntry
				? sessionContext.serviceTier
				: configuredServiceTier === "none"
					? undefined
					: configuredServiceTier;

			this.#reconnectToAgent();
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.agent.sessionId = previousSessionState.sessionId;
			let restoreMcpError: unknown;
			try {
				await this.#restoreMCPSelectionsForSessionContext(previousSessionContext, {
					fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
				});
			} catch (mcpError) {
				restoreMcpError = mcpError;
				logger.warn("Failed to restore MCP selections after switch error", {
					previousSessionFile,
					targetSessionFile: sessionPath,
					error: String(mcpError),
				});
				this.#mcp.restoreSelectedSnapshot(previousSelectedMCPToolNames);
				this.agent.setTools(previousTools);
				this.#baseSystemPrompt = previousBaseSystemPrompt;
				this.agent.setSystemPrompt(previousSystemPrompt);
			}
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.#pendingMessages.restore(previousPendingMessages);
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(previousThinkingLevel) ?? Effort.Medium);
			this.agent.serviceTier = previousServiceTier;
			this.#syncTodoPhasesFromBranch();
			this.#reconnectToAgent();
			if (restoreMcpError !== null && restoreMcpError !== undefined) {
				throw restoreMcpError;
			}
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch") === true) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel === true) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingMessages.clearNextTurn();

		// Flush pending writes before branching
		await this.sessionManager.flush();
		this.#asyncJobManager?.cancelAll();

		if (selectedEntry.parentId === null || selectedEntry.parentId === undefined || selectedEntry.parentId === "") {
			await this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#syncTodoPhasesFromBranch();
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#providerSessions.closeForCodexHistoryRewrite(this.model);
		}

		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize === true && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree") === true) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel === true) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize === true) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize === true && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (apiKey === null || apiKey === undefined || apiKey === "") {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: options.customInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
				completer: this.#branchSummaryCompleter,
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted === true) {
				return { cancelled: true, aborted: true };
			}
			if (result.error !== null && result.error !== undefined && result.error !== "") {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText !== null && summaryText !== undefined && summaryText !== "") {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#providerSessions.closeForCodexHistoryRewrite(this.model);

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree") === true) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension:
					summaryText !== null && summaryText !== undefined && summaryText !== "" ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter(m => m.role === "user").length;
		const assistantMessages = state.messages.filter(m => m.role === "assistant").length;
		const toolResults = state.messages.filter(m => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		let totalPremiumRequests = 0;
		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (details === null || details === undefined || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (usage === null || usage === undefined || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			}

			if (message.role === "toolResult" && message.toolName === "task") {
				const usage = getTaskToolUsage(message.details);
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalPremiumRequests += usage.premiumRequests ?? 0;
					totalCost += usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
		};
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = this.#estimateContextTokens();
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	async fetchUsageReports(): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
		});
	}

	/**
	 * Estimate context tokens from messages, using the last assistant usage when available.
	 */
	#estimateContextTokens(): {
		tokens: number;
	} {
		const messages = this.messages;

		// Find last assistant message with usage
		let lastUsageIndex: number | null = null;
		let lastUsage: Usage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.usage) {
					lastUsage = assistantMsg.usage;
					lastUsageIndex = i;
					break;
				}
			}
		}

		if (!lastUsage || lastUsageIndex === null) {
			// No usage data - estimate all messages
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateTokens(message);
			}
			return {
				tokens: estimated,
			};
		}

		const usageTokens = calculatePromptTokens(lastUsage);
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateTokens(messages[i]);
		}

		return {
			tokens: usageTokens + trailingTokens,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = getCurrentThemeName();
		return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName });
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find(m => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export.
	 * Includes user messages, assistant text, thinking blocks, tool calls, and tool results.
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
		});
	}

	/**
	 * Format the conversation as compact context for subagents.
	 * Includes only user messages and assistant text responses.
	 * Excludes: system prompt, tool definitions, tool calls/results, thinking blocks.
	 */
	formatCompactContext(): string {
		const lines: string[] = [];
		lines.push("# Conversation Context");
		lines.push("");
		lines.push(
			"This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
		);
		lines.push("");

		for (const msg of this.messages) {
			if (msg.role === "user" || msg.role === "developer") {
				lines.push(msg.role === "developer" ? "## Developer" : "## User");
				lines.push("");
				if (typeof msg.content === "string") {
					lines.push(msg.content);
				} else {
					for (const c of msg.content) {
						if (c.type === "text") {
							lines.push(c.text);
						} else if (c.type === "image") {
							lines.push("[Image attached]");
						}
					}
				}
				lines.push("");
			} else if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				// Only include text content, skip tool calls and thinking
				const textParts: string[] = [];
				for (const c of assistantMsg.content) {
					if (c.type === "text" && c.text.trim()) {
						textParts.push(c.text);
					}
				}
				if (textParts.length > 0) {
					lines.push("## Assistant");
					lines.push("");
					lines.push(textParts.join("\n\n"));
					lines.push("");
				}
			} else if (msg.role === "fileMention") {
				const fileMsg = msg as FileMentionMessage;
				const paths = fileMsg.files.map(f => f.path).join(", ");
				lines.push(`[Files referenced: ${paths}]`);
				lines.push("");
			} else if (msg.role === "compactionSummary") {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push("## Earlier Context (Summarized)");
				lines.push("");
				lines.push(compactMsg.summary);
				lines.push("");
			}
			// Skip: toolResult, bashExecution, pythonExecution, branchSummary, custom, hookMessage
		}

		return lines.join("\n").trim();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
