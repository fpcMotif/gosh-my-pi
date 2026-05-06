import { describe, expect, test } from "bun:test";
import { resolveTuiGoLaunch, shouldAttemptTuiGoLaunch } from "../src/cli/tui-go-launcher";

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

	test("does not attempt the Go TUI for rpc mode", () => {
		expect(shouldAttemptTuiGoLaunch("rpc", true)).toBe(false);
		expect(shouldAttemptTuiGoLaunch("text", true)).toBe(true);
		expect(shouldAttemptTuiGoLaunch("text", false)).toBe(false);
	});
});
