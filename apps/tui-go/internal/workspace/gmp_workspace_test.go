package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/notify"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/lsp"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
)

const testEventTimeout = 2 * time.Second

func newTestGmpWorkspace() *GmpWorkspace {
	w := NewGmpWorkspace(nil, "/tmp/project")
	w.events = make(chan tea.Msg, 16)
	return w
}

func TestGmpWorkspacePromptAndStreamEvents(t *testing.T) {
	w := newTestGmpWorkspace()

	sess, err := w.CreateSession(context.Background(), "New Session")
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	nextUIEvent(t, w)
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

func TestGmpWorkspaceSendsPromptToRpcBackend(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := ompclient.Spawn(ctx, ompclient.Options{
		Bin:        os.Args[0],
		PrefixArgs: []string{"-test.run=TestGmpWorkspaceFakeRPCBackend", "--"},
		Env:        append(os.Environ(), "GMP_TUI_GO_FAKE_RPC=1"),
	})
	if err != nil {
		t.Fatalf("spawn fake rpc backend: %v", err)
	}
	defer client.Close()

	w := NewGmpWorkspace(client, "/tmp/project")
	w.events = make(chan tea.Msg, 16)
	go w.Subscribe(nil)

	sess, err := w.CreateSession(ctx, "New Session")
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	nextUIEvent(t, w)

	if err := w.AgentRun(ctx, sess.ID, "bridge hello"); err != nil {
		t.Fatalf("AgentRun returned error: %v", err)
	}
	nextMessageEvent(t, w) // local optimistic user
	nextMessageEvent(t, w) // local optimistic assistant

	updated := nextMessageEvent(t, w)
	if updated.Type != pubsub.UpdatedEvent || updated.Payload.Role != message.Assistant {
		t.Fatalf("backend update=%v, want assistant update", updated)
	}
	if updated.Payload.Content().Text != "backend saw: bridge hello" {
		t.Fatalf("assistant text=%q", updated.Payload.Content().Text)
	}
}

func TestGmpWorkspaceFakeRPCBackend(t *testing.T) {
	if os.Getenv("GMP_TUI_GO_FAKE_RPC") != "1" {
		return
	}
	runFakeGmpRPCBackend()
	os.Exit(0)
}

func runFakeGmpRPCBackend() {
	writeRPCFrame(map[string]any{"type": "ready", "schema": "omp-rpc/v1"})
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var command struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &command); err != nil {
			continue
		}
		switch command.Type {
		case "get_state":
			writeRPCFrame(map[string]any{
				"id":      command.ID,
				"type":    "response",
				"command": "get_state",
				"success": true,
				"data": map[string]any{
					"sessionId":   "rpc-session",
					"sessionName": "RPC Session",
					"model": map[string]any{
						"provider": "test-provider",
						"id":       "test-model",
					},
				},
			})
		case "get_messages":
			writeRPCFrame(map[string]any{
				"id":      command.ID,
				"type":    "response",
				"command": "get_messages",
				"success": true,
				"data":    map[string]any{"messages": []any{}},
			})
		case "new_session":
			writeRPCFrame(map[string]any{
				"id":      command.ID,
				"type":    "response",
				"command": "new_session",
				"success": true,
				"data":    map[string]any{"cancelled": false},
			})
		case "prompt":
			writeRPCFrame(map[string]any{
				"id":      command.ID,
				"type":    "response",
				"command": "prompt",
				"success": true,
			})
			reply := "backend saw: " + command.Message
			writeRPCFrame(map[string]any{"type": "agent_start"})
			writeRPCFrame(map[string]any{
				"type": "message_update",
				"assistantMessageEvent": map[string]any{
					"type":  "text_delta",
					"delta": reply,
				},
			})
			writeRPCFrame(map[string]any{
				"type": "agent_end",
				"messages": []any{
					map[string]any{
						"role":       "assistant",
						"content":    []any{map[string]any{"type": "text", "text": reply}},
						"stopReason": "stop",
						"timestamp":  1700000000000,
					},
				},
			})
		default:
			writeRPCFrame(map[string]any{
				"id":      command.ID,
				"type":    "response",
				"command": command.Type,
				"success": false,
				"error":   "unexpected command",
			})
		}
	}
}

func writeRPCFrame(frame any) {
	data, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintln(os.Stdout, string(data))
}

func nextMessageEvent(t *testing.T, w *GmpWorkspace) pubsub.Event[message.Message] {
	t.Helper()
	msg := nextUIEvent(t, w)
	event, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("event type = %T, want message event", msg)
	}
	return event
}

