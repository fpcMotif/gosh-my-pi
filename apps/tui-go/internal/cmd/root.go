package cmd

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	fang "charm.land/fang/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/colorprofile"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/app"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/client"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/db"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/event"
	crushlog "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/log"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/projects"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/proto"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/server"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	ui "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/model"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/version"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/exp/charmtone"
	xstrings "github.com/charmbracelet/x/exp/strings"
	"github.com/charmbracelet/x/term"
	"github.com/spf13/cobra"
)

var clientHost string

func init() {
	rootCmd.PersistentFlags().StringP("cwd", "c", "", "Current working directory")
	rootCmd.PersistentFlags().StringP("data-dir", "D", "", "Custom crush data directory")
	rootCmd.PersistentFlags().BoolP("debug", "d", false, "Debug")
	rootCmd.PersistentFlags().StringP("agent-cmd", "a", "", "Path to omp binary or full command line (overrides sibling-binary lookup, PATH, and OMP_TUI_BACKEND)")
	rootCmd.PersistentFlags().StringVarP(&clientHost, "host", "H", server.DefaultHost(), "Connect to a specific crush server host (for advanced users)")
	rootCmd.Flags().BoolP("help", "h", false, "Help")
	rootCmd.Flags().BoolP("yolo", "y", false, "Automatically accept all permissions (dangerous mode)")
	rootCmd.Flags().StringP("session", "s", "", "Continue a previous session by ID")
	rootCmd.Flags().BoolP("continue", "C", false, "Continue the most recent session")
	rootCmd.MarkFlagsMutuallyExclusive("session", "continue")

	rootCmd.AddCommand(
		runCmd,
		dirsCmd,
		projectsCmd,
		updateProvidersCmd,
		logsCmd,
		schemaCmd,
		loginCmd,
		statsCmd,
		sessionCmd,
	)
}

var rootCmd = &cobra.Command{
	Use:   "gmp-tui-go",
	Short: "Bubble Tea frontend for omp",
	Long:  "A Crush-derived Bubble Tea frontend for the omp coding-agent backend",
	Example: `
# Run in interactive mode
gmp-tui-go

# Run in a specific directory
gmp-tui-go --cwd /path/to/project

# Run in yolo mode (auto-accept all permissions; use with care)
gmp-tui-go --yolo

# Use a local backend command
OMP_TUI_BACKEND="bun packages/coding-agent/src/cli.ts" gmp-tui-go

# Continue a previous session
gmp-tui-go --session {session-id}

# Continue the most recent session
gmp-tui-go --continue
  `,
	RunE: func(cmd *cobra.Command, args []string) error {
		sessionID, _ := cmd.Flags().GetString("session")
		continueLast, _ := cmd.Flags().GetBool("continue")

		ws, cleanup, err := setupWorkspaceWithProgressBar(cmd)
		if err != nil {
			return err
		}
		defer cleanup()

		if sessionID != "" {
			sess, err := resolveWorkspaceSessionID(cmd.Context(), ws, sessionID)
			if err != nil {
				return err
			}
			sessionID = sess.ID
		}

		event.AppInitialized()

		com := common.DefaultCommon(ws)
		model := ui.New(com, sessionID, continueLast)

		var env uv.Environ = os.Environ()
		program := tea.NewProgram(
			model,
			tea.WithEnvironment(env),
			tea.WithContext(cmd.Context()),
			tea.WithFilter(ui.MouseEventFilter),
		)
		go ws.Subscribe(program)

		if _, err := program.Run(); err != nil {
			event.Error(err)
			slog.Error("TUI run error", "error", err)
			return errors.New("gmp-tui-go crashed. If you'd like to report it, please copy the stacktrace above and open an issue at https://github.com/fpcMotif/gosh-my-pi/issues/new") //nolint:staticcheck
		}
		return nil
	},
}

var heartbit = lipgloss.NewStyle().Foreground(charmtone.Dolly).SetString(`
    ▄▄▄▄▄▄▄▄    ▄▄▄▄▄▄▄▄
  ███████████  ███████████
████████████████████████████
████████████████████████████
██████████▀██████▀██████████
██████████ ██████ ██████████
▀▀██████▄████▄▄████▄██████▀▀
  ████████████████████████
    ████████████████████
       ▀▀██████████▀▀
           ▀▀▀▀▀▀
`)

// copied from cobra:
const defaultVersionTemplate = `{{with .DisplayName}}{{printf "%s " .}}{{end}}{{printf "version %s" .Version}}
`

