package workspace

import (
	"context"
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

// partialWithBashCall builds a message_update payload carrying a `partial`
// assistant snapshot whose content[0] is a streaming bash tool call with the
// given (possibly partial) arguments JSON. This mirrors the backend wire shape:
// toolcall_start / toolcall_delta both carry {contentIndex, partial}.
func partialWithBashCall(subType, args string) []byte {
	return []byte(`{"type":"message_update","assistantMessageEvent":{` +
		`"type":"` + subType + `","contentIndex":0,` +
		`"partial":{"role":"assistant","content":[` +
		`{"type":"toolCall","id":"call-1","name":"bash","arguments":` + args + `}` +
		`],"timestamp":1700000000000}}}`)
}

func toolCallByID(msg message.Message, id string) (message.ToolCall, bool) {
	for _, tc := range msg.ToolCalls() {
		if tc.ID == id {
			return tc, true
		}
	}
	return message.ToolCall{}, false
}

func startStreamingWorkspace(t *testing.T) *GmpWorkspace {
	t.Helper()
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hello")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant
	return w
}

// TestStreamingToolCallProgressesSingleCard feeds toolcall_start followed by two
// toolcall_delta frames. Each frame must update the same assistant tool call
// (keyed by id) so its Input reflects the latest partial arguments, and each
// must emit an UpdatedEvent so the card re-renders live.
func TestStreamingToolCallProgressesSingleCard(t *testing.T) {
	w := startStreamingWorkspace(t)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_start", `{}`),
	})
	ev := nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent {
		t.Fatalf("toolcall_start event type=%v want UpdatedEvent", ev.Type)
	}
	tc, ok := toolCallByID(ev.Payload, "call-1")
	if !ok || tc.Name != "bash" || tc.Finished {
		t.Fatalf("toolcall_start call=%#v want unfinished bash call-1", tc)
	}

	// The backend re-stringifies partial.arguments cleanly, so each snapshot is
	// valid JSON even though the model is mid-stream. Earlier snapshot: only a
	// prefix of the command has streamed.
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_delta", `{"command":"echo h"}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent {
		t.Fatalf("first delta event type=%v want UpdatedEvent", ev.Type)
	}
	tc, _ = toolCallByID(ev.Payload, "call-1")
	if !strings.Contains(tc.Input, `"command":"echo h"`) {
		t.Fatalf("first delta input=%q want partial command", tc.Input)
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_delta", `{"command":"echo hello"}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent {
		t.Fatalf("second delta event type=%v want UpdatedEvent", ev.Type)
	}
	tc, _ = toolCallByID(ev.Payload, "call-1")
	if tc.Input != `{"command":"echo hello"}` {
		t.Fatalf("second delta input=%q want accumulated command", tc.Input)
	}

	// Exactly one tool call exists after the whole stream — reconciliation from
	// the partial snapshot must not append duplicates per delta.
	if calls := ev.Payload.ToolCalls(); len(calls) != 1 {
		t.Fatalf("tool call count=%d want 1 after streaming", len(calls))
	}
}

// TestStreamingToolCallReconcilesWithExecutionStart asserts the streaming path
// and the separate tool_execution_start flow produce a single card: the
// execution-start for the same toolCallId updates the existing tool call in
// place (id-keyed AddToolCall) rather than appending a duplicate.
func TestStreamingToolCallReconcilesWithExecutionStart(t *testing.T) {
	w := startStreamingWorkspace(t)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_start", `{}`),
	})
	nextMessageEvent(t, w)
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_delta", `{"command":"echo hi"}`),
	})
	nextMessageEvent(t, w)

	// Same toolCallId now arrives via the execution flow.
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "tool_execution_start",
		Payload: []byte(`{"type":"tool_execution_start","toolCallId":"call-1","toolName":"bash","args":{"command":"echo hi"}}`),
	})
	ev := nextMessageEvent(t, w)

	calls := ev.Payload.ToolCalls()
	if len(calls) != 1 {
		t.Fatalf("tool call count=%d want 1 (no duplicate from execution start)", len(calls))
	}
	if calls[0].ID != "call-1" || calls[0].Finished {
		t.Fatalf("reconciled call=%#v want unfinished call-1 (executing)", calls[0])
	}

	// And the lifecycle still completes: execution end finishes the same card.
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "tool_execution_end",
		Payload: []byte(`{"type":"tool_execution_end","toolCallId":"call-1","toolName":"bash","result":{"content":"hi"},"isError":false}`),
	})
	finished := nextMessageEvent(t, w)
	calls = finished.Payload.ToolCalls()
	if len(calls) != 1 || !calls[0].Finished {
		t.Fatalf("after execution end calls=%#v want single finished call", calls)
	}
}

// TestStreamingToolCallDoesNotCorruptSiblingText ensures a tool-call sub-event
// does not touch the assistant's interleaved text content. Text and tool calls
// share the message; only their respective parts must change.
func TestStreamingToolCallDoesNotCorruptSiblingText(t *testing.T) {
	w := startStreamingWorkspace(t)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Running: "}}`),
	})
	nextMessageEvent(t, w)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_delta", `{"command":"ls"}`),
	})
	ev := nextMessageEvent(t, w)

	if ev.Payload.Content().Text != "Running: " {
		t.Fatalf("sibling text=%q want unchanged 'Running: '", ev.Payload.Content().Text)
	}
	tc, ok := toolCallByID(ev.Payload, "call-1")
	if !ok || !strings.Contains(tc.Input, `"command":"ls"`) {
		t.Fatalf("tool call=%#v want ls command alongside text", tc)
	}
}

// TestStreamingToolCallEndFinalizes asserts toolcall_end marks the streamed
// tool call finished using the explicit wire toolCall payload.
func TestStreamingToolCallEndFinalizes(t *testing.T) {
	w := startStreamingWorkspace(t)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: partialWithBashCall("toolcall_start", `{}`),
	})
	nextMessageEvent(t, w)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind: "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{` +
			`"type":"toolcall_end","contentIndex":0,` +
			`"toolCall":{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"echo done"}},` +
			`"partial":{"role":"assistant","content":[` +
			`{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"echo done"}}` +
			`],"timestamp":1700000000000}}}`),
	})
	ev := nextMessageEvent(t, w)

	calls := ev.Payload.ToolCalls()
	if len(calls) != 1 || !calls[0].Finished {
		t.Fatalf("toolcall_end calls=%#v want single finished call", calls)
	}
	if !strings.Contains(calls[0].Input, `"command":"echo done"`) {
		t.Fatalf("toolcall_end input=%q want final command", calls[0].Input)
	}
}

// TestStreamingToolCallIgnoresNonToolBlock ensures a tool-call sub-event whose
// partial content[contentIndex] is not a tool call (interleaved text) is
// ignored rather than producing a spurious empty tool call.
func TestStreamingToolCallIgnoresNonToolBlock(t *testing.T) {
	w := startStreamingWorkspace(t)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind: "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{` +
			`"type":"toolcall_delta","contentIndex":0,` +
			`"partial":{"role":"assistant","content":[` +
			`{"type":"text","text":"not a tool call"}` +
			`],"timestamp":1700000000000}}}`),
	})

	select {
	case msg := <-w.events:
		t.Fatalf("expected no event for non-tool-call block, got %T", msg)
	default:
	}
}
