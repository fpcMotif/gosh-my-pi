package workspace

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

// agent_end / message_end carry a top-level errorKind classifying a recoverable
// or fatal failure (context_overflow / usage_limit / transient / fatal). The Go
// bridge dropped it, so the loop could stall with a generic end-turn and no
// explanation (gap G3). These contracts pin that it is surfaced.

func TestDescribeAgentErrorKind(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // substring that must appear
	}{
		{"usage limit with retry", `{"errorKind":{"kind":"usage_limit","retryAfterMs":30000}}`, "Usage limit"},
		{"usage limit shows retry window", `{"errorKind":{"kind":"usage_limit","retryAfterMs":30000}}`, "30s"},
		{"context overflow", `{"errorKind":{"kind":"context_overflow","usedTokens":12345}}`, "Context window full"},
		{"transient names reason", `{"errorKind":{"kind":"transient","reason":"rate_limit"}}`, "rate_limit"},
		{"fatal", `{"errorKind":{"kind":"fatal"}}`, "Fatal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := describeAgentErrorKind([]byte(tc.raw))
			if !ok {
				t.Fatalf("describeAgentErrorKind(%s) ok=false, want a description", tc.raw)
			}
			if !strings.Contains(got, tc.want) {
				t.Errorf("description %q does not contain %q", got, tc.want)
			}
		})
	}
}

func TestDescribeAgentErrorKindAbsent(t *testing.T) {
	for _, raw := range []string{`{}`, `{"errorKind":null}`, `{"messages":[]}`} {
		if _, ok := describeAgentErrorKind([]byte(raw)); ok {
			t.Errorf("describeAgentErrorKind(%s) ok=true, want false (no errorKind)", raw)
		}
	}
}

func TestApplyWireErrorKindReplacesFinish(t *testing.T) {
	msg := message.Message{Role: message.Assistant}
	msg.AddFinish(message.FinishReasonEndTurn, "", "") // a prior generic finish

	if !applyWireErrorKind(&msg, []byte(`{"errorKind":{"kind":"usage_limit","retryAfterMs":5000}}`)) {
		t.Fatal("applyWireErrorKind returned false, want true")
	}
	fin, ok := finishPart(msg)
	if !ok {
		t.Fatal("no Finish part after applyWireErrorKind")
	}
	if fin.Reason != message.FinishReasonError {
		t.Errorf("Finish.Reason = %q, want %q", fin.Reason, message.FinishReasonError)
	}
	if !strings.Contains(fin.Message, "Usage limit") {
		t.Errorf("Finish.Message = %q, want it to name the usage limit", fin.Message)
	}
}

func TestApplyWireErrorKindIgnoresNonAssistant(t *testing.T) {
	msg := message.Message{Role: message.User}
	if applyWireErrorKind(&msg, []byte(`{"errorKind":{"kind":"fatal"}}`)) {
		t.Error("applyWireErrorKind mutated a non-assistant message")
	}
}

// Wiring: message_end with an errorKind enriches the assistant card's finish.
func TestHandleMessageEndSurfacesErrorKind(t *testing.T) {
	w := newTestGmpWorkspace()
	w.currentAssistantID = "asst-1"
	raw := []byte(`{"message":{"role":"assistant","content":[{"type":"text","text":"partial"}]},` +
		`"errorKind":{"kind":"context_overflow","usedTokens":999}}`)

	msg := w.handleMessageEnd(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleMessageEnd returned %T, want pubsub.Event[message.Message]", msg)
	}
	fin, ok := finishPart(ev.Payload)
	if !ok {
		t.Fatal("assistant message has no Finish after message_end with errorKind")
	}
	if fin.Reason != message.FinishReasonError || !strings.Contains(fin.Message, "Context window full") {
		t.Errorf("finish = {%q, %q}, want error + context-overflow text", fin.Reason, fin.Message)
	}
}

func finishPart(m message.Message) (message.Finish, bool) {
	for _, part := range m.Parts {
		if fin, ok := part.(message.Finish); ok {
			return fin, true
		}
	}
	return message.Finish{}, false
}
