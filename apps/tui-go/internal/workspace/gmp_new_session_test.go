package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
)

func TestCreateSessionUsesAuthoritativeReceiptWithoutStateRoundTrip(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedWorkspaceSession(t, w)

	result := make(chan createSessionResult, 1)
	go func() {
		sess, err := w.CreateSession(context.Background(), "Requested title")
		result <- createSessionResult{session: sess, err: err}
	}()
	frame := pc.waitForFrame(t, time.Second)
	if frame["type"] != "new_session" {
		t.Fatalf("command = %#v, want new_session", frame)
	}
	if err := pc.writeInbound(newSessionResponse(frame, map[string]any{
		"cancelled": false,
		"state": map[string]any{
			"sessionId":     "new-session",
			"sessionName":   "Backend title",
			"thinkingLevel": "high",
			"model": map[string]any{
				"provider": "openai", "id": "gpt-5", "name": "GPT-5", "reasoning": true,
				"input": []string{"text", "image"}, "contextWindow": 200000, "maxTokens": 8192,
			},
		},
	})); err != nil {
		t.Fatalf("write new_session response: %v", err)
	}
	got := <-result
	if got.err != nil {
		t.Fatalf("CreateSession: %v", got.err)
	}
	if got.session.ID != "new-session" || got.session.Title != "Requested title" {
		t.Fatalf("session = %#v", got.session)
	}
	if len(pc.frames()) != 1 {
		t.Fatalf("modern receipt sent extra RPC calls: %#v", pc.frames())
	}
	if event := nextSessionEvent(t, w); event.Payload.ID != "new-session" {
		t.Fatalf("created event = %#v", event)
	}
	if got := w.ThinkingLevel(); got != "high" {
		t.Fatalf("thinking level = %q, want high", got)
	}
	model := w.AgentModel()
	if model.ModelCfg.Provider != "openai" || model.ModelCfg.Model != "gpt-5" || !model.CatwalkCfg.SupportsImages {
		t.Fatalf("model = %#v", model)
	}
	messages, err := w.ListMessages(context.Background(), "new-session")
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("messages = %#v, want cleared", messages)
	}
}

func TestCreateSessionLegacyReceiptFallsBackToState(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	result := make(chan createSessionResult, 1)
	go func() {
		sess, err := w.CreateSession(context.Background(), "")
		result <- createSessionResult{session: sess, err: err}
	}()
	newSession := pc.waitForFrame(t, time.Second)
	if err := pc.writeInbound(newSessionResponse(newSession, map[string]any{"cancelled": false})); err != nil {
		t.Fatalf("write legacy response: %v", err)
	}
	state := waitForCatalogFrame(t, pc, 1)
	if state["type"] != "get_state" {
		t.Fatalf("legacy fallback command = %#v, want get_state", state)
	}
	if err := pc.writeInbound(newSessionResponseForCommand(state, "get_state", map[string]any{
		"sessionId": "legacy-session", "sessionName": "Legacy title",
		"model": map[string]any{"provider": "anthropic", "id": "claude", "name": "Claude"},
	})); err != nil {
		t.Fatalf("write get_state response: %v", err)
	}
	got := <-result
	if got.err != nil {
		t.Fatalf("CreateSession: %v", got.err)
	}
	if got.session.ID != "legacy-session" || got.session.Title != "Legacy title" {
		t.Fatalf("session = %#v", got.session)
	}
	if len(pc.frames()) != 2 {
		t.Fatalf("legacy receipt calls = %#v, want new_session and get_state", pc.frames())
	}
	_ = nextSessionEvent(t, w)
}

