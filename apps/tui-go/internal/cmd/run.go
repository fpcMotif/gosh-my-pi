package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"time"

	"charm.land/log/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/event"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
	Aliases: []string{"r"},
	Use:     "run [prompt...]",
	Short:   "Run a single non-interactive prompt against the gmp backend",
	Long: `Run a single prompt in non-interactive mode and exit.

The prompt can be provided as arguments or piped from stdin. The
gmp coding-agent backend is spawned as a one-shot ` + "`gmp --mode rpc`" + ` subprocess, the prompt is dispatched, assistant
text is streamed to stdout, and the process exits when the agent
completes the turn. See ADR 0002.`,
	Example: `
# Run a simple prompt
gmp-tui-go run "Guess my 5 favorite Pokémon"

# Pipe input from stdin
curl https://charm.land | gmp-tui-go run "Summarize this website"

# Read from a file
gmp-tui-go run "What is this code doing?" <<< prrr.go

# Redirect output to a file
gmp-tui-go run "Generate a hot README for this project" > MY_HOT_README.md

# Run in verbose mode (show backend stderr inline)
gmp-tui-go run --verbose "Generate a README for this project"

# Pick a specific model
gmp-tui-go run --model openai-codex/gpt-5 "Refactor this function"
  `,
	RunE: func(cmd *cobra.Command, args []string) error {
		var (
			verbose, _    = cmd.Flags().GetBool("verbose")
			largeModel, _ = cmd.Flags().GetString("model")
		)

		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
		defer cancel()

		prompt := strings.Join(args, " ")

		prompt, err := MaybePrependStdin(prompt)
		if err != nil {
			slog.Error("Failed to read from stdin", "error", err)
			return err
		}

		if prompt == "" {
			return errors.New("no prompt provided")
		}

		event.SetNonInteractive(true)
		event.AppInitialized()

		if verbose {
			slog.SetDefault(slog.New(log.New(os.Stderr)))
		}

		return runGmpPrompt(ctx, cmd, prompt, largeModel, verbose)
	},
}

func init() {
	runCmd.Flags().BoolP("quiet", "q", false, "(Reserved; deprecated under the gmp RPC backend.)")
	runCmd.Flags().BoolP("verbose", "v", false, "Tee backend stderr to this terminal")
	runCmd.Flags().StringP("model", "m", "", "Model to use (provider/model, e.g. openai-codex/gpt-5)")
	runCmd.Flags().String("small-model", "", "(Reserved; deprecated under the gmp RPC backend.)")
	runCmd.Flags().StringP("session", "s", "", "(Reserved; the gmp backend manages session continuity itself.)")
	runCmd.Flags().BoolP("continue", "C", false, "(Reserved; deprecated under the gmp RPC backend.)")
}

// runGmpPrompt spawns a one-shot `gmp --mode rpc` subprocess, sends the
// prompt, streams assistant text deltas to stdout, and returns when the
// agent finishes the turn. Mirrors the contract of `gmp-tui-go login`'s
// authCLIDriver: thin RPC wrapper over the same wire vocabulary the
// interactive TUI uses.
//
// Differences from the legacy in-process / client-server flow:
//   - No persistent session list management — the backend creates a
//     fresh session on each invocation.
//   - No model-search across catwalk providers — `--model` is
//     forwarded verbatim to the backend's set_model RPC; backend
//     reports unknown ids as a typed error.
//   - No spinner — output streams as the agent emits text deltas.
func runGmpPrompt(ctx context.Context, cmd *cobra.Command, prompt, modelStr string, verbose bool) error {
	cwd, err := ResolveCwd(cmd)
	if err != nil {
		return err
	}

	ompStderr, err := setupOmpLogging(verbose)
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

	// Auto-cancel any extension_ui_request frames the backend emits
	// (non-interactive run doesn't host dialogs).
	go drainExtensionUIRequests(ctx, client)

	if err := maybeSetModel(ctx, client, modelStr); err != nil {
		return err
	}

	if err := dispatchPrompt(ctx, client, prompt); err != nil {
		return err
	}

	return drainAssistantOutput(ctx, client, os.Stdout)
}

