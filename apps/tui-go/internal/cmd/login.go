package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/atotto/clipboard"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// loginCmd drives gmp's AuthStorage.login flow over a one-shot RPC
// subprocess. Credentials persist in gmp's SQLite (via AuthStorage),
// never in Crush's local crush.json — see
// docs/adr/0001-gmp-mode-credential-store.md. The TUI's `/login` slash
// command shares the same RPC contract; this command is the
// non-interactive (CLI) entry point.
var loginCmd = &cobra.Command{
	Aliases: []string{"auth"},
	Use:     "login [provider]",
	Short:   "Sign in to a gmp-managed provider",
	Long: `Sign in to a gmp-managed provider.

Spawns a one-shot gmp RPC subprocess and dispatches an auth.login
command. The CLI consumes the resulting auth.* extension_ui_request
frames (URL, code prompts, picker, final result) interactively over
stdin/stdout. Credentials are stored by gmp's AuthStorage; nothing
is written to Crush's local config.

When invoked without a provider, gmp opens its provider picker.`,
	Example: `
# Pick interactively
gmp-tui-go login

# Sign in to a specific provider
gmp-tui-go login openai-codex
  `,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		provider := ""
		if len(args) > 0 {
			provider = args[0]
		}
		return runGmpLogin(cmd, auth.CommandLogin, provider)
	},
}

// logoutCmd is the symmetric counterpart for clearing a provider
// credential. Identical RPC contract; gmp side handles the deletion
// against AuthStorage.
var logoutCmd = &cobra.Command{
	Use:   "logout <provider>",
	Short: "Sign out of a gmp-managed provider",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runGmpLogin(cmd, auth.CommandLogout, args[0])
	},
}

// runGmpLogin spawns a one-shot RPC client, sends the auth command,
// and drives the resulting extension_ui_request flow on the terminal
// until the gmp side emits auth.show_result. Returns the surfaced
// error (if any) so the CLI exits non-zero on failure.
func runGmpLogin(cmd *cobra.Command, method, provider string) error {
	ctx, cancel := signal.NotifyContext(cmd.Context(), os.Interrupt, os.Kill)
	defer cancel()

	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return err
	}
	debug, _ := cmd.Flags().GetBool("debug")
	ompStderr, err := setupOmpLogging(debug)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gmp-tui-go: warning: log setup failed: %v\n", err)
	}
	backend := resolveOmpBackend(cmd)
	client, err := ompclient.Spawn(ctx, ompclient.Options{
		Bin:        backend[0],
		PrefixArgs: backend[1:],
		Cwd:        cwd,
		Env:        os.Environ(),
		Stderr:     ompStderr,
	})
	if err != nil {
		return fmt.Errorf("spawn gmp backend: %w", err)
	}
	defer func() { _ = client.Close() }()

	driver := newAuthCLIDriver(client)
	driverDone := driver.run(ctx)

	callCtx, callCancel := context.WithTimeout(ctx, 30*time.Second)
	defer callCancel()
	resp, err := client.Call(callCtx, ompclient.Command{Type: method, Provider: provider})
	if err != nil {
		return fmt.Errorf("gmp %s ack: %w", method, err)
	}
	if resp != nil && !resp.Success && resp.Error != "" {
		return errors.New(resp.Error)
	}

	// Wait for the driver to receive auth.show_result (or for ctx to
	// fire). The driver returns the result on driverDone.
	select {
	case res := <-driverDone:
		if res != nil && !res.success {
			if res.errMsg != "" {
				return fmt.Errorf("auth flow failed: %s", res.errMsg)
			}
			return errors.New("auth flow failed")
		}
		fmt.Println()
		fmt.Println("You're signed in.")
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// authCLIDriver consumes auth.* extension_ui_request frames from the
// gmp backend and drives the flow on the terminal. The TUI uses the
// GmpAuth Bubble Tea dialog for the same wire contract; this is the
// shell-friendly version for `gmp-tui-go login`.
type authCLIDriver struct {
	client *ompclient.Client
}

type authCLIResult struct {
	success bool
	errMsg  string
}

func newAuthCLIDriver(c *ompclient.Client) *authCLIDriver {
	return &authCLIDriver{client: c}
}

// run consumes extension_ui_request frames in a goroutine and returns
// a channel that emits exactly one authCLIResult once the flow ends
// (auth.show_result observed, channel closed, or ctx cancelled).
func (d *authCLIDriver) run(ctx context.Context) <-chan *authCLIResult {
	out := make(chan *authCLIResult, 1)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case req, ok := <-d.client.ExtensionUIRequests():
				if !ok {
					return
				}
				if req == nil || req.ID == "" {
					continue
				}
				done, res := d.handle(req)
				if done {
					out <- res
					return
				}
			}
		}
	}()
	return out
}

