import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	buildDiscoverableMCPSearchIndex,
	collectDiscoverableMCPTools,
	type DiscoverableMCPSearchIndex,
	type DiscoverableMCPTool,
	isMCPToolName,
	selectDiscoverableMCPToolNamesByServer,
} from "../mcp/discoverable-tool-metadata";

/**
 * Dependencies the {@link MCPSelectionStore} needs from its owning session.
 */
export interface MCPSelectionContext {
	toolRegistry: Map<string, AgentTool>;
	sessionManager: {
		appendMCPToolSelection(toolNames: string[]): void;
	};
	/**
	 * Reads the names of tools currently set on the agent. Used when discovery
	 * is disabled — there's no separate selection set in that mode; "selected"
	 * means "currently active".
	 */
	getActiveToolNames(): string[];
}

export interface MCPSelectionInit {
	enabled: boolean;
	initialSelected: Iterable<string>;
	defaultServerNames: Iterable<string>;
	defaultToolNames: Iterable<string>;
}

/**
 * Owns the per-session MCP-discovery state cluster: which discoverable MCP
 * tools exist, which subset is selected for the current session, the seed
 * defaults from config, and the per-session-file remembered defaults used
 * when restoring sessions.
 *
 * Active-tool management (`setActiveToolsByName`, `#applyActiveToolsByName`)
 * stays on `AgentSession` because it crosses concerns (system prompt rebuild,
 * Auto-QA tool injection, agent-state mutation) — it *uses* this store to
 * read/write the MCP-specific projection of the active tool set.
 */
export class MCPSelectionStore {
	#ctx: MCPSelectionContext;
	#enabled: boolean;
	#discoverableTools = new Map<string, DiscoverableMCPTool>();
	#searchIndex: DiscoverableMCPSearchIndex | null = null;
	#selectedToolNames: Set<string>;
	#defaultServerNames: Set<string>;
	#defaultToolNames: Set<string>;
	#sessionDefaults = new Map<string, string[]>();

	constructor(ctx: MCPSelectionContext, init: MCPSelectionInit) {
		this.#ctx = ctx;
		this.#enabled = init.enabled;
		this.#selectedToolNames = new Set(init.initialSelected);
		this.#defaultServerNames = new Set(init.defaultServerNames);
		this.#defaultToolNames = new Set(init.defaultToolNames);
	}

	/** Whether MCP discovery mode is enabled for this session. */
	get isEnabled(): boolean {
		return this.#enabled;
	}

	getDiscoverableTools(): DiscoverableMCPTool[] {
		return Array.from(this.#discoverableTools.values());
	}

	getSearchIndex(): DiscoverableMCPSearchIndex {
		if (!this.#searchIndex) {
			this.#searchIndex = buildDiscoverableMCPSearchIndex(this.#discoverableTools.values());
		}
		return this.#searchIndex;
	}

	/**
	 * Names of MCP tools currently selected for this session. Mode-specific:
	 * - discovery off: returns MCP tools from the agent's currently-active tools
	 * - discovery on: returns the explicit selection set, filtered to what's actually selectable
	 */
	getSelectedToolNames(): string[] {
		if (!this.#enabled) {
			return this.#ctx.getActiveToolNames().filter(name => isMCPToolName(name) && this.#ctx.toolRegistry.has(name));
		}
		return this.#filterSelectable(this.#selectedToolNames);
	}

	/** Recompute the discoverable-tools map from the current tool registry. */
	setDiscoverableFromRegistry(): void {
		this.#discoverableTools = new Map(
			collectDiscoverableMCPTools(this.#ctx.toolRegistry.values()).map(tool => [tool.name, tool] as const),
		);
		this.#searchIndex = null;
	}

	/** Drop selected names that no longer correspond to discoverable+registered tools. */
	pruneSelected(): void {
		this.#selectedToolNames = new Set(this.#filterSelectable(this.#selectedToolNames));
	}

	/**
	 * Replace the selection set from a list of currently-active tool names —
	 * keeps only the MCP-flagged, discoverable, registered ones. No-op when
	 * discovery is disabled.
	 */
	setSelectedFromActive(activeToolNames: Iterable<string>): void {
		if (!this.#enabled) return;
		this.#selectedToolNames = new Set(
			Array.from(activeToolNames).filter(
				name => isMCPToolName(name) && this.#discoverableTools.has(name) && this.#ctx.toolRegistry.has(name),
			),
		);
	}

	/** Configured-default selection (defaults-by-tool ∪ defaults-by-server), filtered to selectable. */
	getConfiguredDefaults(): string[] {
		return this.#filterSelectable([
			...this.#defaultToolNames,
			...selectDiscoverableMCPToolNamesByServer(this.#discoverableTools.values(), this.#defaultServerNames),
		]);
	}

