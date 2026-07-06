// Canonical naming for the apps/tui-go Go frontend binary.
//
// `go build .` would name the binary after the module's last path segment (`tui-go`),
// but the TS launcher (tui-go-launcher.ts) and the release pipeline pin it to `gmp-tui-go`.
// This module is the single source of truth for that name and for the cross-compile matrix
// the release scripts use, so the produced artifact can never drift from what the launcher
// discovers on PATH.

export const TUI_GO_BINARY_NAME = "gmp-tui-go";

/** Legacy name `go build .` produces; accepted by the launcher only as a fallback. */
export const TUI_GO_LEGACY_BINARY_NAME = "tui-go";

export interface GoTuiReleaseTarget {
	/** Release id shared with the gmp bun-compile targets (e.g. `darwin-arm64`). */
	id: string;
	/** GOOS for `go build`. */
	goos: string;
	/** GOARCH for `go build`. */
	goarch: string;
	/** Windows needs a `.exe` suffix on both the artifact and the bundled executable. */
	windows: boolean;
}

export const goTuiReleaseTargets: GoTuiReleaseTarget[] = [
	{ id: "darwin-arm64", goos: "darwin", goarch: "arm64", windows: false },
	{ id: "darwin-x64", goos: "darwin", goarch: "amd64", windows: false },
	{ id: "linux-x64", goos: "linux", goarch: "amd64", windows: false },
	{ id: "linux-arm64", goos: "linux", goarch: "arm64", windows: false },
	{ id: "win32-x64", goos: "windows", goarch: "amd64", windows: true },
];

/** File name of the cross-compiled artifact staged in `packages/coding-agent/binaries/`. */
export function goTuiArtifactBasename(target: GoTuiReleaseTarget): string {
	return `${TUI_GO_BINARY_NAME}-${target.id}${target.windows ? ".exe" : ""}`;
}

/** File name the binary takes inside a release archive, next to the `gmp` executable. */
export function goTuiBundledExecutableName(target: GoTuiReleaseTarget): string {
	return `${TUI_GO_BINARY_NAME}${target.windows ? ".exe" : ""}`;
}