func TestCreateSessionCancelledLeavesWorkspaceUntouched(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedWorkspaceSession(t, w)

	result := make(chan createSessionResult, 1)
	go func() {
		sess, err := w.CreateSession(context.Background(), "new")
		result <- createSessionResult{session: sess, err: err}
	}()
	frame := pc.waitForFrame(t, time.Second)
	if err := pc.writeInbound(newSessionResponse(frame, map[string]any{"cancelled": true})); err != nil {
		t.Fatalf("write cancelled response: %v", err)
	}
	got := <-result
	if !errors.Is(got.err, ErrSessionCreationCancelled) {
		t.Fatalf("CreateSession error = %v, want cancellation", got.err)
	}
	assertWorkspaceSessionUnchanged(t, w)
	assertNoWorkspaceEvent(t, w)
}

func TestCreateSessionMalformedReceiptLeavesWorkspaceUntouched(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedWorkspaceSession(t, w)

	result := make(chan createSessionResult, 1)
	go func() {
		sess, err := w.CreateSession(context.Background(), "new")
		result <- createSessionResult{session: sess, err: err}
	}()
	frame := pc.waitForFrame(t, time.Second)
	if err := pc.writeInbound(newSessionResponse(frame, map[string]any{
		"cancelled": false,
		"state":     map[string]any{"sessionId": " ", "model": map[string]any{"provider": "openai", "id": "gpt"}},
	})); err != nil {
		t.Fatalf("write malformed response: %v", err)
	}
	got := <-result
	if got.err == nil {
		t.Fatal("CreateSession succeeded for malformed receipt")
	}
	assertWorkspaceSessionUnchanged(t, w)
	assertNoWorkspaceEvent(t, w)
}

func TestSyncStateWaitsForCatalogTransaction(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	if err := w.acquireCatalogOp(context.Background()); err != nil {
		t.Fatalf("acquire catalog operation: %v", err)
	}
	locked := true
	defer func() {
		if locked {
			w.releaseCatalogOp()
		}
	}()

	blockedCtx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := w.syncState(blockedCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("syncState while catalog transaction held = %v, want deadline exceeded", err)
	}
	if len(pc.frames()) != 0 {
		t.Fatalf("syncState bypassed catalog transaction: %#v", pc.frames())
	}
	w.releaseCatalogOp()
	locked = false

	result := make(chan error, 1)
	go func() { result <- w.syncState(context.Background()) }()
	frame := pc.waitForFrame(t, time.Second)
	if frame["type"] != "get_state" {
		t.Fatalf("command = %#v, want get_state", frame)
	}
	if err := pc.writeInbound(newSessionResponseForCommand(frame, "get_state", map[string]any{
		"sessionId": "serialized-session", "model": map[string]any{"provider": "openai", "id": "gpt"},
	})); err != nil {
		t.Fatalf("write state response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("syncState: %v", err)
	}
}

type createSessionResult struct {
	session session.Session
	err     error
}

func newSessionResponse(frame map[string]any, data map[string]any) map[string]any {
	return newSessionResponseForCommand(frame, "new_session", data)
}

func newSessionResponseForCommand(frame map[string]any, command string, data map[string]any) map[string]any {
	return map[string]any{
		"type": "response", "id": frame["id"], "command": command, "success": true, "data": data,
	}
}

func seedWorkspaceSession(t *testing.T, w *GmpWorkspace) {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	w.session = session.Session{ID: "old-session", Title: "Old title"}
	w.messages = map[string]message.Message{"old-message": {ID: "old-message", SessionID: "old-session", Role: message.User}}
	w.msgOrder = []string{"old-message"}
}

func assertWorkspaceSessionUnchanged(t *testing.T, w *GmpWorkspace) {
	t.Helper()
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.session.ID != "old-session" || w.session.Title != "Old title" {
		t.Fatalf("session mutated: %#v", w.session)
	}
	if len(w.messages) != 1 || w.messages["old-message"].ID != "old-message" {
		t.Fatalf("messages mutated: %#v", w.messages)
	}
}

func assertNoWorkspaceEvent(t *testing.T, w *GmpWorkspace) {
	t.Helper()
	select {
	case event := <-w.events:
		t.Fatalf("unexpected workspace event: %#v", event)
	case <-time.After(30 * time.Millisecond):
	}
}