func nextSessionEvent(t *testing.T, w *GmpWorkspace) pubsub.Event[session.Session] {
	t.Helper()
	msg := nextUIEvent(t, w)
	event, ok := msg.(pubsub.Event[session.Session])
	if !ok {
		t.Fatalf("event type = %T, want session event", msg)
	}
	return event
}

func nextNotificationEvent(t *testing.T, w *GmpWorkspace) pubsub.Event[notify.Notification] {
	t.Helper()
	msg := nextUIEvent(t, w)
	event, ok := msg.(pubsub.Event[notify.Notification])
	if !ok {
		t.Fatalf("event type = %T, want notification event", msg)
	}
	return event
}

func nextUIEvent(t *testing.T, w *GmpWorkspace) tea.Msg {
	t.Helper()
	select {
	case msg := <-w.events:
		return msg
	case <-time.After(testEventTimeout):
		t.Fatalf("timed out waiting for workspace event")
		return nil
	}
}

func TestFinishAssistant_noCurrentID(t *testing.T) {
	w := newTestGmpWorkspace()
	if got := w.finishAssistant(message.FinishReasonCanceled, "x", ""); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestFinishAssistant_messageMissing(t *testing.T) {
	w := newTestGmpWorkspace()
	w.currentAssistantID = "ghost"
	if got := w.finishAssistant(message.FinishReasonEndTurn, "", ""); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
	if w.currentAssistantID != "" {
		t.Fatalf("currentAssistantID not cleared")
	}
}

func TestFinishAssistant_appendsTextWhenEmpty(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hi")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant

	w.AgentCancel("")
	ev := nextMessageEvent(t, w)
	if ev.Payload.Content().Text != "Request canceled" {
		t.Fatalf("text=%q want Request canceled", ev.Payload.Content().Text)
	}
	if ev.Payload.FinishReason() != message.FinishReasonCanceled {
		t.Fatalf("reason=%v want Canceled", ev.Payload.FinishReason())
	}
	if w.currentAssistantID != "" {
		t.Fatalf("currentAssistantID not cleared")
	}
}

func TestListMessages(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hi")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "tool_execution_start",
		Payload: []byte(`{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{}}`),
	})
	nextUIEvent(t, w) // tool call added to assistant

	all, _ := w.ListMessages(context.Background(), "")
	if len(all) != 2 {
		t.Fatalf("ListMessages len=%d want 2", len(all))
	}
	if all[0].Role != message.User || all[1].Role != message.Assistant {
		t.Fatalf("order wrong: %v", all)
	}

	users, _ := w.ListUserMessages(context.Background(), "")
	if len(users) != 1 || users[0].Role != message.User {
		t.Fatalf("ListUserMessages len=%d want 1 user", len(users))
	}

	allUsers, _ := w.ListAllUserMessages(context.Background())
	if len(allUsers) != 1 {
		t.Fatalf("ListAllUserMessages len=%d want 1", len(allUsers))
	}
}

func TestAgentGetters(t *testing.T) {
	w := newTestGmpWorkspace()
	if w.AgentIsBusy() {
		t.Fatalf("AgentIsBusy want false")
	}
	if w.AgentIsSessionBusy("x") {
		t.Fatalf("AgentIsSessionBusy want false")
	}
	m := w.AgentModel()
	if m.ModelCfg.Model != gmpModelID {
		t.Fatalf("AgentModel=%v", m)
	}
	if !w.AgentIsReady() {
		t.Fatalf("AgentIsReady want true")
	}
	if w.AgentQueuedPrompts("x") != 0 {
		t.Fatalf("AgentQueuedPrompts want 0")
	}
	if w.AgentQueuedPromptsList("x") != nil {
		t.Fatalf("AgentQueuedPromptsList want nil")
	}
	w.AgentClearQueue("x") // no-op, no panic

	if err := w.AgentSummarize(context.Background(), "x"); err != ErrUnsupported {
		t.Fatalf("AgentSummarize err=%v", err)
	}
	if err := w.UpdateAgentModel(context.Background()); err != nil {
		t.Fatalf("UpdateAgentModel err=%v", err)
	}
	if err := w.InitCoderAgent(context.Background()); err != nil {
		t.Fatalf("InitCoderAgent err=%v", err)
	}
}

func TestTrivialMethods(t *testing.T) {
	w := newTestGmpWorkspace()

	w.AgentClearQueue("x")

	m := w.GetDefaultSmallModel("any")
	if m.Model != gmpModelID {
		t.Fatalf("GetDefaultSmallModel=%v", m)
	}

	w.PermissionGrant(permission.PermissionRequest{})
	w.PermissionGrantPersistent(permission.PermissionRequest{})
	w.PermissionDeny(permission.PermissionRequest{})
	if w.PermissionSkipRequests() {
		t.Fatalf("PermissionSkipRequests want false")
	}
	w.PermissionSetSkipRequests(true)
	if !w.PermissionSkipRequests() {
		t.Fatalf("PermissionSkipRequests want true")
	}

	w.FileTrackerRecordRead(context.Background(), "s", "/a")
	if !w.FileTrackerLastReadTime(context.Background(), "s", "/a").IsZero() {
		t.Fatalf("FileTrackerLastReadTime want zero")
	}
	files, _ := w.FileTrackerListReadFiles(context.Background(), "s")
	if files != nil {
		t.Fatalf("FileTrackerListReadFiles want nil")
	}
}

