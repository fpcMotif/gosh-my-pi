import { $which } from "@oh-my-pi/pi-utils";
import { TUI_GO_BINARY_NAME, TUI_GO_LEGACY_BINARY_NAME } from "./tui-go-binary";

type TuiGoMode = "go" | "go-strict" | "legacy";

export type TuiGoLaunchResolution =
	| { action: "legacy"; mode: "legacy" }
	| { action: "missing"; message: string; mode: "go" | "go-strict"; strict: boolean }
	| { action: "spawn"; binPath: string; mode: "go" | "go-strict" };

export interface ResolveTuiGoLaunchOptions {
	env?: Record<string, string | undefined>;
	which?: (bin: string) => string | null | undefined;
}

export function shouldAttemptTuiGoLaunch(mode: string, isInteractive: boolean): boolean {
	return isInteractive && mode !== "rpc" && mode !== "acp";
}

export type TuiGoSpawnOutcome<T> = { kind: "spawned"; exitCode: number } | { kind: "session"; session: T };

/**
 * Resolve the Go TUI before paying for an in-process agent session.
 *
 * `gmp-tui-go` runs its own `omp --mode rpc` backend, so when it will be spawned
 * the in-process session bootstrap (MCP + LSP discovery in `createAgentSession`)
 * is pure waste — it used to be built and then immediately disposed (gap G24).
 * The spawn is attempted first whenever the Go TUI is eligible; `buildSession`
 * runs only on the fall-through (Go TUI ineligible, disabled, or unavailable).
 */
export async function spawnTuiGoOrBuildSession<T>(args: {
	mode: string;
	isInteractive: boolean;
	spawn: () => Promise<number | null>;
	buildSession: () => Promise<T>;
}): Promise<TuiGoSpawnOutcome<T>> {
	if (shouldAttemptTuiGoLaunch(args.mode, args.isInteractive)) {
		const exitCode = await args.spawn();
		if (exitCode !== null) {
			return { kind: "spawned", exitCode };
		}
	}
	return { kind: "session", session: await args.buildSession() };
}

export function resolveTuiGoLaunch(options: ResolveTuiGoLaunchOptions = {}): TuiGoLaunchResolution {
	const env = options.env ?? process.env;
	const which = options.which ?? $which;
	const mode = normalizeTuiGoMode(env.GMP_TUI ?? env.OMP_TUI);

	if (mode === "legacy") {
		return { action: "legacy", mode };
	}

	const explicitBin = firstNonEmpty(env.GMP_TUI_BIN, env.OMP_TUI_BIN);
	const binPath = explicitBin ?? which(TUI_GO_BINARY_NAME) ?? which(TUI_GO_LEGACY_BINARY_NAME) ?? undefined;
	if (binPath === undefined) {
		return {
			action: "missing",
			mode,
			strict: mode === "go-strict",
			message: missingTuiGoMessage(mode),
		};
	}

	return { action: "spawn", binPath, mode };
}

function normalizeTuiGoMode(value: string | undefined): TuiGoMode {
	switch (value?.toLowerCase()) {
		case "legacy":
			return "legacy";
		case "go-strict":
			return "go-strict";
		case "go":
		case "auto":
		case undefined:
		case "":
			return "go";
		default:
			return "go";
	}
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (value !== undefined && value !== "") {
			return value;
		}
	}
	return undefined;
}

function missingTuiGoMessage(mode: "go" | "go-strict"): string {
	const requested = mode === "go-strict" ? "GMP_TUI=go-strict" : "Go TUI";
	return (
		`${requested} requested but no ${TUI_GO_BINARY_NAME} binary was found in PATH. ` +
		`Install ${TUI_GO_BINARY_NAME}, or set GMP_TUI_BIN to its full path. ` +
		"Set GMP_TUI=legacy to use the in-process TUI."
	);
}