func Execute() {
	// FIXME: config.Load uses slog internally during provider resolution,
	// but the file-based logger isn't set up until after config is loaded
	// (because the log path depends on the data directory from config).
	// This creates a window where slog calls in config.Load leak to
	// stderr. We discard early logs here as a workaround. The proper
	// fix is to remove slog calls from config.Load and have it return
	// warnings/diagnostics instead of logging them as a side effect.
	slog.SetDefault(slog.New(slog.DiscardHandler))

	// NOTE: very hacky: we create a colorprofile writer with STDOUT, then make
	// it forward to a bytes.Buffer, write the colored heartbit to it, and then
	// finally prepend it in the version template.
	// Unfortunately cobra doesn't give us a way to set a function to handle
	// printing the version, and PreRunE runs after the version is already
	// handled, so that doesn't work either.
	// This is the only way I could find that works relatively well.
	if term.IsTerminal(os.Stdout.Fd()) {
		var b bytes.Buffer
		w := colorprofile.NewWriter(os.Stdout, os.Environ())
		w.Forward = &b
		_, _ = w.WriteString(heartbit.String())
		rootCmd.SetVersionTemplate(b.String() + "\n" + defaultVersionTemplate)
	}
	if err := fang.Execute(
		context.Background(),
		rootCmd,
		fang.WithVersion(version.Version),
		fang.WithNotifySignal(os.Interrupt),
	); err != nil {
		os.Exit(1)
	}
}

// supportsProgressBar tries to determine whether the current terminal supports
// progress bars by looking into environment variables.
func supportsProgressBar() bool {
	if !term.IsTerminal(os.Stderr.Fd()) {
		return false
	}
	termProg := os.Getenv("TERM_PROGRAM")
	_, isWindowsTerminal := os.LookupEnv("WT_SESSION")

	return isWindowsTerminal || xstrings.ContainsAnyOf(strings.ToLower(termProg), "ghostty", "iterm2", "rio")
}

// useClientServer returns true when the client/server architecture is
// enabled via the CRUSH_CLIENT_SERVER environment variable.
func useClientServer() bool {
	v, _ := strconv.ParseBool(os.Getenv("CRUSH_CLIENT_SERVER"))
	return v
}

// setupWorkspaceWithProgressBar wraps setupWorkspace with an optional
// terminal progress bar shown during initialization.
func setupWorkspaceWithProgressBar(cmd *cobra.Command) (workspace.Workspace, func(), error) {
	showProgress := supportsProgressBar()
	if showProgress {
		_, _ = fmt.Fprintf(os.Stderr, ansi.SetIndeterminateProgressBar)
	}

	ws, cleanup, err := setupWorkspace(cmd)

	if showProgress {
		_, _ = fmt.Fprintf(os.Stderr, ansi.ResetProgressBar)
	}

	return ws, cleanup, err
}

// setupWorkspace returns a Workspace backed by the existing omp RPC backend.
func setupWorkspace(cmd *cobra.Command) (workspace.Workspace, func(), error) {
	return setupOmpWorkspace(cmd)
}

// resolveOmpBackend picks the omp binary (and any prefix args) according to
// the documented priority:
//
//  1. --agent-cmd flag, when explicitly set.
//  2. OMP_TUI_BACKEND env var, for local development overrides
//     (e.g. "bun packages/coding-agent/src/cli.ts").
//  3. Sibling-binary lookup: filepath.Dir(os.Executable())/omp[.exe].
//     This is the default for bundled archives where gmp-tui-go and omp
//     ship side-by-side.
//  4. Bare "omp" on PATH — exec.CommandContext does PATH resolution.
//
// The first non-empty candidate wins. Returns at least one element.
func resolveOmpBackend(cmd *cobra.Command) []string {
	if agentCmd, _ := cmd.Flags().GetString("agent-cmd"); agentCmd != "" {
		if fields := strings.Fields(agentCmd); len(fields) > 0 {
			return fields
		}
	}
	if env := os.Getenv("OMP_TUI_BACKEND"); env != "" {
		if fields := strings.Fields(env); len(fields) > 0 {
			return fields
		}
	}
	if sibling := siblingOmpPath(); sibling != "" {
		return []string{sibling}
	}
	return []string{"omp"}
}

