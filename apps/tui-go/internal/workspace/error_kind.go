package workspace

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
)

// wireErrorKind mirrors the OMP-RPC WireErrorKindV1 union carried on the
// top-level errorKind field of agent_end / message_end. pi-agent-core classifies
// the failure once at the emission boundary; auto_retry_* events are off-wire, so
// errorKind is the only recoverable/fatal signal the host receives.
type wireErrorKind struct {
	Kind         string `json:"kind"`
	RetryAfterMs int64  `json:"retryAfterMs"`
	UsedTokens   int64  `json:"usedTokens"`
	Reason       string `json:"reason"`
}

// isReasonlessFatal reports whether this is the bare, uninformative fatal
// classification: `{kind:"fatal"}` with no `reason`. Distinguishing this case
// matters for applyWireErrorKind's merge rule below — every other kind
// (including a reason-ful fatal) carries strictly more information than
// whatever Finish message gmp_parse.go already attached.
func (e wireErrorKind) isReasonlessFatal() bool {
	return e.Kind == "fatal" && e.Reason == ""
}

func (e wireErrorKind) describe() string {
	switch e.Kind {
	case "context_overflow":
		if e.UsedTokens > 0 {
			return fmt.Sprintf("Context window full (%d tokens used)", e.UsedTokens)
		}
		return "Context window full"
	case "usage_limit":
		if e.RetryAfterMs > 0 {
			return fmt.Sprintf("Usage limit reached, retry in %s", humanizeMillis(e.RetryAfterMs))
		}
		return "Usage limit reached"
	case "transient":
		if e.Reason != "" {
			return fmt.Sprintf("Temporary error (%s), retrying", e.Reason)
		}
		return "Temporary error, retrying"
	case "fatal":
		if e.Reason != "" {
			return fmt.Sprintf("Fatal error: %s", e.Reason)
		}
		return "Fatal error"
	default:
		slog.Warn("gmp workspace: unknown errorKind", "kind", e.Kind)
		return ""
	}
}

func humanizeMillis(ms int64) string {
	return ((time.Duration(ms) * time.Millisecond).Round(time.Second)).String()
}

// parseWireErrorKind extracts the errorKind payload from an agent_end /
// message_end frame. Returns (nil, false) when absent or malformed.
func parseWireErrorKind(raw []byte) (*wireErrorKind, bool) {
	var p struct {
		ErrorKind *wireErrorKind `json:"errorKind"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ErrorKind == nil {
		return nil, false
	}
	return p.ErrorKind, true
}

// describeAgentErrorKind extracts a user-facing description of the errorKind on
// an agent_end / message_end payload. Returns ("", false) when absent or unknown.
func describeAgentErrorKind(raw []byte) (string, bool) {
	ek, ok := parseWireErrorKind(raw)
	if !ok {
		return "", false
	}
	desc := ek.describe()
	if desc == "" {
		return "", false
	}
	return desc, true
}

// applyWireErrorKind enriches an assistant message's finish with the errorKind
// description when the terminating event classified the turn as an error.
// AddFinish replaces any prior generic finish, so the card shows the reason
// instead of a silent end-turn. Returns true when a finish was applied.
//
// Exception: a reason-less generic fatal (`{kind:"fatal"}`, no `reason`) is
// strictly less informative than a Finish message gmp_parse.go may already
// have attached from the assistant message's own (full-text) errorMessage —
// overwriting it would clobber the real cause with the bare label "Fatal
// error". When that prior, non-empty Finish message exists, skip the
// overwrite and return false. Every other kind (including a reason-ful fatal)
// keeps replacing, since its description is strictly more informative than
// whatever came before.
func applyWireErrorKind(msg *message.Message, raw []byte) bool {
	if msg.Role != message.Assistant {
		return false
	}
	ek, ok := parseWireErrorKind(raw)
	if !ok {
		return false
	}
	desc := ek.describe()
	if desc == "" {
		return false
	}
	if ek.isReasonlessFatal() {
		if fin := msg.FinishPart(); fin != nil && fin.Message != "" {
			return false
		}
	}
	msg.AddFinish(message.FinishReasonError, desc, "")
	return true
}
