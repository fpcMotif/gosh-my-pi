import { projfsOverlayProbe } from "@oh-my-pi/pi-natives";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { cleanupProjfsOverlay, ensureProjfsOverlay, isProjfsUnavailableError } from "./worktree";

export type TaskIsolationMode = "none" | "worktree" | "fuse-overlay" | "fuse-projfs";

export interface IsolationBackendResolution {
	effectiveIsolationMode: TaskIsolationMode;
	warning: string;
}

export async function resolveIsolationBackendForTaskExecution(
	requestedMode: TaskIsolationMode,
	isIsolated: boolean,
	repoRoot: string | null,
	platform: NodeJS.Platform = process.platform,
): Promise<IsolationBackendResolution> {
	let effectiveIsolationMode = requestedMode;
	let warning = "";
	if (!(isIsolated && repoRoot !== null && repoRoot !== undefined && repoRoot !== "")) {
		return { effectiveIsolationMode, warning };
	}

	if (requestedMode === "fuse-overlay" && platform === "win32") {
		effectiveIsolationMode = "worktree";
		warning =
			'<system-notification>fuse-overlay isolation is unavailable on Windows. Use task.isolation.mode = "fuse-projfs" for ProjFS. Falling back to worktree isolation.</system-notification>';
		return { effectiveIsolationMode, warning };
	}

	if (requestedMode === "fuse-projfs" && platform !== "win32") {
		effectiveIsolationMode = "worktree";
		warning =
			"<system-notification>fuse-projfs isolation is only available on Windows. Falling back to worktree isolation.</system-notification>";
		return { effectiveIsolationMode, warning };
	}

	if (!(requestedMode === "fuse-projfs" && platform === "win32")) {
		return { effectiveIsolationMode, warning };
	}

	const probe = projfsOverlayProbe();
	if (!probe.available) {
		effectiveIsolationMode = "worktree";
		const reason =
			probe.reason !== null && probe.reason !== undefined && probe.reason !== "" ? ` Reason: ${probe.reason}` : "";
		warning = `<system-notification>ProjFS is unavailable on this host. Falling back to worktree isolation.${reason}</system-notification>`;
		return { effectiveIsolationMode, warning };
	}

	const probeIsolationId = `probe-${Snowflake.next()}`;
	let probeIsolationDir: string | null = null;
	try {
		probeIsolationDir = await ensureProjfsOverlay(repoRoot, probeIsolationId);
	} catch (error) {
		if (isProjfsUnavailableError(error)) {
			effectiveIsolationMode = "worktree";
			const raw = error instanceof Error ? error.message : String(error);
			const reason = raw.replace(/^PROJFS_UNAVAILABLE:\s*/, "");
			const detail = reason ? ` Reason: ${reason}` : "";
			warning = `<system-notification>ProjFS prerequisites are unavailable for this repository. Falling back to worktree isolation.${detail}</system-notification>`;
		} else {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`ProjFS isolation initialization failed. ${message}`);
		}
	} finally {
		if (probeIsolationDir !== null && probeIsolationDir !== undefined && probeIsolationDir !== "") {
			await cleanupProjfsOverlay(probeIsolationDir);
		}
	}

	return { effectiveIsolationMode, warning };
}