// setupOmpLogging configures slog to write to ~/.gmp/tui.log via the
// shared crushlog rotator. When debug is true, log level is DEBUG and a
// secondary text handler mirrors output to stderr — safe because Bubble
// Tea owns stdout, leaving stderr free. The shared rotator uses sync.Once
// internally so calling this twice is a no-op.
//
// Falls back to no-op (caller still has slog.DiscardHandler from
// Execute) when ~ can't be resolved.
func setupOmpLogging(debug bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve home dir: %w", err)
	}
	logDir := filepath.Join(home, ".gmp")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", logDir, err)
	}
	logFile := filepath.Join(logDir, "tui.log")
	if debug {
		crushlog.Setup(logFile, true, os.Stderr)
	} else {
		crushlog.Setup(logFile, false)
	}
	return nil
}

// siblingOmpPath returns the absolute path of an `omp` binary sitting next
// to the running executable, or "" if it doesn't exist or os.Executable
// can't be resolved. Honours .exe on Windows.
func siblingOmpPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(filepath.Dir(exe), "omp")
	if runtime.GOOS == "windows" {
		candidate += ".exe"
	}
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func setupOmpWorkspace(cmd *cobra.Command) (workspace.Workspace, func(), error) {
	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return nil, nil, err
	}
	debug, _ := cmd.Flags().GetBool("debug")
	if err := setupOmpLogging(debug); err != nil {
		// Non-fatal: log setup failures fall back to slog default. Surface
		// to stderr so the operator sees it, but don't block the TUI.
		fmt.Fprintf(os.Stderr, "gmp-tui-go: warning: log setup failed: %v\n", err)
	}
	sessionID, _ := cmd.Flags().GetString("session")
	continueLast, _ := cmd.Flags().GetBool("continue")
	backend := resolveOmpBackend(cmd)
	args := []string{}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	} else if continueLast {
		args = append(args, "--continue")
	}
	client, err := ompclient.Spawn(cmd.Context(), ompclient.Options{
		Bin:        backend[0],
		PrefixArgs: backend[1:],
		Args:       args,
		Cwd:        cwd,
		Env:        os.Environ(),
		Stderr:     io.Discard,
	})
	if err != nil {
		return nil, nil, err
	}
	ws := workspace.NewOmpWorkspace(client, cwd)
	return ws, ws.Shutdown, nil
}

// setupLocalWorkspace creates an in-process app.App and wraps it in an
// AppWorkspace.
func setupLocalWorkspace(cmd *cobra.Command) (workspace.Workspace, func(), error) {
	debug, _ := cmd.Flags().GetBool("debug")
	yolo, _ := cmd.Flags().GetBool("yolo")
	dataDir, _ := cmd.Flags().GetString("data-dir")
	ctx := cmd.Context()

	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return nil, nil, err
	}

	store, err := config.Init(cwd, dataDir, debug)
	if err != nil {
		return nil, nil, err
	}

	cfg := store.Config()
	store.Overrides().SkipPermissionRequests = yolo

	if err := os.MkdirAll(cfg.Options.DataDirectory, 0o700); err != nil {
		return nil, nil, fmt.Errorf("failed to create data directory: %q %w", cfg.Options.DataDirectory, err)
	}

	gitIgnorePath := filepath.Join(cfg.Options.DataDirectory, ".gitignore")
	if _, err := os.Stat(gitIgnorePath); os.IsNotExist(err) {
		if err := os.WriteFile(gitIgnorePath, []byte("*\n"), 0o644); err != nil {
			return nil, nil, fmt.Errorf("failed to create .gitignore file: %q %w", gitIgnorePath, err)
		}
	}

	if err := projects.Register(cwd, cfg.Options.DataDirectory); err != nil {
		slog.Warn("Failed to register project", "error", err)
	}

	conn, err := db.Connect(ctx, cfg.Options.DataDirectory)
	if err != nil {
		return nil, nil, err
	}

	logFile := filepath.Join(cfg.Options.DataDirectory, "logs", "crush.log")
	crushlog.Setup(logFile, debug)

	appInstance, err := app.New(ctx, conn, store)
	if err != nil {
		_ = conn.Close()
		slog.Error("Failed to create app instance", "error", err)
		return nil, nil, err
	}

	if shouldEnableMetrics(cfg) {
		event.Init()
	}

	ws := workspace.NewAppWorkspace(appInstance, store)
	cleanup := func() { appInstance.Shutdown() }
	return ws, cleanup, nil
}