func TestMatchingUserIDLocked(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hello")
	nextUIEvent(t, w)
	nextUIEvent(t, w)
	nextUIEvent(t, w)

	id, ok := w.matchingUserIDLocked("hello")
	if !ok {
		t.Fatalf("matchingUserIDLocked want match")
	}
	if id == "" {
		t.Fatalf("matchingUserIDLocked id empty")
	}

	_, ok = w.matchingUserIDLocked("nope")
	if ok {
		t.Fatalf("matchingUserIDLocked want no match")
	}
}

func TestSessionTitle(t *testing.T) {
	w := newTestGmpWorkspace()
	if w.sessionTitle() != "" {
		t.Fatalf("sessionTitle want empty")
	}
	w.CreateSession(context.Background(), "my-title")
	if w.sessionTitle() != "my-title" {
		t.Fatalf("sessionTitle=%q", w.sessionTitle())
	}
}

func TestParseTextWrappedContent(t *testing.T) {
	w := newTestGmpWorkspace()
	got := w.parseTextWrappedContent([]byte(`{"content":"hello"}`))
	if len(got) != 1 || got[0].(message.TextContent).Text != "hello" {
		t.Fatalf("text=%v", got)
	}
	got = w.parseTextWrappedContent([]byte(`{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}`))
	if len(got) != 1 || got[0].(message.TextContent).Text != "ab" {
		t.Fatalf("array=%v", got)
	}
	if w.parseTextWrappedContent([]byte(`bad`)) != nil {
		t.Fatalf("bad want nil")
	}
}

func TestParseAssistantContent(t *testing.T) {
	w := newTestGmpWorkspace()
	raw := []byte(`{"content":[{"type":"text","text":"hi"},{"type":"thinking","thinking":"hm"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"cmd":"ls"}}],"stopReason":"stop"}`)
	got := w.parseAssistantContent(raw)
	if len(got) != 4 {
		t.Fatalf("len=%d want 4", len(got))
	}
	if got[0].(message.TextContent).Text != "hi" {
		t.Fatalf("text=%v", got[0])
	}
	if got[1].(message.ReasoningContent).Thinking != "hm" {
		t.Fatalf("thinking=%v", got[1])
	}
	if got[2].(message.ToolCall).Name != "bash" {
		t.Fatalf("tool=%v", got[2])
	}
	if got[3].(message.Finish).Reason != message.FinishReasonEndTurn {
		t.Fatalf("finish=%v", got[3])
	}
	if w.parseAssistantContent([]byte(`bad`)) != nil {
		t.Fatalf("bad want nil")
	}
}

func TestParseToolResultContent(t *testing.T) {
	w := newTestGmpWorkspace()
	got := w.parseToolResultContent([]byte(`{"toolCallId":"t1","toolName":"bash","content":"ok","isError":false}`))
	if len(got) != 1 {
		t.Fatalf("len=%d", len(got))
	}
	tr := got[0].(message.ToolResult)
	if tr.ToolCallID != "t1" || tr.Content != "ok" || tr.IsError {
		t.Fatalf("tr=%v", tr)
	}
	if w.parseToolResultContent([]byte(`bad`)) != nil {
		t.Fatalf("bad want nil")
	}
}

func TestParseExecutionContent(t *testing.T) {
	w := newTestGmpWorkspace()
	got := w.parseExecutionContent([]byte(`{"command":"pwd","output":"/tmp","exitCode":0}`))
	if len(got) != 1 || got[0].(message.TextContent).Text != "pwd\n\n/tmp\n(exit code: 0)" {
		t.Fatalf("exec=%q", got[0].(message.TextContent).Text)
	}
	got = w.parseExecutionContent([]byte(`{"code":"echo 1","output":"1"}`))
	if got[0].(message.TextContent).Text != "echo 1\n\n1" {
		t.Fatalf("code=%q", got[0].(message.TextContent).Text)
	}
	if w.parseExecutionContent([]byte(`bad`)) != nil {
		t.Fatalf("bad want nil")
	}
}

