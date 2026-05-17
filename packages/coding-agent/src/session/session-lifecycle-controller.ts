import type { MCPSelectionStore } from "./mcp-selection-store";
import type { SessionContext, SessionManager } from "./session-manager";
import type { TodoPhaseState } from "./todo-phase-state";

/**
 * Dependencies the {@link SessionLifecycleController} needs from its owning
 * session. Concrete callback bag — each rehydrator the controller fans out to
 * is named explicitly so future state-owning Modules opt in by adding a callback
 * rather than learning a new abstraction.
 */
export interface SessionLifecycleControllerContext {
	mcp: MCPSelectionStore;
	todoPhaseState: TodoPhaseState;
	sessionManager: SessionManager;
	getSessionFile(): string | null | undefined;
	getActiveNonMCPToolNames(): string[];
	applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void>;
}

/**
 * Owns the "after a session context changed, re-align the per-controller state"
 * rehydrator cluster on AgentSession. Today: MCP tool selection restoration and
 * todo-phase resync from the new branch.
 *
 * AgentSession's lifecycle methods (`branch`, `navigateTree`, `switchSession`,
 * `fork`, `reload`, `newSession`) and the compaction / context-promotion paths
 * call into this Module at their respective rehydration points instead of
 * routing through a tangle of private helpers on the orchestrator. The
 * orderings of rehydrators still differ across call sites (branch does
 * todo→MCP, navigateTree does MCP→todo); the Module exposes each operation
 * separately so callers preserve their intentional ordering — the gain is the
 * named seam and the single home for "what needs to rehydrate when the session
 * context changes" rather than a forced canonical sequence.
 *
 * Future controllers that own session-context-dependent state add a callback
 * to {@link SessionLifecycleControllerContext} and a method here.
 */
export class SessionLifecycleController {
	#ctx: SessionLifecycleControllerContext;

	constructor(ctx: SessionLifecycleControllerContext) {
		this.#ctx = ctx;
	}

	/**
	 * Restore the per-session MCP tool selection from the loaded session context
	 * and re-apply the active tool set so the agent sees the right tools for the
	 * resumed/branched/navigated state.
	 *
	 * No-op if MCP discovery is disabled. The fallback set kicks in when the
	 * session has never persisted an explicit selection (e.g. a fresh fork).
	 */
	async restoreMCPSelections(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#ctx.mcp.isEnabled) return;
		const nextActiveNonMCPToolNames = this.#ctx.getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#ctx.mcp.getConfiguredDefaults();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#ctx.mcp.filterSelectable(sessionContext.selectedMCPToolNames)
			: this.#ctx.mcp.filterSelectable(fallbackSelectedMCPToolNames);
		this.#ctx.mcp.rememberSessionDefault(this.#ctx.getSessionFile(), this.#ctx.mcp.getConfiguredDefaults());
		await this.#ctx.applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}

	/**
	 * Resync the todo-phase view from the current session branch. Called after
	 * any lifecycle path that mutates the branch (switchSession, navigateTree,
	 * branch, compaction handoff, history rewrite).
	 */
	syncTodoPhasesFromBranch(): void {
		this.#ctx.todoPhaseState.syncFromBranch(this.#ctx.sessionManager.getBranch());
	}
}
