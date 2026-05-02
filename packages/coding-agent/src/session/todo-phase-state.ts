import { cloneTodoPhases, getLatestTodoPhasesFromEntries, type TodoPhase } from "../tools/todo-write";
import type { SessionEntry } from "./session-manager";

function todoClearKey(phaseName: string, taskContent: string): string {
	return `${phaseName}\u0000${taskContent}`;
}

export interface TodoPhaseStateOptions {
	getClearDelaySec: () => number | undefined;
	onAutoClear: () => void;
}

export class TodoPhaseState {
	#phases: TodoPhase[] = [];
	#clearTimers = new Map<string, Timer>();

	constructor(private readonly options: TodoPhaseStateOptions) {}

	get(): TodoPhase[] {
		return cloneTodoPhases(this.#phases);
	}

	set(phases: TodoPhase[]): void {
		this.#phases = cloneTodoPhases(phases);
		this.#scheduleAutoClear(phases);
	}

	syncFromBranch(entries: SessionEntry[]): void {
		const phases = getLatestTodoPhasesFromEntries(entries);
		// Strip completed/abandoned tasks from restored branch state. They were
		// finished in a previous run, so the auto-clear grace period has elapsed.
		for (const phase of phases) {
			phase.tasks = phase.tasks.filter(task => task.status !== "completed" && task.status !== "abandoned");
		}
		this.set(phases.filter(phase => phase.tasks.length > 0));
	}

	clear(): void {
		this.set([]);
	}

	dispose(): void {
		for (const timer of this.#clearTimers.values()) {
			clearTimeout(timer);
		}
		this.#clearTimers.clear();
	}

	#scheduleAutoClear(phases: TodoPhase[]): void {
		const delaySec = this.options.getClearDelaySec() ?? 60;
		if (delaySec < 0) return;
		const delayMs = delaySec * 1000;
		const doneKeys = new Set<string>();
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "completed" || task.status === "abandoned") {
					doneKeys.add(todoClearKey(phase.name, task.content));
				}
			}
		}

		for (const [key, timer] of this.#clearTimers) {
			if (!doneKeys.has(key)) {
				clearTimeout(timer);
				this.#clearTimers.delete(key);
			}
		}

		for (const key of doneKeys) {
			if (this.#clearTimers.has(key)) continue;
			const timer = setTimeout(() => this.#runAutoClear(key), delayMs);
			this.#clearTimers.set(key, timer);
		}
	}

	#runAutoClear(key: string): void {
		this.#clearTimers.delete(key);
		let removed = false;
		for (const phase of this.#phases) {
			const idx = phase.tasks.findIndex(task => todoClearKey(phase.name, task.content) === key);
			if (idx !== -1 && (phase.tasks[idx].status === "completed" || phase.tasks[idx].status === "abandoned")) {
				phase.tasks.splice(idx, 1);
				removed = true;
				break;
			}
		}
		if (!removed) return;

		this.#phases = this.#phases.filter(phase => phase.tasks.length > 0);
		this.options.onAutoClear();
	}
}