func TestConfigAccessors(t *testing.T) {
	w := newTestGmpWorkspace()
	if w.Config() == nil {
		t.Fatalf("Config nil")
	}
	if w.WorkingDir() != "/tmp/project" {
		t.Fatalf("WorkingDir=%q", w.WorkingDir())
	}
	if w.Resolver() == nil {
		t.Fatalf("Resolver nil")
	}

	m := config.SelectedModel{Provider: "p", Model: "m"}
	if err := w.UpdatePreferredModel(config.ScopeGlobal, config.SelectedModelTypeLarge, m); err != nil {
		t.Fatalf("UpdatePreferredModel err=%v", err)
	}
	if w.AgentModel().ModelCfg.Model != "m" {
		t.Fatalf("model not updated")
	}

	if err := w.SetCompactMode(config.ScopeGlobal, true); err != nil {
		t.Fatalf("SetCompactMode err=%v", err)
	}
	if !w.Config().Options.TUI.CompactMode {
		t.Fatalf("CompactMode not set")
	}

	if err := w.SetProviderAPIKey(config.ScopeGlobal, "p", "key"); err != nil {
		t.Fatalf("SetProviderAPIKey err=%v", err)
	}
	if err := w.SetConfigField(config.ScopeGlobal, "options.disable_notifications", true); err != nil {
		t.Fatalf("SetConfigField err=%v", err)
	}
	if !w.Config().Options.DisableNotifications {
		t.Fatalf("DisableNotifications not set")
	}
	if err := w.SetConfigField(config.ScopeGlobal, "options.tui.transparent", true); err != nil {
		t.Fatalf("SetConfigField transparent err=%v", err)
	}
	if w.Config().Options.TUI.Transparent == nil || !*w.Config().Options.TUI.Transparent {
		t.Fatalf("Transparent not set")
	}
	if err := w.RemoveConfigField(config.ScopeGlobal, "x"); err != nil {
		t.Fatalf("RemoveConfigField err=%v", err)
	}
	if _, ok := w.ImportCopilot(); ok {
		t.Fatalf("ImportCopilot want false")
	}
	if err := w.RefreshOAuthToken(context.Background(), config.ScopeGlobal, "p"); err != nil {
		t.Fatalf("RefreshOAuthToken err=%v", err)
	}
}

func TestTrivialNoOps(t *testing.T) {
	w := newTestGmpWorkspace()

	w.LSPStart(context.Background(), "/a")
	w.LSPStopAll(context.Background())
	if w.LSPGetStates() != nil {
		t.Fatalf("LSPGetStates want nil")
	}
	if w.LSPGetDiagnosticCounts("x") != (lsp.DiagnosticCounts{}) {
		t.Fatalf("LSPGetDiagnosticCounts want zero")
	}

	need, _ := w.ProjectNeedsInitialization()
	if need {
		t.Fatalf("ProjectNeedsInitialization want false")
	}
	if err := w.MarkProjectInitialized(); err != nil {
		t.Fatalf("MarkProjectInitialized err=%v", err)
	}
	p, _ := w.InitializePrompt()
	if p != "" {
		t.Fatalf("InitializePrompt=%q", p)
	}

	if w.MCPGetStates() != nil {
		t.Fatalf("MCPGetStates want nil")
	}
	w.MCPRefreshPrompts(context.Background(), "x")
	w.MCPRefreshResources(context.Background(), "x")
	w.RefreshMCPTools(context.Background(), "x")
	if _, err := w.ReadMCPResource(context.Background(), "x", "y"); err != ErrUnsupported {
		t.Fatalf("ReadMCPResource err=%v", err)
	}
	if _, err := w.GetMCPPrompt("c", "p", nil); err != ErrUnsupported {
		t.Fatalf("GetMCPPrompt err=%v", err)
	}
	if err := w.EnableDockerMCP(context.Background()); err != ErrUnsupported {
		t.Fatalf("EnableDockerMCP err=%v", err)
	}
	if err := w.DisableDockerMCP(); err != nil {
		t.Fatalf("DisableDockerMCP err=%v", err)
	}

	hist, _ := w.ListSessionHistory(context.Background(), "s")
	if hist != nil {
		t.Fatalf("ListSessionHistory want nil")
	}
}

