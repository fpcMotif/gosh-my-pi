import * as fs from "node:fs";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import type { PlanModeState } from "../plan-mode/state";
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import type { CustomMessage } from "./messages";

/**
 * Dependencies the {@link PlanModeController} needs from its owning session.
 */
export interface PlanModeControllerContext {
	getLocalProtocolOptions(): LocalProtocolOptions;
	getCwd(): string;
}

/**
 * Owns the per-session "plan mode" state cluster: whether plan mode is
 * enabled (carried by `PlanModeState`), whether the one-shot reference
 * message has been sent, and the path to the plan file. Builds the two
 * plan-mode custom messages (`plan-mode-active`, `plan-mode-reference`)
 * that the session injects into the conversation.
 *
 * Extracted from `AgentSession` so the state holder + message builders
 * live behind one field. The two orchestrators that *consume* the state
 * (`sendPlanModeContext`, the tool-decision enforcer) stay on the session
 * because they call `prompt()` and `sendCustomMessage`.
 */
export class PlanModeController {
	#state: PlanModeState | undefined;
	#referenceSent = false;
	#referencePath = "local://PLAN.md";
	#ctx: PlanModeControllerContext;

	constructor(ctx: PlanModeControllerContext) {
		this.#ctx = ctx;
	}

	getState(): PlanModeState | undefined {
		return this.#state;
	}

	setState(state: PlanModeState | undefined): void {
		this.#state = state;
		if (state?.enabled === true) {
			this.#referenceSent = false;
			this.#referencePath = state.planFilePath;
		}
	}

	markReferenceSent(): void {
		this.#referenceSent = true;
	}

	setReferencePath(path: string): void {
		this.#referencePath = path;
	}

	/** Whether plan mode is currently enabled. */
	get isEnabled(): boolean {
		return this.#state?.enabled === true;
	}

	/** Reset reference-sent + reference-path defaults. Called on session switch. */
	reset(): void {
		this.#referenceSent = false;
		this.#referencePath = "local://PLAN.md";
	}

	/**
	 * Build a one-shot plan-mode reference message — sent only when plan mode
	 * is OFF (the reference is for after-exit). Returns null when plan mode
	 * is currently active, when the reference was already sent, or when the
	 * plan file no longer exists.
	 */
	async buildReferenceMessage(): Promise<CustomMessage | null> {
		if (this.isEnabled) return null;
		if (this.#referenceSent) return null;

		const planFilePath = this.#referencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#ctx.getLocalProtocolOptions());
		let planContent: string;
		try {
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
			planContent,
		});

		this.#referenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Build the plan-mode active message that's injected on every prompt
	 * while plan mode is enabled. Returns null when plan mode is off.
	 */
	async buildActiveMessage(): Promise<CustomMessage | null> {
		const state = this.#state;
		if (state?.enabled !== true) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#ctx.getLocalProtocolOptions())
			: resolveToCwd(state.planFilePath, this.#ctx.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#ctx.getLocalProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}
