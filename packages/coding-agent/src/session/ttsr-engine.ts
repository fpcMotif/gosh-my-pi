import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };

/**
 * Dependencies the {@link TtsrEngine} needs from its owning session.
 */
export interface TtsrEngineContext {
	sessionManager: {
		appendTtsrInjection(ruleNames: string[]): void;
		getCwd(): string;
	};
}

/**
 * Owns the per-session "test-time self-rewrite" state cluster: pending
 * injections, the cross-event resume promise gate that callers await on,
 * the abort-pending flag the message_update handler flips, the retry token
 * used to invalidate stale post-prompt retries, and the TtsrManager that
 * actually evaluates rule deltas.
 *
 * Extracted from `AgentSession` for a deletion-test seam over the parts
 * that are bounded:
 * - state holders + accessors
 * - pure helpers (rule-name extraction, match-context building, path
 *   normalization, "should interrupt?" decision)
 * - small orchestrators that don't reach into agent.continue/followUp
 *
 * The dense `message_update` handler with `agent.abort()` + scheduled
 * `agent.continue()` retry stays inline on the session, as does
 * `#queueDeferredTtsrInjectionIfNeeded` (which calls `agent.followUp`).
 * Those carry cross-event coordination this seam intentionally does not
 * encapsulate.
 */
export class TtsrEngine {
	#ctx: TtsrEngineContext;
	#manager: TtsrManager | undefined;
	#pending: Rule[] = [];
	#abortPending = false;
	#retryToken = 0;
	#resumePromise: Promise<void> | undefined = undefined;
	#resumeResolve: (() => void) | undefined = undefined;

	constructor(ctx: TtsrEngineContext, manager: TtsrManager | undefined) {
		this.#ctx = ctx;
		this.#manager = manager;
	}

	/** The TtsrManager (rule store + delta-checker), or undefined when none configured. */
	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	/** True when a TTSR-driven abort is in progress (gates non-TTSR `aborted` paths). */
	get isAbortPending(): boolean {
		return this.#abortPending;
	}

	setAbortPending(value: boolean): void {
		this.#abortPending = value;
	}

	hasPending(): boolean {
		return this.#pending.length > 0;
	}

	clearPending(): void {
		this.#pending = [];
	}

	/** Increment the retry token (called when scheduling a fresh post-prompt retry). */
	nextRetryToken(): number {
		this.#retryToken += 1;
		return this.#retryToken;
	}

	/** Read the current retry token (for stale-retry checks). */
	get retryToken(): number {
		return this.#retryToken;
	}

	// =========================================================================
	// Resume gate
	// =========================================================================

	ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	/** Returns the in-flight resume promise (or undefined when none is pending). */
	getResumePromise(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	// =========================================================================
	// Injection queue
	// =========================================================================

	/** Add rules to the pending-injection queue, de-duped by rule name. */
	addRules(rules: Rule[]): void {
		const seen = new Set(this.#pending.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pending.push(rule);
			seen.add(rule.name);
		}
	}

	/**
	 * Drain the pending queue and render injection content. Returns undefined
	 * when nothing is pending.
	 */
	consume(): { content: string; rules: Rule[] } | undefined {
		if (this.#pending.length === 0) return undefined;
		const rules = this.#pending;
		const content = rules
			.map(r => prompt.render(ttsrInterruptTemplate, { name: r.name, path: r.path, content: r.content }))
			.join("\n\n");
		this.#pending = [];
		return { content, rules };
	}

	/**
	 * Mark a list of rule names as injected. Calls into the manager (if any)
	 * and the session-manager persistence stream. Empty lists are silently
	 * ignored.
	 */
	markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#ctx.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	/**
	 * Extract a rule-names array from a custom-message `details` payload of
	 * shape `{ rules: string[] }`. Returns `[]` for any non-conforming input.
	 */
	extractRuleNamesFromDetails(details: unknown): string[] {
		if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	// =========================================================================
	// Match-context helpers (pure)
	// =========================================================================

	/**
	 * Decide whether a TTSR match should immediately interrupt the stream.
	 * Driven by per-rule `interruptMode` falling back to the manager-level
	 * setting (default "always"). Match context tells us whether the match
	 * came from text/thinking ("prose") or a tool call.
	 */
	shouldInterruptForMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#manager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking")) return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	/**
	 * Find the index of the most recent assistant message that matches an
	 * optional target timestamp. Used to locate the in-flight assistant
	 * message during TTSR retry coordination. Returns -1 when not found.
	 */
	findAssistantIndex(messages: AgentMessage[], targetTimestamp: number | undefined): number {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	/** Build TTSR match context for a tool-call argument delta. */
	getToolMatchContext(message: AgentMessage, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (message.role !== "assistant") {
			return context;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return context;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return context;
		}

		const toolCall = block as ToolCall;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractFilePathsFromArgs(toolCall.arguments);
		return context;
	}

	#extractFilePathsFromArgs(args: unknown): string[] | undefined {
		if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizePathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	#normalizePathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.#ctx.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
}