func TestEventHandlers(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hello")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant

	// message_start user with matching text -> UpdatedEvent
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_start",
		Payload: []byte(`{"type":"message_start","message":{"role":"user","content":"hello","timestamp":1700000000000}}`),
	})
	ev := nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent || ev.Payload.Role != message.User {
		t.Fatalf("message_start user=%v", ev)
	}

	// message_start assistant -> UpdatedEvent (uses currentAssistantID)
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_start",
		Payload: []byte(`{"type":"message_start","message":{"role":"assistant","content":[],"timestamp":1700000000000}}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent || ev.Payload.Role != message.Assistant {
		t.Fatalf("message_start assistant=%v", ev)
	}

	// message_end assistant -> clears currentAssistantID
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_end",
		Payload: []byte(`{"type":"message_end","message":{"role":"assistant","content":[],"timestamp":1700000000000}}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Type != pubsub.UpdatedEvent || w.currentAssistantID != "" {
		t.Fatalf("message_end did not clear assistant id")
	}

	// turn_end with message + tool result
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "turn_end",
		Payload: []byte(`{"type":"turn_end","message":{"role":"assistant","content":[],"timestamp":1700000000000},"toolResults":[{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":"ok","timestamp":1700000000000}]}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Payload.Role != message.Assistant {
		t.Fatalf("turn_end assistant=%v", ev)
	}

	// agent_end with messages
	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"user","content":"bye","timestamp":1700000000000}]}`),
	})
	ev = nextMessageEvent(t, w)
	if ev.Type != pubsub.CreatedEvent || ev.Payload.Role != message.User || ev.Payload.Content().Text != "bye" {
		t.Fatalf("agent_end message=%v", ev)
	}
	notification := nextNotificationEvent(t, w)
	if notification.Type != pubsub.CreatedEvent || notification.Payload.Type != notify.TypeAgentFinished {
		t.Fatalf("agent_end notification=%v", notification)
	}
	if notification.Payload.SessionID == "" {
		t.Fatalf("agent_end notification missing session id")
	}
}

func TestAgentEndPublishesFinalMessages(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hello")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"user","content":"hello","timestamp":1700000000000},{"role":"assistant","content":[{"type":"text","text":"final answer"}],"stopReason":"stop","timestamp":1700000000000}]}`),
	})

	userEvent := nextMessageEvent(t, w)
	if userEvent.Type != pubsub.UpdatedEvent || userEvent.Payload.Role != message.User {
		t.Fatalf("agent_end user event=%v", userEvent)
	}
	assistantEvent := nextMessageEvent(t, w)
	if assistantEvent.Type != pubsub.UpdatedEvent || assistantEvent.Payload.Role != message.Assistant {
		t.Fatalf("agent_end assistant event=%v", assistantEvent)
	}
	if assistantEvent.Payload.Content().Text != "final answer" {
		t.Fatalf("assistant text=%q want final answer", assistantEvent.Payload.Content().Text)
	}
	if w.currentAssistantID != "" {
		t.Fatalf("currentAssistantID not cleared")
	}
	notification := nextNotificationEvent(t, w)
	if notification.Payload.Type != notify.TypeAgentFinished {
		t.Fatalf("notification=%v", notification)
	}
}

func TestAgentToolSessionID_roundtrip(t *testing.T) {
	w := newTestGmpWorkspace()
	got := w.CreateAgentToolSessionID("msg-1", "call-2")
	if got != "msg-1$$call-2" {
		t.Fatalf("create=%q", got)
	}
	msgID, callID, ok := w.ParseAgentToolSessionID(got)
	if !ok || msgID != "msg-1" || callID != "call-2" {
		t.Fatalf("parse=%q %q %v", msgID, callID, ok)
	}
}

func TestSessionLifecycle(t *testing.T) {
	w := newTestGmpWorkspace()

	// GetSession auto-creates when empty
	s1, err := w.GetSession(context.Background(), "")
	if err != nil {
		t.Fatalf("GetSession err=%v", err)
	}
	if s1.ID == "" {
		t.Fatalf("GetSession did not auto-create")
	}

	// ListSessions returns nil when empty... but we just created one via GetSession
	// Actually GetSession mutates state. Let's test ListSessions on fresh workspace.
	w2 := newTestGmpWorkspace()
	list, err := w2.ListSessions(context.Background())
	if err != nil {
		t.Fatalf("ListSessions err=%v", err)
	}
	if list != nil {
		t.Fatalf("ListSessions want nil, got %v", list)
	}

	// ListSessions returns slice after session exists
	list, _ = w.ListSessions(context.Background())
	if len(list) != 1 || list[0].ID != s1.ID {
		t.Fatalf("ListSessions=%v", list)
	}

	// SaveSession updates and emits event
	s1.Title = "updated"
	saved, _ := w.SaveSession(context.Background(), s1)
	if saved.Title != "updated" {
		t.Fatalf("SaveSession title=%q", saved.Title)
	}
	se := nextSessionEvent(t, w)
	if se.Type != pubsub.UpdatedEvent || se.Payload.Title != "updated" {
		t.Fatalf("save event=%v", se)
	}

	// DeleteSession unsupported
	if err := w.DeleteSession(context.Background(), "x"); err != ErrUnsupported {
		t.Fatalf("DeleteSession err=%v", err)
	}
}