// handle processes one inbound auth.* request and posts the matching
// extension_ui_response. Returns done=true when the flow has reached
// its terminal state (show_result), so the caller stops consuming.
// Non-auth methods auto-cancel — same default as the GmpWorkspace
// dispatcher.
func (d *authCLIDriver) handle(req *ompclient.ExtensionUIReq) (bool, *authCLIResult) {
	if !strings.HasPrefix(req.Method, "auth.") {
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: req.ID, Cancelled: true,
		})
		return false, nil
	}

	var p struct {
		Provider     string   `json:"provider"`
		URL          string   `json:"url"`
		Instructions string   `json:"instructions"`
		Message      string   `json:"message"`
		Placeholder  string   `json:"placeholder"`
		AllowEmpty   bool     `json:"allowEmpty"`
		Success      bool     `json:"success"`
		Error        string   `json:"error"`
		Options      []string `json:"options"`
		DefaultID    string   `json:"defaultId"`
	}
	if err := json.Unmarshal(req.Raw, &p); err != nil {
		fmt.Fprintf(os.Stderr, "auth: failed to parse %s payload: %v\n", req.Method, err)
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: req.ID, Cancelled: true,
		})
		return false, nil
	}

	switch req.Method {
	case auth.MethodShowLoginURL:
		return false, d.handleShowLoginURL(req.ID, p.URL, p.Instructions)
	case auth.MethodShowProgress:
		fmt.Println(p.Message)
		return false, nil
	case auth.MethodPromptCode:
		return false, d.handlePromptCode(req.ID, p.Placeholder, p.AllowEmpty)
	case auth.MethodPromptManualRedirect:
		return false, d.handlePromptCode(req.ID, "Paste the full callback URL", true)
	case auth.MethodPickProvider:
		return false, d.handlePickProvider(req.ID, p.Options, p.DefaultID)
	case auth.MethodShowResult:
		return true, &authCLIResult{success: p.Success, errMsg: p.Error}
	default:
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: req.ID, Cancelled: true,
		})
		return false, nil
	}
}

func (d *authCLIDriver) handleShowLoginURL(id, url, instructions string) *authCLIResult {
	if instructions != "" {
		fmt.Println(instructions)
	}
	fmt.Println()
	fmt.Println("Open this URL in your browser:")
	fmt.Println(lipgloss.NewStyle().Bold(true).Render(url))
	if clipboard.WriteAll(url) == nil {
		fmt.Println("(URL copied to clipboard.)")
	}
	if err := browser.OpenURL(url); err != nil {
		fmt.Println("Could not open browser; copy the URL above manually.")
	}
	confirmed := true
	_ = d.client.Send(ompclient.ExtensionUIResp{
		Type: "extension_ui_response", ID: id, Confirmed: &confirmed,
	})
	return nil
}

func (d *authCLIDriver) handlePromptCode(id, placeholder string, allowEmpty bool) *authCLIResult {
	prompt := placeholder
	if prompt == "" {
		prompt = "Enter value"
	}
	for {
		fmt.Printf("%s: ", prompt)
		var line string
		if _, err := fmt.Scanln(&line); err != nil {
			line = ""
		}
		line = strings.TrimSpace(line)
		if line == "" && !allowEmpty {
			fmt.Println("(value cannot be empty)")
			continue
		}
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: id, Value: line,
		})
		return nil
	}
}

func (d *authCLIDriver) handlePickProvider(id string, options []string, defaultID string) *authCLIResult {
	if len(options) == 0 {
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: id, Cancelled: true,
		})
		return nil
	}
	fmt.Println("Pick a provider:")
	for i, opt := range options {
		marker := "  "
		if opt == defaultID {
			marker = "* "
		}
		fmt.Printf("  %d) %s%s\n", i+1, marker, opt)
	}
	for {
		fmt.Print("Selection: ")
		var line string
		if _, err := fmt.Scanln(&line); err != nil {
			line = ""
		}
		line = strings.TrimSpace(line)
		if line == "" && defaultID != "" {
			line = defaultID
		}
		// Accept either index or literal id.
		if idx, err := strconv.Atoi(line); err == nil && idx >= 1 && idx <= len(options) {
			line = options[idx-1]
		}
		valid := false
		for _, opt := range options {
			if opt == line {
				valid = true
				break
			}
		}
		if !valid {
			fmt.Println("(unknown selection, try again)")
			continue
		}
		_ = d.client.Send(ompclient.ExtensionUIResp{
			Type: "extension_ui_response", ID: id, Value: line,
		})
		return nil
	}
}