	/** Remember the configured defaults associated with a session file (for switch-restore). */
	rememberSessionDefault(sessionFile: string | null | undefined, toolNames: Iterable<string>): void {
		if (sessionFile === null || sessionFile === undefined || sessionFile === "") return;
		this.#sessionDefaults.set(path.resolve(sessionFile), this.#filterSelectable(toolNames));
	}

	getSessionDefault(sessionFile: string | null | undefined): string[] {
		if (sessionFile === null || sessionFile === undefined || sessionFile === "") return [];
		return this.#sessionDefaults.get(path.resolve(sessionFile)) ?? [];
	}

	/**
	 * Persist the current selection to the session manager when it differs
	 * from the previous selection. No-op when discovery is disabled.
	 */
	persistIfChanged(previousSelection: string[]): void {
		if (!this.#enabled) return;
		const next = this.getSelectedToolNames();
		if (this.selectionsMatch(previousSelection, next)) return;
		this.#ctx.sessionManager.appendMCPToolSelection(next);
	}

	/** Compare two selection arrays for equality (length + position-wise). */
	selectionsMatch(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((name, index) => name === right[index]);
	}

	/** Filter an iterable of names to those discoverable+registered. */
	filterSelectable(toolNames: Iterable<string>): string[] {
		return this.#filterSelectable(toolNames);
	}

	/**
	 * Activate a list of MCP tools by adding them to the selection set.
	 * Returns the names that were actually added (after de-dup + filter).
	 * The caller is responsible for re-applying the active tool set after.
	 */
	collectActivatable(toolNames: Iterable<string>): string[] {
		const activated: string[] = [];
		const next = new Set(this.#selectedToolNames);
		for (const name of toolNames) {
			if (!isMCPToolName(name) || !this.#discoverableTools.has(name) || !this.#ctx.toolRegistry.has(name)) {
				continue;
			}
			next.add(name);
			activated.push(name);
		}
		this.#selectedToolNames = next;
		return [...new Set(activated)];
	}

	/** Read the current selection set as an array (for active-tools assembly). */
	getSelectedSnapshot(): string[] {
		return this.#filterSelectable(this.#selectedToolNames);
	}

	/**
	 * Configured explicit-default tool names (NOT including server-derived
	 * defaults), filtered to selectable. Used by `newSession` to seed the
	 * fresh session's MCP set.
	 */
	getSelectableExplicitDefaults(): string[] {
		return this.#filterSelectable(this.#defaultToolNames);
	}

	/**
	 * Add the configured-default tool names (full list including
	 * server-derived) to the current selection. Used by `refreshMCPTools`
	 * when no MCP selection has yet been persisted to the session.
	 */
	unionSelectedWithConfiguredDefaults(): void {
		this.#selectedToolNames = new Set([...this.#selectedToolNames, ...this.getConfiguredDefaults()]);
	}

	/** Snapshot the selection set for rollback purposes. */
	captureSelectedSnapshot(): Set<string> {
		return new Set(this.#selectedToolNames);
	}

	/** Restore a previously-captured selection snapshot. */
	restoreSelectedSnapshot(snapshot: Set<string>): void {
		this.#selectedToolNames = new Set(snapshot);
	}

	#filterSelectable(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(
			name => this.#discoverableTools.has(name) && this.#ctx.toolRegistry.has(name),
		);
	}
}
