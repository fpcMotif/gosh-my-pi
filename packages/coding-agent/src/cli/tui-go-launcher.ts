import { $which } from "@oh-my-pi/pi-utils";

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

export function resolveTuiGoLaunch(options: ResolveTuiGoLaunchOptions = {}): TuiGoLaunchResolution {
	const env = options.env ?? process.env;
	const which = options.which ?? $which;
	const mode = normalizeTuiGoMode(env.GMP_TUI ?? env.OMP_TUI);

	if (mode === "legacy") {
		return { action: "legacy", mode };
	}

	const explicitBin = firstNonEmpty(env.GMP_TUI_BIN, env.OMP_TUI_BIN);
	const binPath = explicitBin ?? which("gmp-tui-go") ?? which("tui-go") ?? undefined;
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
		`${requested} requested but no gmp-tui-go binary was found in PATH. ` +
		"Install gmp-tui-go, or set GMP_TUI_BIN to its full path. " +
		"Set GMP_TUI=legacy to use the in-process TUI."
	);
}