func TestParseAgentToolSessionID_noDelim(t *testing.T) {
	w := newTestGmpWorkspace()
	msgID, callID, ok := w.ParseAgentToolSessionID("nope")
	if ok {
		t.Fatalf("want false, got %q %q", msgID, callID)
	}
}

func TestFinishAssistant_skipsTextAppendWhenContentExists(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "hi")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // user
	nextUIEvent(t, w) // assistant

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"existing"}}`),
	})
	nextMessageEvent(t, w)

	w.AgentCancel("")
	ev := nextMessageEvent(t, w)
	if ev.Payload.Content().Text != "existing" {
		t.Fatalf("text=%q want existing", ev.Payload.Content().Text)
	}
}

// recordingSender is a programSender that records every Send and can
// optionally hold each call until released, simulating a full Bubble Tea
// message channel. Used to pin the post-b83fca9 invariant that sendUI must
// not block its caller even when program.Send blocks.
type recordingSender struct {
	mu   sync.Mutex
	msgs []tea.Msg
	hold chan struct{}
}

func (r *recordingSender) Send(msg tea.Msg) {
	if r.hold != nil {
		<-r.hold
	}
	r.mu.Lock()
	r.msgs = append(r.msgs, msg)
	r.mu.Unlock()
}

func (r *recordingSender) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.msgs)
}

// TestSendUI_DoesNotBlockCallerWhenProgramSendBlocks pins Bug A
// (the synchronous program.Send deadlock fixed in b83fca9). Pre-fix,
// program.Send was called synchronously, so a blocked Send would freeze
// the caller. The fix dispatches via `go program.Send(msg)`. This test
// blocks the sender and asserts the caller still returns within the
// timeout. Without `go`, this test deadlocks until t.Fatal.
func TestSendUI_DoesNotBlockCallerWhenProgramSendBlocks(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	sender := &recordingSender{hold: make(chan struct{})}
	w.program = sender

	done := make(chan struct{})
	go func() {
		w.sendUI(pubsub.Event[session.Session]{Type: pubsub.CreatedEvent})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(testEventTimeout):
		t.Fatal("sendUI blocked the caller while program.Send was held; deadlock regression")
	}

	close(sender.hold)
	deadline := time.Now().Add(testEventTimeout)
	for sender.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sender.count() != 1 {
		t.Fatalf("sender saw %d messages after release, want 1", sender.count())
	}
}

// TestSendUI_NilMsgIsNoOp pins the early-return guard on nil messages.
func TestSendUI_NilMsgIsNoOp(t *testing.T) {
	w := newTestGmpWorkspace()
	w.sendUI(nil)
	select {
	case msg := <-w.events:
		t.Fatalf("nil sendUI produced an event: %v", msg)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestSendUI_NoSinkIsNoOp pins the path where neither program nor events
// channel is set: sendUI must not panic.
func TestSendUI_NoSinkIsNoOp(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	w.sendUI(pubsub.Event[session.Session]{Type: pubsub.CreatedEvent})
}

// TestAgentEnd_StreamingThenPayload_NoDuplicateAssistantRow pins Bug B”
// (matchingAssistantIDLocked). Pre-fix, handleAgentEnd called
// nextID("agent") for every payload message, creating a fresh row. The fix
// reuses currentAssistantID or falls back to text-match against prior
// assistant rows, so the streamed row is updated rather than duplicated.
func TestAgentEnd_StreamingThenPayload_NoDuplicateAssistantRow(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "ping")
	nextUIEvent(t, w) // session
	nextUIEvent(t, w) // optimistic user
	nextUIEvent(t, w) // optimistic assistant

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"pong"}}`),
	})
	streamed := nextMessageEvent(t, w)
	streamedID := streamed.Payload.ID
	if streamedID == "" {
		t.Fatal("streamed assistant id is empty")
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"pong"}],"stopReason":"stop","timestamp":1700000000000}]}`),
	})
	final := nextMessageEvent(t, w)
	if final.Payload.ID != streamedID {
		t.Fatalf("agent_end created new row id=%s, want reuse of streamed id=%s", final.Payload.ID, streamedID)
	}
	if final.Type != pubsub.UpdatedEvent {
		t.Fatalf("agent_end event type=%v, want UpdatedEvent (id reuse)", final.Type)
	}

	count := 0
	for _, m := range w.messages {
		if m.Role == message.Assistant {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("assistant row count=%d, want 1 (no duplicate from agent_end)", count)
	}
}

// TestAgentEnd_NoStreamingFallback_ReusesIDByTextMatch pins the second
// branch of matchingAssistantIDLocked: when currentAssistantID is empty
// but a prior assistant row exists with matching text, the id is reused.
// This covers the path where streaming finished (currentAssistantID
// cleared) and a second agent_end arrives with the same text.
func TestAgentEnd_NoStreamingFallback_ReusesIDByTextMatch(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "ping")
	nextUIEvent(t, w)
	nextUIEvent(t, w)
	nextUIEvent(t, w)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"first"}],"stopReason":"stop","timestamp":1700000000000}]}`),
	})
	first := nextMessageEvent(t, w)
	nextNotificationEvent(t, w)
	firstID := first.Payload.ID
	if w.currentAssistantID != "" {
		t.Fatalf("currentAssistantID not cleared after agent_end")
	}

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"first"}],"stopReason":"stop","timestamp":1700000000001}]}`),
	})
	second := nextMessageEvent(t, w)
	if second.Payload.ID != firstID {
		t.Fatalf("text-match reuse failed: second id=%s, want %s", second.Payload.ID, firstID)
	}
	if second.Type != pubsub.UpdatedEvent {
		t.Fatalf("second event=%v, want UpdatedEvent", second.Type)
	}
}

// TestHandleAgentEnd_ClearsCurrentAssistantID pins Bug C in isolation.
// We call handleAgentEnd directly (not through translateEvent) so the
// synthetic finishAssistant fallback cannot mask whether handleAgentEnd
// itself clears currentAssistantID. Pre-fix, handleAgentEnd never touched
// currentAssistantID, so this test would pass only because of the
// translateEvent-level finishAssistant side effect.
func TestHandleAgentEnd_ClearsCurrentAssistantID(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "x")
	nextUIEvent(t, w)
	nextUIEvent(t, w)
	nextUIEvent(t, w)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "message_update",
		Payload: []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"y"}}`),
	})
	nextMessageEvent(t, w)
	if w.currentAssistantID == "" {
		t.Fatal("precondition: currentAssistantID should be set by streaming partial")
	}

	events := w.handleAgentEnd([]byte(`{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"y"}],"stopReason":"stop","timestamp":1700000000000}]}`))
	if len(events) == 0 {
		t.Fatal("handleAgentEnd produced no events for assistant payload")
	}
	if w.currentAssistantID != "" {
		t.Fatalf("handleAgentEnd did not clear currentAssistantID; got %q", w.currentAssistantID)
	}
}

