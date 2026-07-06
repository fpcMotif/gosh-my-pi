import { describe, expect, test } from "bun:test";
import { resolveTuiGoLaunch, shouldAttemptTuiGoLaunch, spawnTuiGoOrBuildSession } from "../src/cli/tui-go-launcher";

describe("tui-go launcher", () => {
	test("defaults to Go TUI when the binary is available", () => {
		const got = resolveTuiGoLaunch({
			env: {},
			which: bin => (bin === "gmp-tui-go" ? "/bin/gmp-tui-go" : undefined),
		});

		expect(got).toEqual({ action: "spawn", binPath: "/bin/gmp-tui-go", mode: "go" });
	});

	test("uses GMP_TUI=legacy as the escape hatch", () => {
		const got = resolveTuiGoLaunch({
			env: { GMP_TUI: "legacy" },
			which: () => "/bin/gmp-tui-go",
		});

		expect(got).toEqual({ action: "legacy", mode: "legacy" });
	});

	test("honors strict mode when the Go TUI binary is missing", () => {
		const got = resolveTuiGoLaunch({
			env: { GMP_TUI: "go-strict" },
			which: () => undefined,
		});

		expect(got.action).toBe("missing");
		if (got.action === "missing") {
			expect(got.strict).toBe(true);
			expect(got.message).toContain("GMP_TUI=go-strict");
		}
	});

	test("prefers GMP_TUI_BIN over the legacy OMP_TUI_BIN alias", () => {
		const got = resolveTuiGoLaunch({
			env: {
				GMP_TUI_BIN: "/bin/gmp-tui-go",
				OMP_TUI_BIN: "/bin/legacy-tui-go",
			},
			which: () => undefined,
		});

		expect(got).toEqual({ action: "spawn", binPath: "/bin/gmp-tui-go", mode: "go" });
	});

	test("normalizes explicit go/auto aliases and unknown values to Go mode", () => {
		expect(
			resolveTuiGoLaunch({
				env: { GMP_TUI: "go" },
				which: () => "/bin/gmp-tui-go",
			}),
		).toEqual({ action: "spawn", binPath: "/bin/gmp-tui-go", mode: "go" });

		expect(
			resolveTuiGoLaunch({
				env: { GMP_TUI: "unsupported" },
				which: () => "/bin/gmp-tui-go",
			}),
		).toEqual({ action: "spawn", binPath: "/bin/gmp-tui-go", mode: "go" });
	});

	test("does not attempt the Go TUI for rpc mode", () => {
		expect(shouldAttemptTuiGoLaunch("rpc", true)).toBe(false);
		expect(shouldAttemptTuiGoLaunch("text", true)).toBe(true);
		expect(shouldAttemptTuiGoLaunch("text", false)).toBe(false);
	});

	// gmp-tui-go runs its own `omp --mode rpc` backend, so when it is spawned the
	// in-process agent session (MCP + LSP discovery) must not be built at all —
	// previously it was built then immediately disposed (gap G24).
	describe("spawnTuiGoOrBuildSession", () => {
		test("spawns the Go TUI and never builds a session", async () => {
			let built = false;
			const outcome = await spawnTuiGoOrBuildSession({
				mode: "text",
				isInteractive: true,
				spawn: () => Promise.resolve(0),
				buildSession: () => {
					built = true;
					return Promise.resolve("session");
				},
			});

			expect(outcome).toEqual({ kind: "spawned", exitCode: 0 });
			expect(built).toBe(false);
		});

		test("never attempts a spawn for an ineligible mode and builds the session", async () => {
			let spawned = false;
			const outcome = await spawnTuiGoOrBuildSession({
				mode: "rpc",
				isInteractive: true,
				spawn: () => {
					spawned = true;
					return Promise.resolve(0);
				},
				buildSession: () => Promise.resolve(42),
			});

			expect(spawned).toBe(false);
			expect(outcome).toEqual({ kind: "session", session: 42 });
		});

		test("falls through to building a session when the Go TUI is unavailable", async () => {
			let built = false;
			const outcome = await spawnTuiGoOrBuildSession({
				mode: "text",
				isInteractive: true,
				spawn: () => Promise.resolve(null),
				buildSession: () => {
					built = true;
					return Promise.resolve(42);
				},
			});

			expect(built).toBe(true);
			expect(outcome).toEqual({ kind: "session", session: 42 });
		});
	});
});