// maybeSetModel forwards the --model flag to the backend's set_model
// RPC if specified. Format: "provider/modelId".
func maybeSetModel(ctx context.Context, client *ompclient.Client, modelStr string) error {
	if modelStr == "" {
		return nil
	}
	provider, modelID, ok := strings.Cut(modelStr, "/")
	if !ok || provider == "" || modelID == "" {
		return fmt.Errorf("invalid --model %q: expected provider/modelId", modelStr)
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.Call(callCtx, ompclient.Command{
		Type:     "set_model",
		Provider: provider,
		ModelID:  modelID,
	})
	if err != nil {
		return fmt.Errorf("set_model: %w", err)
	}
	if resp != nil && !resp.Success {
		return fmt.Errorf("set_model: %s", resp.Error)
	}
	return nil
}

// dispatchPrompt sends the prompt and confirms the backend acked it.
// The backend streams response events asynchronously after this returns.
func dispatchPrompt(ctx context.Context, client *ompclient.Client, prompt string) error {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	resp, err := client.Call(callCtx, ompclient.Command{
		Type:    "prompt",
		Message: prompt,
	})
	if err != nil {
		return fmt.Errorf("prompt: %w", err)
	}
	if resp != nil && !resp.Success {
		return fmt.Errorf("prompt: %s", resp.Error)
	}
	return nil
}

// drainAssistantOutput consumes agent events until agent_end and
// streams the assistant's text_delta and thinking_delta payloads to
// out. Returns nil on a clean turn end, or the surfaced error from a
// message_update.error / agent_end.error frame.
func drainAssistantOutput(ctx context.Context, client *ompclient.Client, out io.Writer) error {
	defer fmt.Fprintln(out)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-client.Events():
			if !ok {
				return nil
			}
			done, err := handleAgentEvent(ev, out)
			if err != nil {
				return err
			}
			if done {
				return nil
			}
		}
	}
}

// handleAgentEvent processes one agent event and returns (done,
// error). done=true signals end-of-turn (agent_end). Errors come from
// message_update.error or agent_end.error.
func handleAgentEvent(ev *ompclient.AgentEvent, out io.Writer) (bool, error) {
	switch ev.Kind {
	case "agent_end":
		return true, parseAgentEndError(ev.Payload)
	case "message_update":
		return false, handleMessageUpdate(ev.Payload, out)
	}
	return false, nil
}

// handleMessageUpdate writes text_delta payloads to out. Other delta
// types (thinking_delta, tool calls) are silently dropped — a future
// PR can expose them via a flag.
func handleMessageUpdate(raw json.RawMessage, out io.Writer) error {
	var msg struct {
		AssistantMessageEvent struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Error *struct {
				ErrorMessage string `json:"errorMessage"`
			} `json:"error"`
		} `json:"assistantMessageEvent"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil //nolint:nilerr // malformed event => skip rather than fail the run
	}
	switch msg.AssistantMessageEvent.Type {
	case "text_delta":
		if msg.AssistantMessageEvent.Delta != "" {
			_, _ = io.WriteString(out, msg.AssistantMessageEvent.Delta)
		}
	case "error":
		text := "request failed"
		if msg.AssistantMessageEvent.Error != nil && msg.AssistantMessageEvent.Error.ErrorMessage != "" {
			text = msg.AssistantMessageEvent.Error.ErrorMessage
		}
		return fmt.Errorf("agent error: %s", text)
	}
	return nil
}

// parseAgentEndError surfaces a non-nil error if the agent_end event
// reports a non-success stopReason. Treats any non-empty errorMessage
// as fatal.
func parseAgentEndError(raw json.RawMessage) error {
	var payload struct {
		ErrorMessage string `json:"errorMessage"`
		StopReason   string `json:"stopReason"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil //nolint:nilerr // malformed agent_end => treat as clean
	}
	if payload.ErrorMessage != "" {
		return fmt.Errorf("agent_end error: %s", payload.ErrorMessage)
	}
	return nil
}

// drainExtensionUIRequests auto-cancels any inbound extension_ui_request
// frame. In non-interactive mode there is no dialog host, so dialogs
// must default-cancel rather than stall the agent.
func drainExtensionUIRequests(ctx context.Context, client *ompclient.Client) {
	for {
		select {
		case <-ctx.Done():
			return
		case req, ok := <-client.ExtensionUIRequests():
			if !ok {
				return
			}
			if req == nil || req.ID == "" {
				continue
			}
			_ = client.Send(ompclient.ExtensionUIResp{
				Type:      "extension_ui_response",
				ID:        req.ID,
				Cancelled: true,
			})
		}
	}
}
