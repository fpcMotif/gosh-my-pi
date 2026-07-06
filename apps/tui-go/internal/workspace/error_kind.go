package workspace

import (
	"encoding/json"
	"fmt"
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
		return "Fatal error"
	default:
		return ""
	}
}

func humanizeMillis(ms int64) string {
	return ((time.Duration(ms) * time.Millisecond).Round(time.Second)).String()
}

// describeAgentErrorKind extracts a user-facing description of the errorKind on
// an agent_end / message_end payload. Returns ("", false) when absent or unknown.
func describeAgentErrorKind(raw []byte) (string, bool) {
	var p struct {
		ErrorKind *wireErrorKind `json:"errorKind"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ErrorKind == nil {
		return "", false
	}
	desc := p.ErrorKind.describe()
	if desc == "" {
		return "", false
	}
	return desc, true
}

// applyWireErrorKind enriches an assistant message's finish with the errorKind
// description when the terminating event classified the turn as an error.
// AddFinish replaces any prior generic finish, so the card shows the reason
// instead of a silent end-turn. Returns true when a finish was applied.
func applyWireErrorKind(msg *message.Message, raw []byte) bool {
	if msg.Role != message.Assistant {
		return false
	}
	desc, ok := describeAgentErrorKind(raw)
	if !ok {
		return false
	}
	msg.AddFinish(message.FinishReasonError, desc, "")
	return true
}
