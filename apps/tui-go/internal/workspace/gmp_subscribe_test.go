package workspace

import (
	"context"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
)

// TestDrainStep_RecoversAndContinues pins the drainer-resilience contract: a
// panic processing one side-channel frame must not unwind the drain loop. The
// bug this guards against put recover() at goroutine scope (deferred in the
// drain func), so the first panicking frame killed the whole `for range`
// drainer — with no consumer the side-channel buffer then filled after 16
// frames and wedged the ompclient read loop (stalling responses and agent
// events too). drainStep scopes recover to a single iteration, so the loop
// keeps draining subsequent frames.
func TestDrainStep_RecoversAndContinues(t *testing.T) {
	t.Parallel()
	calls := 0
	steps := []func(){
		func() { calls++ },
		func() { calls++; panic("bad frame") },
		func() { calls++ },
	}
	for _, fn := range steps {
		// Must not propagate the panic to this loop — that is the regression.
		drainStep("test", fn)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3: drainStep must isolate a per-frame panic so every frame is still processed", calls)
	}
}

// TestSyncInitialSnapshotCancelsPreSubscribeUIRequest proves startup drains
// side requests before its first RPC round trip. An auth prompt cannot wait
// for a Bubble Tea program that has not been attached yet.
func TestSyncInitialSnapshotCancelsPreSubscribeUIRequest(t *testing.T) {
	pc := newPipeClient(t)
	defer pc.close()
	w := NewGmpWorkspace(pc.Client, t.TempDir())

	done := make(chan error, 1)
	go func() { done <- w.SyncInitialSnapshot(context.Background()) }()

	state := waitForWorkspaceFrame(t, pc, func(frame map[string]any) bool {
		return frame["type"] == "get_state"
	})
	if err := pc.writeInbound(map[string]any{
		"type":     "extension_ui_request",
		"id":       "startup-auth",
		"method":   auth.MethodPromptCode,
		"provider": "openai-codex",
	}); err != nil {
		t.Fatalf("write startup auth request: %v", err)
	}
	cancelled := waitForWorkspaceFrame(t, pc, func(frame map[string]any) bool {
		return frame["type"] == "extension_ui_response" && frame["id"] == "startup-auth"
	})
	if cancelled["cancelled"] != true {
		t.Fatalf("pre-subscribe response = %#v, want cancelled", cancelled)
	}

	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": state["id"], "command": "get_state", "success": true,
		"data": map[string]any{"sessionId": "startup-session"},
	}); err != nil {
		t.Fatalf("write state response: %v", err)
	}
	messages := waitForWorkspaceFrame(t, pc, func(frame map[string]any) bool {
		return frame["type"] == "get_messages"
	})
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": messages["id"], "command": "get_messages", "success": true,
		"data": map[string]any{"messages": []any{}},
	}); err != nil {
		t.Fatalf("write messages response: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SyncInitialSnapshot: %v", err)
		}
	case <-time.After(testEventTimeout):
		t.Fatal("SyncInitialSnapshot did not complete")
	}
}

// TestExtensionUIRequestCancelsWhenOfferIsRejected proves an unusable UI sink
// cannot strand a backend session_start hook.
func TestExtensionUIRequestCancelsWhenOfferIsRejected(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.events = make(chan tea.Msg)

	w.dispatchExtensionUIRequest(raw(t, "rejected-auth", auth.MethodPromptCode, map[string]any{
		"provider": "openai-codex",
	}))
	frame := waitForWorkspaceFrame(t, pc, func(frame map[string]any) bool {
		return frame["type"] == "extension_ui_response" && frame["id"] == "rejected-auth"
	})
	if frame["cancelled"] != true {
		t.Fatalf("rejected UI response = %#v, want cancelled", frame)
	}
}

// TestSubscribeStartsOneEventsConsumer proves re-subscribing only rebinds the
// UI sink. It cannot split the one backend stream or leave a second consumer
// behind after transport shutdown.
func TestSubscribeStartsOneEventsConsumer(t *testing.T) {
	pc := newPipeClient(t)
	defer pc.close()
	w := NewGmpWorkspace(pc.Client, t.TempDir())
	w.events = make(chan tea.Msg, 4)

	w.Subscribe(nil)
	w.Subscribe(nil)

	if err := pc.writeInbound(map[string]any{"type": "agent_start"}); err != nil {
		t.Fatalf("write agent start: %v", err)
	}
	if err := pc.writeInbound(map[string]any{
		"type":    "message_start",
		"message": map[string]any{"id": "one", "role": "assistant", "content": []any{}, "timestamp": 1_700_000_000_000},
	}); err != nil {
		t.Fatalf("write message start: %v", err)
	}
	nextMessageEvent(t, w)

	if err := pc.clientStdout.Close(); err != nil {
		t.Fatalf("close backend stdout: %v", err)
	}
	select {
	case <-pc.Done():
	case <-time.After(testEventTimeout):
		t.Fatal("event consumer did not exit with transport")
	}
	exit := nextUIEvent(t, w)
	if _, ok := exit.(BackendExitedMsg); !ok {
		t.Fatalf("terminal event = %T, want BackendExitedMsg", exit)
	}
	select {
	case extra := <-w.events:
		t.Fatalf("duplicate terminal event after re-subscribe: %#v", extra)
	case <-time.After(50 * time.Millisecond):
	}
	deadline := time.Now().Add(testEventTimeout)
	for w.AgentIsBusy() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if w.AgentIsBusy() {
		t.Fatal("event consumer did not clear busy state on exit")
	}
}

func waitForWorkspaceFrame(t *testing.T, pc *pipeClient, matches func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(testEventTimeout)
	for time.Now().Before(deadline) {
		for _, frame := range pc.frames() {
			if matches(frame) {
				return frame
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for outbound frame")
	return nil
}