// TestHandleAgentEnd_InvalidPayloadReturnsNil pins the JSON unmarshal
// error path of handleAgentEnd: malformed payload returns nil and does
// not mutate state.
func TestHandleAgentEnd_InvalidPayloadReturnsNil(t *testing.T) {
	w := newTestGmpWorkspace()
	if got := w.handleAgentEnd([]byte("not json")); got != nil {
		t.Fatalf("handleAgentEnd(invalid)=%v, want nil", got)
	}
}

// TestHandleAgentEnd_EmptyMessagesReturnsEmptyEvents covers the path
// where the payload parses cleanly but contains no messages. The
// translateEvent caller relies on this to fall through to the synthetic
// finishAssistant marker.
func TestHandleAgentEnd_EmptyMessagesReturnsEmptyEvents(t *testing.T) {
	w := newTestGmpWorkspace()
	events := w.handleAgentEnd([]byte(`{"type":"agent_end","messages":[]}`))
	if len(events) != 0 {
		t.Fatalf("len(events)=%d, want 0", len(events))
	}
	if w.currentAssistantID != "" {
		t.Fatal("empty payload mutated currentAssistantID")
	}
}

// TestTranslateAgentEnd_FallsBackToFinishAssistantWhenPayloadHasNoAssistant
// pins the containsAssistantMessageEvent gate: if the payload only carries
// a user message, the synthetic EndTurn marker must still fire.
func TestTranslateAgentEnd_FallsBackToFinishAssistantWhenPayloadHasNoAssistant(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "ping")
	nextUIEvent(t, w)
	nextUIEvent(t, w)
	nextUIEvent(t, w)

	w.handleAgentEvent(&ompclient.AgentEvent{
		Kind:    "agent_end",
		Payload: []byte(`{"type":"agent_end","messages":[{"role":"user","content":"ping","timestamp":1700000000000}]}`),
	})

	userEv := nextMessageEvent(t, w)
	if userEv.Payload.Role != message.User {
		t.Fatalf("first event role=%v, want user", userEv.Payload.Role)
	}
	finishEv := nextMessageEvent(t, w)
	if finishEv.Payload.Role != message.Assistant {
		t.Fatalf("second event role=%v, want assistant (synthetic finish marker)", finishEv.Payload.Role)
	}
	finish := finishEv.Payload.FinishPart()
	if finish == nil || finish.Reason != message.FinishReasonEndTurn {
		t.Fatalf("finish part=%v, want EndTurn marker", finish)
	}
}