// setupClientServerWorkspace connects to a server process and wraps the
// result in a ClientWorkspace.
func setupClientServerWorkspace(cmd *cobra.Command) (workspace.Workspace, func(), error) {
	c, protoWs, cleanupServer, err := connectToServer(cmd)
	if err != nil {
		return nil, nil, err
	}

	clientWs := workspace.NewClientWorkspace(c, *protoWs)

	if protoWs.Config.IsConfigured() {
		if err := clientWs.InitCoderAgent(cmd.Context()); err != nil {
			slog.Error("Failed to initialize coder agent", "error", err)
		}
	}

	return clientWs, cleanupServer, nil
}

// connectToServer ensures the server is running, creates a client and
// workspace, and returns a cleanup function that deletes the workspace.
func connectToServer(cmd *cobra.Command) (*client.Client, *proto.Workspace, func(), error) {
	hostURL, err := server.ParseHostURL(clientHost)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("invalid host URL: %v", err)
	}

	if err := ensureServer(cmd, hostURL); err != nil {
		return nil, nil, nil, err
	}

	debug, _ := cmd.Flags().GetBool("debug")
	yolo, _ := cmd.Flags().GetBool("yolo")
	dataDir, _ := cmd.Flags().GetString("data-dir")
	ctx := cmd.Context()

	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return nil, nil, nil, err
	}

	c, err := client.NewClient(cwd, hostURL.Scheme, hostURL.Host)
	if err != nil {
		return nil, nil, nil, err
	}

	wsReq := proto.Workspace{
		Path:    cwd,
		DataDir: dataDir,
		Debug:   debug,
		YOLO:    yolo,
		Version: version.Version,
		Env:     os.Environ(),
	}

	ws, err := c.CreateWorkspace(ctx, wsReq)
	if err != nil {
		// The server socket may exist before the HTTP handler is ready.
		// Retry a few times with a short backoff.
		for range 5 {
			select {
			case <-ctx.Done():
				return nil, nil, nil, ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
			ws, err = c.CreateWorkspace(ctx, wsReq)
			if err == nil {
				break
			}
		}
		if err != nil {
			return nil, nil, nil, fmt.Errorf("failed to create workspace: %v", err)
		}
	}

	if shouldEnableMetrics(ws.Config) {
		event.Init()
	}

	if ws.Config != nil {
		logFile := filepath.Join(ws.Config.Options.DataDirectory, "logs", "crush.log")
		crushlog.Setup(logFile, debug)
	}

	cleanup := func() { _ = c.DeleteWorkspace(context.Background(), ws.ID) }
	return c, ws, cleanup, nil
}

