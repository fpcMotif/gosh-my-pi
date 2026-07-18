package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

var errThinkingClientUnavailable = errors.New("gmp backend: thinking level requires an RPC client")

// ThinkingLevel returns the last acknowledged backend thinking level.
func (w *GmpWorkspace) ThinkingLevel() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.thinkingLevel
}

// SetThinkingLevel changes the backend session setting. Local state changes
// only after the backend acknowledges the command.
func (w *GmpWorkspace) SetThinkingLevel(ctx context.Context, level string) error {
	if !isThinkingLevel(level) {
		return fmt.Errorf("unsupported thinking level %q", level)
	}
	if w.client == nil {
		return errThinkingClientUnavailable
	}
	// The receipt includes effective session state, so it must not race a
	// model selection or get_state snapshot that could otherwise commit an
	// older thinking level after this call succeeds.
	if err := w.acquireCatalogOp(ctx); err != nil {
		return err
	}
	defer w.releaseCatalogOp()
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "set_thinking_level", Level: level})
	if err != nil {
		return err
	}
	acknowledged, err := parseSetThinkingLevelResponse(resp.Data)
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.setThinkingLevelLocked(optionalThinkingLevel(acknowledged))
	w.mu.Unlock()
	return nil
}

func parseSetThinkingLevelResponse(data []byte) (*string, error) {
	if len(data) == 0 || string(data) == "null" {
		return nil, errors.New("set_thinking_level response must include thinkingLevel")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, fmt.Errorf("parse set_thinking_level response: %w", err)
	}
	thinkingData, ok := fields["thinkingLevel"]
	if !ok {
		return nil, errors.New("set_thinking_level response must include thinkingLevel")
	}
	return parseNullableThinkingLevel(thinkingData, "set_thinking_level")
}

func isThinkingLevel(level string) bool {
	switch level {
	case "inherit", "off", "minimal", "low", "medium", "high", "xhigh":
		return true
	default:
		return false
	}
}

func (w *GmpWorkspace) setThinkingLevelLocked(level string) {
	w.thinkingLevel = level
	if level == "" || level == "inherit" || level == "off" {
		w.model.ModelCfg.Think = false
		w.model.ModelCfg.ReasoningEffort = ""
		return
	}
	w.model.ModelCfg.Think = true
	w.model.ModelCfg.ReasoningEffort = level
}