// TestMatchingAssistantIDLocked_NoMatchReturnsEmpty pins the negative
// branch: walking the message order in reverse without finding an
// assistant row whose text matches must return ("", false).
func TestMatchingAssistantIDLocked_NoMatchReturnsEmpty(t *testing.T) {
	w := newTestGmpWorkspace()
	w.CreateSession(context.Background(), "s")
	w.AgentRun(context.Background(), "", "ping")
	nextUIEvent(t, w)
	nextUIEvent(t, w)
	nextUIEvent(t, w)

	id, ok := w.matchingAssistantIDLocked("text that no assistant ever produced")
	if ok || id != "" {
		t.Fatalf("matchingAssistantIDLocked unexpectedly matched: id=%q ok=%v", id, ok)
	}
}

// TestSubscribe_NormalizesNilProgram ensures Subscribe(nil) does not store
// a typed-nil *tea.Program inside the programSender interface — that would
// make `program != nil` true while program.Send panics on a nil receiver.
func TestSubscribe_NormalizesNilProgram(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	w.events = make(chan tea.Msg, 4)
	w.Subscribe(nil)
	w.sendUI(pubsub.Event[session.Session]{Type: pubsub.CreatedEvent})
	select {
	case <-w.events:
	case <-time.After(testEventTimeout):
		t.Fatal("Subscribe(nil) caused sendUI to drop the event into the wrong sink")
	}
}

// TestNoOpStubs covers the trivial no-op stubs that exist for interface
// conformance: AgentClearQueue, Permission*, FileTrackerRecordRead,
// LSP*, MCPRefresh*, RefreshMCPTools, Shutdown, GetDefaultSmallModel,
// LSPGetStates, FileTrackerLastReadTime, FileTrackerListReadFiles,
// AgentQueuedPromptsList, MCPGetStates, ReadMCPResource, GetMCPPrompt.
func TestNoOpStubs(t *testing.T) {
	w := newTestGmpWorkspace()
	ctx := context.Background()

	w.AgentClearQueue("any")
	if got := w.AgentQueuedPromptsList("any"); got != nil {
		t.Fatalf("AgentQueuedPromptsList=%v want nil", got)
	}

	w.PermissionGrant(permission.PermissionRequest{})
	w.PermissionGrantPersistent(permission.PermissionRequest{})
	w.PermissionDeny(permission.PermissionRequest{})

	w.FileTrackerRecordRead(ctx, "s", "p")
	if got := w.FileTrackerLastReadTime(ctx, "s", "p"); !got.IsZero() {
		t.Fatalf("FileTrackerLastReadTime=%v want zero", got)
	}
	if got, err := w.FileTrackerListReadFiles(ctx, "s"); got != nil || err != nil {
		t.Fatalf("FileTrackerListReadFiles=(%v,%v) want (nil,nil)", got, err)
	}

	w.LSPStart(ctx, "/tmp/x")
	w.LSPStopAll(ctx)
	if got := w.LSPGetStates(); got != nil {
		t.Fatalf("LSPGetStates=%v want nil", got)
	}

	w.MCPRefreshPrompts(ctx, "n")
	w.MCPRefreshResources(ctx, "n")
	w.RefreshMCPTools(ctx, "n")
	if got := w.MCPGetStates(); got != nil {
		t.Fatalf("MCPGetStates=%v want nil", got)
	}
	if _, err := w.ReadMCPResource(ctx, "n", "u"); err == nil {
		t.Fatal("ReadMCPResource want ErrUnsupported")
	}
	if _, err := w.GetMCPPrompt("n", "p", nil); err == nil {
		t.Fatal("GetMCPPrompt want ErrUnsupported")
	}

	got := w.GetDefaultSmallModel("openai")
	want := w.cfg.Models[config.SelectedModelTypeSmall]
	if got.Provider != want.Provider || got.Model != want.Model {
		t.Fatalf("GetDefaultSmallModel=%+v want %+v", got, want)
	}

	w.Shutdown()
	w.Shutdown() // closeOnce: second call must be a no-op
}

// TestContainsAssistantMessageEvent_Negatives ensures the helper rejects
// non-message events and message events whose role is not Assistant.
func TestContainsAssistantMessageEvent_Negatives(t *testing.T) {
	if containsAssistantMessageEvent(nil) {
		t.Fatal("nil events returned true")
	}
	if containsAssistantMessageEvent([]tea.Msg{42}) {
		t.Fatal("non-message tea.Msg returned true")
	}
	userEv := pubsub.Event[message.Message]{
		Type: pubsub.CreatedEvent,
		Payload: message.Message{
			Role: message.User,
		},
	}
	if containsAssistantMessageEvent([]tea.Msg{userEv}) {
		t.Fatal("user role event returned true")
	}
}
