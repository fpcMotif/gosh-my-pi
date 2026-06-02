import { describe, expect, test } from "bun:test";
import {
	goTuiArtifactBasename,
	goTuiBundledExecutableName,
	goTuiReleaseTargets,
	TUI_GO_BINARY_NAME,
	TUI_GO_LEGACY_BINARY_NAME,
} from "../src/cli/tui-go-binary";
import { resolveTuiGoLaunch } from "../src/cli/tui-go-launcher";

// The release pipeline (scripts/ci-release-build-{binaries,archives}.ts) cross-compiles
// apps/tui-go and ships it next to `gmp`. These contracts pin the binary name and the
// per-target GOOS/GOARCH matrix so the artifact name can never drift from what the launcher
// discovers (the G1 bug: `go build` emitted `tui-go`, the launcher probed `gmp-tui-go`).

const EXPECTED_RELEASE_IDS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

describe("tui-go binary naming", () => {
	test("the canonical output name is gmp-tui-go (what the launcher probes)", () => {
		expect(TUI_GO_BINARY_NAME).toBe("gmp-tui-go");
		expect(TUI_GO_LEGACY_BINARY_NAME).toBe("tui-go");
	});

	test("launcher discovery resolves spawn off the canonical name constant", () => {
		const got = resolveTuiGoLaunch({
			env: {},
			which: bin => (bin === TUI_GO_BINARY_NAME ? "/opt/bin/gmp-tui-go" : undefined),
		});
		expect(got).toEqual({ action: "spawn", binPath: "/opt/bin/gmp-tui-go", mode: "go" });
	});

	test("launcher still honors the legacy tui-go name as a fallback only", () => {
		const got = resolveTuiGoLaunch({
			env: {},
			which: bin => (bin === TUI_GO_LEGACY_BINARY_NAME ? "/opt/bin/tui-go" : undefined),
		});
		expect(got).toEqual({ action: "spawn", binPath: "/opt/bin/tui-go", mode: "go" });
	});
});

describe("tui-go release cross-compile matrix", () => {
	test("covers exactly the same target ids as the gmp release", () => {
		expect(goTuiReleaseTargets.map(t => t.id).sort()).toEqual([...EXPECTED_RELEASE_IDS].sort());
	});

	test("maps each release id to the correct GOOS/GOARCH", () => {
		const byId = new Map(goTuiReleaseTargets.map(t => [t.id, t]));
		expect(byId.get("darwin-arm64")).toMatchObject({ goos: "darwin", goarch: "arm64", windows: false });
		expect(byId.get("darwin-x64")).toMatchObject({ goos: "darwin", goarch: "amd64", windows: false });
		expect(byId.get("linux-x64")).toMatchObject({ goos: "linux", goarch: "amd64", windows: false });
		expect(byId.get("linux-arm64")).toMatchObject({ goos: "linux", goarch: "arm64", windows: false });
		expect(byId.get("win32-x64")).toMatchObject({ goos: "windows", goarch: "amd64", windows: true });
	});

	test("artifact basename is gmp-tui-go-<id>, with .exe only on windows", () => {
		const byId = new Map(goTuiReleaseTargets.map(t => [t.id, t]));
		expect(goTuiArtifactBasename(byId.get("linux-arm64")!)).toBe("gmp-tui-go-linux-arm64");
		expect(goTuiArtifactBasename(byId.get("win32-x64")!)).toBe("gmp-tui-go-win32-x64.exe");
	});

	test("bundled executable is gmp-tui-go, with .exe only on windows", () => {
		const byId = new Map(goTuiReleaseTargets.map(t => [t.id, t]));
		expect(goTuiBundledExecutableName(byId.get("darwin-arm64")!)).toBe("gmp-tui-go");
		expect(goTuiBundledExecutableName(byId.get("win32-x64")!)).toBe("gmp-tui-go.exe");
	});
});
