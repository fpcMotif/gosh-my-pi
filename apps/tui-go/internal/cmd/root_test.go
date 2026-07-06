package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/spf13/cobra"
)

// TestRootSubcommandSet pins the registered subcommand set to the
// gmp-supported commands. The dead Crush subcommands (server, logs,
// projects, dirs, update-providers, session) were removed in the
// carve-out cmd cleanup; this guards against any of them — or a new
// Crush-runtime command — being re-registered against the inert
// internal/{server,db,...} packages. (The synthetic "completion" /
// "help" commands are injected by fang/cobra during Execute, not at
// init, so they are not present here.)
func TestRootSubcommandSet(t *testing.T) {
	want := []string{
		"login",
		"logout",
		"models",
		"run",
		"schema",
		"stats",
	}

	var got []string
	for _, c := range rootCmd.Commands() {
		got = append(got, c.Name())
	}
	sort.Strings(got)

	if len(got) != len(want) {
		t.Fatalf("subcommands = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("subcommands = %v, want %v", got, want)
		}
	}
}

func newBackendTestCommand(t *testing.T, agentCmd string) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{}
	cmd.Flags().StringP("agent-cmd", "a", "", "")
	if agentCmd != "" {
		if err := cmd.Flags().Set("agent-cmd", agentCmd); err != nil {
			t.Fatalf("set agent-cmd: %v", err)
		}
	}
	return cmd
}

func withExecutablePath(t *testing.T, fn func() (string, error)) {
	t.Helper()
	original := executablePath
	executablePath = fn
	t.Cleanup(func() {
		executablePath = original
	})
}

func TestResolveOmpBackend_prefersAgentCmd(t *testing.T) {
	t.Setenv("GMP_TUI_BACKEND", "env-backend")
	t.Setenv("OMP_TUI_BACKEND", "legacy-backend")
	withExecutablePath(t, func() (string, error) {
		return "", errors.New("no executable")
	})

	got := resolveOmpBackend(newBackendTestCommand(t, "bun packages/coding-agent/src/cli.ts"))
	want := []string{"bun", "packages/coding-agent/src/cli.ts"}
	if len(got) != len(want) {
		t.Fatalf("backend=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backend=%v want %v", got, want)
		}
	}
}

func TestResolveOmpBackend_prefersGmpEnvOverLegacyEnv(t *testing.T) {
	t.Setenv("GMP_TUI_BACKEND", "gmp-env --flag")
	t.Setenv("OMP_TUI_BACKEND", "omp-env")
	withExecutablePath(t, func() (string, error) {
		return "", errors.New("no executable")
	})

	got := resolveOmpBackend(newBackendTestCommand(t, ""))
	want := []string{"gmp-env", "--flag"}
	if len(got) != len(want) {
		t.Fatalf("backend=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backend=%v want %v", got, want)
		}
	}
}

func TestResolveOmpBackend_usesLegacyEnvWhenGmpEnvUnset(t *testing.T) {
	t.Setenv("GMP_TUI_BACKEND", "")
	t.Setenv("OMP_TUI_BACKEND", "legacy-env --mode rpc")
	withExecutablePath(t, func() (string, error) {
		return "", errors.New("no executable")
	})

	got := resolveOmpBackend(newBackendTestCommand(t, ""))
	want := []string{"legacy-env", "--mode", "rpc"}
	if len(got) != len(want) {
		t.Fatalf("backend=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backend=%v want %v", got, want)
		}
	}
}

func TestResolveOmpBackend_usesSiblingBinaryBeforePathFallback(t *testing.T) {
	t.Setenv("GMP_TUI_BACKEND", "")
	t.Setenv("OMP_TUI_BACKEND", "")
	dir := t.TempDir()
	exePath := filepath.Join(dir, "gmp-tui-go")
	siblingPath := filepath.Join(dir, "gmp")
	if err := os.WriteFile(siblingPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write sibling: %v", err)
	}
	withExecutablePath(t, func() (string, error) {
		return exePath, nil
	})

	got := resolveOmpBackend(newBackendTestCommand(t, ""))
	if len(got) != 1 || got[0] != siblingPath {
		t.Fatalf("backend=%v want [%s]", got, siblingPath)
	}
}

func TestResolveOmpBackend_defaultsToGmpOnPath(t *testing.T) {
	t.Setenv("GMP_TUI_BACKEND", "")
	t.Setenv("OMP_TUI_BACKEND", "")
	withExecutablePath(t, func() (string, error) {
		return t.TempDir(), nil
	})

	got := resolveOmpBackend(newBackendTestCommand(t, ""))
	if len(got) != 1 || got[0] != "gmp" {
		t.Fatalf("backend=%v want [gmp]", got)
	}
}
