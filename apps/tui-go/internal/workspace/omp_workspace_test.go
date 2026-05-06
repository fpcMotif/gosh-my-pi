package workspace

import (
	"context"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

func newTestOmpWorkspace() *OmpWorkspace {
	w := NewOmpWorkspace(nil, "/tmp/project")
	w.events = make(chan tea.Msg, 16)
	return w
}

func TestOmpWorkspacePromptAndStreamEvents(t *testing.T) {
	w := newTestOmpWorkspace()

	sess, err := w.CreateSession(context.Background(), "New Session")
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	<-w.events
	if err := w.AgentRun(context.Background(), sess.ID, "hello"); err != nil {
		t.Fatalf("AgentRun returned error: %v", err)
	}

	userEvent := nextMessageEvent(t, w)
	if userEvent.Type != pubsub.CreatedEvent || userEvent.Payload.Role != message.User {
		t.Fatalf("first message event = %#v, want created user message", userEvent)
	}
	assistantEvent := nextMessageEvent(t, w)
	if assistantEvent.Type != pubsub.CreatedEvent || assistantEvent.Payload.Role != message.Assistant {
		t.Fatalf("second message event = %#v, want created assistant message", assistantEvent)
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"world"}}`),
	})
	updated := nextMessageEvent(t, w)
	if updated.Type != pubsub.UpdatedEvent || updated.Payload.Content().Text != "world" {
		t.Fatalf("assistant update = %#v, want streamed text delta", updated)
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "tool_execution_start",
		Payload: []byte(`{"type":"tool_execution_start","toolCallId":"tool-1","toolName":"bash","args":{"command":"pwd"}}`),
	})
	toolUpdate := nextMessageEvent(t, w)
	if calls := toolUpdate.Payload.ToolCalls(); len(calls) != 1 || calls[0].Name != "bash" || calls[0].Finished {
		t.Fatalf("tool start calls = %#v, want unfinished bash call", calls)
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "tool_execution_end",
		Payload: []byte(`{"type":"tool_execution_end","toolCallId":"tool-1","toolName":"bash","result":{"content":"/tmp/project"},"isError":false}`),
	})
	finishedToolCall := nextMessageEvent(t, w)
	if calls := finishedToolCall.Payload.ToolCalls(); len(calls) != 1 || !calls[0].Finished {
		t.Fatalf("tool finish calls = %#v, want finished call", calls)
	}
	resultEvent := nextMessageEvent(t, w)
	results := resultEvent.Payload.ToolResults()
	if resultEvent.Type != pubsub.CreatedEvent || len(results) != 1 || results[0].Content != "/tmp/project" {
		t.Fatalf("tool result event = %#v, want created tool result content", resultEvent)
	}
}

func nextMessageEvent(t *testing.T, w *OmpWorkspace) pubsub.Event[message.Message] {
	t.Helper()
	msg := <-w.events
	event, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("event type = %T, want message event", msg)
	}
	return event
}
