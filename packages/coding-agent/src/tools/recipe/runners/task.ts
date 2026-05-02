import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { DetectedRunner, RunnerTask, TaskRunner } from "../runner";

interface TaskListEntry {
	name?: string;
	desc?: string;
	summary?: string;
}

interface TaskListJson {
	tasks?: TaskListEntry[];
}

const TASKFILE_NAMES = ["Taskfile.yml", "Taskfile.yaml"] as const;

async function hasTaskfile(cwd: string): Promise<boolean> {
	for (const name of TASKFILE_NAMES) {
		try {
			const stat = await fs.stat(path.join(cwd, name));
			if (stat.isFile()) return true;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return false;
}

async function listTaskfileTasks(cwd: string): Promise<RunnerTask[] | null> {
	try {
		const proc = Bun.spawn(["task", "--list-all", "--json"], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exit !== 0) return null;
		const list = JSON.parse(stdout) as TaskListJson;
		const tasks = (list.tasks ?? [])
			.filter(
				(task): task is TaskListEntry & { name: string } => typeof task.name === "string" && task.name.length > 0,
			)
			.map(task => {
				const desc = typeof task.desc === "string" && task.desc.length > 0 ? task.desc : undefined;
				const summary = typeof task.summary === "string" && task.summary.length > 0 ? task.summary : undefined;
				return { name: task.name, doc: desc ?? summary, parameters: [] };
			});
		return tasks.length > 0 ? tasks : null;
	} catch (error) {
		logger.debug("task runner list failed", { error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

export const taskRunner: TaskRunner = {
	id: "task",
	label: "Task",
	async detect(cwd: string): Promise<DetectedRunner | null> {
		try {
			if ($which("task") === undefined || $which("task") === "") return null;
			if (!(await hasTaskfile(cwd))) return null;
			const tasks = await listTaskfileTasks(cwd);
			if (!tasks || tasks.length === 0) return null;
			return { id: "task", label: "Task", commandPrefix: "task", tasks };
		} catch (error) {
			logger.debug("task runner probe failed", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	},
};