// ensureServer auto-starts a detached server if the socket file does not
// exist. When the socket exists, it verifies that the running server
// version matches the client; on mismatch it shuts down the old server
// and starts a fresh one.
func ensureServer(cmd *cobra.Command, hostURL *url.URL) error {
	switch hostURL.Scheme {
	case "unix", "npipe":
		needsStart := false
		if _, err := os.Stat(hostURL.Host); err != nil && errors.Is(err, fs.ErrNotExist) {
			needsStart = true
		} else if err == nil {
			if err := restartIfStale(cmd, hostURL); err != nil {
				slog.Warn("Failed to check server version, restarting", "error", err)
				needsStart = true
			}
		}

		if needsStart {
			if err := startDetachedServer(cmd); err != nil {
				return err
			}
		}

		var err error
		for range 10 {
			_, err = os.Stat(hostURL.Host)
			if err == nil {
				break
			}
			select {
			case <-cmd.Context().Done():
				return cmd.Context().Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
		if err != nil {
			return fmt.Errorf("failed to initialize crush server: %v", err)
		}
	}

	return nil
}

// restartIfStale checks whether the running server matches the current
// client version. When they differ, it sends a shutdown command and
// removes the stale socket so the caller can start a fresh server.
func restartIfStale(cmd *cobra.Command, hostURL *url.URL) error {
	c, err := client.NewClient("", hostURL.Scheme, hostURL.Host)
	if err != nil {
		return err
	}
	vi, err := c.VersionInfo(cmd.Context())
	if err != nil {
		return err
	}
	if vi.Version == version.Version {
		return nil
	}
	slog.Info("Server version mismatch, restarting",
		"server", vi.Version,
		"client", version.Version,
	)
	_ = c.ShutdownServer(cmd.Context())
	// Give the old process a moment to release the socket.
	for range 20 {
		if _, err := os.Stat(hostURL.Host); errors.Is(err, fs.ErrNotExist) {
			break
		}
		select {
		case <-cmd.Context().Done():
			return cmd.Context().Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	// Force-remove if the socket is still lingering.
	_ = os.Remove(hostURL.Host)
	return nil
}

var safeNameRegexp = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

func startDetachedServer(cmd *cobra.Command) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %v", err)
	}

	safeClientHost := safeNameRegexp.ReplaceAllString(clientHost, "_")
	chDir := filepath.Join(config.GlobalCacheDir(), "server-"+safeClientHost)
	if err := os.MkdirAll(chDir, 0o700); err != nil {
		return fmt.Errorf("failed to create server working directory: %v", err)
	}

	cmdArgs := []string{"server"}
	if clientHost != server.DefaultHost() {
		cmdArgs = append(cmdArgs, "--host", clientHost)
	}

	c := exec.CommandContext(cmd.Context(), exe, cmdArgs...)
	stdoutPath := filepath.Join(chDir, "stdout.log")
	stderrPath := filepath.Join(chDir, "stderr.log")
	detachProcess(c)

	stdout, err := os.Create(stdoutPath)
	if err != nil {
		return fmt.Errorf("failed to create stdout log file: %v", err)
	}
	defer stdout.Close()
	c.Stdout = stdout

	stderr, err := os.Create(stderrPath)
	if err != nil {
		return fmt.Errorf("failed to create stderr log file: %v", err)
	}
	defer stderr.Close()
	c.Stderr = stderr

	if err := c.Start(); err != nil {
		return fmt.Errorf("failed to start crush server: %v", err)
	}

	if err := c.Process.Release(); err != nil {
		return fmt.Errorf("failed to detach crush server process: %v", err)
	}

	return nil
}

func shouldEnableMetrics(cfg *config.Config) bool {
	if v, _ := strconv.ParseBool(os.Getenv("CRUSH_DISABLE_METRICS")); v {
		return false
	}
	if v, _ := strconv.ParseBool(os.Getenv("DO_NOT_TRACK")); v {
		return false
	}
	if cfg.Options.DisableMetrics {
		return false
	}
	return true
}

func MaybePrependStdin(prompt string) (string, error) {
	if term.IsTerminal(os.Stdin.Fd()) {
		return prompt, nil
	}
	fi, err := os.Stdin.Stat()
	if err != nil {
		return prompt, err
	}
	// Check if stdin is a named pipe ( | ) or regular file ( < ).
	if fi.Mode()&os.ModeNamedPipe == 0 && !fi.Mode().IsRegular() {
		return prompt, nil
	}
	bts, err := io.ReadAll(os.Stdin)
	if err != nil {
		return prompt, err
	}
	return string(bts) + "\n\n" + prompt, nil
}

// resolveWorkspaceSessionID resolves a session ID that may be a full
// UUID, full hash, or hash prefix. Works against the Workspace
// interface so both local and client/server paths get hash prefix
// support.
func resolveWorkspaceSessionID(ctx context.Context, ws workspace.Workspace, id string) (session.Session, error) {
	if sess, err := ws.GetSession(ctx, id); err == nil {
		return sess, nil
	}

	sessions, err := ws.ListSessions(ctx)
	if err != nil {
		return session.Session{}, err
	}

	var matches []session.Session
	for _, s := range sessions {
		hash := session.HashID(s.ID)
		if hash == id || strings.HasPrefix(hash, id) {
			matches = append(matches, s)
		}
	}

	switch len(matches) {
	case 0:
		return session.Session{}, fmt.Errorf("session not found: %s", id)
	case 1:
		return matches[0], nil
	default:
		return session.Session{}, fmt.Errorf("session ID %q is ambiguous (%d matches)", id, len(matches))
	}
}

func ResolveCwd(cmd *cobra.Command) (string, error) {
	cwd, _ := cmd.Flags().GetString("cwd")
	if cwd != "" {
		err := os.Chdir(cwd)
		if err != nil {
			return "", fmt.Errorf("failed to change directory: %v", err)
		}
		return cwd, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get current working directory: %v", err)
	}
	return cwd, nil
}

func createDotCrushDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("failed to create data directory: %q %w", dir, err)
	}

	gitIgnorePath := filepath.Join(dir, ".gitignore")
	content, err := os.ReadFile(gitIgnorePath)

	// create or update if old version
	if os.IsNotExist(err) || string(content) == oldGitIgnore {
		if err := os.WriteFile(gitIgnorePath, []byte(defaultGitIgnore), 0o644); err != nil {
			return fmt.Errorf("failed to create .gitignore file: %q %w", gitIgnorePath, err)
		}
	}

	return nil
}

//go:embed gitignore/old
var oldGitIgnore string

//go:embed gitignore/default
var defaultGitIgnore string
