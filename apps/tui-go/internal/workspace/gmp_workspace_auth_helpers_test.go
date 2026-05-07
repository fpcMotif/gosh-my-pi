package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/oauth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// pipeClient wires an ompclient.Client to in-memory pipes so tests can
// observe outbound frames (sentFrames) and synthesize responses
// (clientStdout). Callers Close() to terminate the read loop.
type pipeClient struct {
	*ompclient.Client
	inboundPipeR  io.ReadCloser
	outboundPipeR io.ReadCloser
	clientStdout  io.WriteCloser
	clientStdin   io.WriteCloser

	mu         sync.Mutex
	sentFrames []map[string]any
}

func newPipeClient(t *testing.T) *pipeClient {
	t.Helper()
	// Client perspective: stdin = where Client writes outbound frames.
	// We wire that to a pipe whose read-end the test consumes.
	outR, outW := io.Pipe()
	// Client perspective: stdout = where Client reads inbound frames.
	// We wire that to a pipe whose write-end the test produces.
	inR, inW := io.Pipe()

	pc := &pipeClient{
		inboundPipeR:  inR,  // owned by client
		outboundPipeR: outR, // owned by test
		clientStdout:  inW,  // test writes inbound frames here
		clientStdin:   outW, // client writes outbound frames here
	}
	pc.Client = ompclient.NewWithIO(outW, inR)

	// Outbound capture goroutine.
	go func() {
		s := bufio.NewScanner(outR)
		for s.Scan() {
			var frame map[string]any
			if err := json.Unmarshal(s.Bytes(), &frame); err == nil {
				pc.mu.Lock()
				pc.sentFrames = append(pc.sentFrames, frame)
				pc.mu.Unlock()
			}
		}
	}()
	return pc
}

func (pc *pipeClient) frames() []map[string]any {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	out := make([]map[string]any, len(pc.sentFrames))
	copy(out, pc.sentFrames)
	return out
}

// writeInbound feeds a JSON frame into the Client's stdout (the side it reads).
func (pc *pipeClient) writeInbound(frame any) error {
	buf, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if _, err := pc.clientStdout.Write(append(buf, '\n')); err != nil {
		return err
	}
	return nil
}

func (pc *pipeClient) close() {
	_ = pc.clientStdin.Close()
	_ = pc.clientStdout.Close()
	_ = pc.inboundPipeR.Close()
	_ = pc.outboundPipeR.Close()
}

// waitForFrame polls until the test goroutine has captured a frame, or
// the deadline expires.
func (pc *pipeClient) waitForFrame(t *testing.T, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		fs := pc.frames()
		if len(fs) > 0 {
			return fs[len(fs)-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for outbound frame")
	return nil
}

func TestBuildAuthCommand(t *testing.T) {
	t.Parallel()
	got := buildAuthCommand(auth.CommandLogin, "openai-codex")
	if got.Type != auth.CommandLogin || got.Provider != "openai-codex" {
		t.Fatalf("buildAuthCommand mismatch: %#v", got)
	}
}

func TestInterpretAuthResponse(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		resp    *ompclient.Response
		wantErr string
	}{
		{name: "nil response is success", resp: nil},
		{name: "success=true is success", resp: &ompclient.Response{Success: true}},
		{name: "success=false with error reports error", resp: &ompclient.Response{Success: false, Error: "boom"}, wantErr: "boom"},
		{name: "success=false without error message is silently OK", resp: &ompclient.Response{Success: false, Error: ""}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := interpretAuthResponse(tc.resp)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
				return
			}
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("expected error %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestBuildAuthReplyFrame(t *testing.T) {
	t.Parallel()
	confirmedTrue := true
	cases := []struct {
		name string
		in   tea.Msg
		want ompclient.ExtensionUIResp
		ok   bool
	}{
		{
			name: "submit",
			in:   auth.Submit{ID: "id-1", Value: "v"},
			want: ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: "id-1", Value: "v"},
			ok:   true,
		},
		{
			name: "confirm",
			in:   auth.Confirm{ID: "id-2"},
			want: ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: "id-2", Confirmed: &confirmedTrue},
			ok:   true,
		},
		{
			name: "cancel",
			in:   auth.Cancel{ID: "id-3"},
			want: ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: "id-3", Cancelled: true},
			ok:   true,
		},
		{
			name: "unrelated message is ignored",
			in:   "some random string",
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := buildAuthReplyFrame(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok mismatch: got=%v want=%v", ok, tc.ok)
			}
			if !ok {
				return
			}
			if got.Type != tc.want.Type || got.ID != tc.want.ID || got.Value != tc.want.Value || got.Cancelled != tc.want.Cancelled {
				t.Fatalf("frame mismatch:\n got: %#v\nwant: %#v", got, tc.want)
			}
			if (got.Confirmed == nil) != (tc.want.Confirmed == nil) {
				t.Fatalf("Confirmed presence mismatch: got=%v want=%v", got.Confirmed, tc.want.Confirmed)
			}
			if got.Confirmed != nil && *got.Confirmed != *tc.want.Confirmed {
				t.Fatalf("Confirmed mismatch: got=%v want=%v", *got.Confirmed, *tc.want.Confirmed)
			}
		})
	}
}

func TestSendAuthCommand_NilClientReturnsError(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{} // no client
	err := w.SendAuthCommand(auth.CommandLogin, "openai-codex")
	if err == nil {
		t.Fatalf("expected error when client is nil, got nil")
	}
	if !errors.Is(err, err) /* trivial check */ || err.Error() != "gmp client not initialised" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHandleAuthReply_NoOpOnUnrelatedMessage(t *testing.T) {
	t.Parallel()
	// w.client is nil; handler must not call Send on unrelated messages.
	w := &GmpWorkspace{}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("HandleAuthReply panicked on unrelated msg: %v", r)
		}
	}()
	w.HandleAuthReply("not an auth reply")
}

func TestBuildCancelledExtensionUIResponse(t *testing.T) {
	t.Parallel()
	got := buildCancelledExtensionUIResponse("id-c")
	if got.Type != "extension_ui_response" || got.ID != "id-c" || !got.Cancelled {
		t.Fatalf("cancel frame mismatch: %#v", got)
	}
}

func TestDispatchExtensionUIRequest_NilOrEmptyIDIsNoOp(t *testing.T) {
	t.Parallel()
	w := newTestGmpWorkspace()
	// nil
	w.dispatchExtensionUIRequest(nil)
	// empty id
	w.dispatchExtensionUIRequest(&ompclient.ExtensionUIReq{ID: "", Method: auth.MethodPromptCode})
	// neither should have queued any UI events.
	select {
	case ev := <-w.events:
		t.Fatalf("unexpected UI event for invalid request: %v", ev)
	default:
	}
}

func TestDispatchExtensionUIRequest_NonAuthMethodSendsCancel(t *testing.T) {
	t.Parallel()
	w := newTestGmpWorkspace()
	pc := newPipeClient(t)
	defer pc.close()
	w.client = pc.Client

	req := raw(t, "id-x", "select", map[string]any{"title": "x", "options": []string{"a"}})
	w.dispatchExtensionUIRequest(req)
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["id"] != "id-x" || frame["cancelled"] != true {
		t.Fatalf("expected auto-cancel for non-auth method, got %#v", frame)
	}
}

func TestDispatchExtensionUIRequest_AuthMethodForwardsToUI(t *testing.T) {
	t.Parallel()
	w := newTestGmpWorkspace()
	req := raw(t, "id-1", auth.MethodPromptCode, map[string]any{"provider": "kimi-code", "placeholder": "p"})
	w.dispatchExtensionUIRequest(req)
	select {
	case ev := <-w.events:
		got, ok := ev.(auth.PromptCode)
		if !ok {
			t.Fatalf("expected auth.PromptCode event, got %T", ev)
		}
		if got.ID != "id-1" || got.Provider != "kimi-code" || got.Placeholder != "p" {
			t.Fatalf("event payload mismatch: %#v", got)
		}
	case <-time.After(testEventTimeout):
		t.Fatalf("timed out waiting for UI event")
	}
}

// gmpWorkspaceWithClient wires a pipeClient into a GmpWorkspace so the IO
// write paths (HandleAuthReply, sendCancelledExtensionUIResponse,
// SendAuthCommand happy path) can be exercised without forking gmp.
//
// We assemble the workspace manually rather than calling NewGmpWorkspace
// because the latter blocks on client.Call(get_state) during init, and the
// test peer cannot reasonably reply to it before the test setup is done.
func gmpWorkspaceWithClient(t *testing.T) (*GmpWorkspace, *pipeClient) {
	t.Helper()
	pc := newPipeClient(t)
	w := newTestGmpWorkspace()
	w.client = pc.Client
	return w, pc
}

func TestHandleAuthReply_SendsSubmitFrame(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.HandleAuthReply(auth.Submit{ID: "id-x", Value: "the-value"})
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "extension_ui_response" || frame["id"] != "id-x" || frame["value"] != "the-value" {
		t.Fatalf("unexpected frame: %#v", frame)
	}
}

func TestHandleAuthReply_SendsCancelFrame(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	w.HandleAuthReply(auth.Cancel{ID: "id-c"})
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["cancelled"] != true {
		t.Fatalf("expected cancelled=true, got %#v", frame)
	}
}

func TestSendCancelledExtensionUIResponse_SendsFrame(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	w.sendCancelledExtensionUIResponse("id-cancel", "select")
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["id"] != "id-cancel" || frame["cancelled"] != true {
		t.Fatalf("unexpected frame: %#v", frame)
	}
}

func TestSendCancelledExtensionUIResponse_LogsOnSendError(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	// Close the client's stdin (outW) before sending so Send fails.
	_ = pc.clientStdin.Close()
	defer pc.close()
	// Should not panic; error is logged via slog.Debug.
	w.sendCancelledExtensionUIResponse("id", "select")
}

func TestHandleAuthReply_LogsOnSendError(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	_ = pc.clientStdin.Close()
	defer pc.close()
	// Should not panic; error is logged via slog.Debug.
	w.HandleAuthReply(auth.Submit{ID: "id", Value: "v"})
}

func TestDrainExtensionUI_DispatchesAndExitsCleanly(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	done := make(chan struct{})
	go func() {
		w.drainExtensionUI()
		close(done)
	}()

	// Push one inbound auth.* request via the Client's stdout pipe; Client's
	// readLoop will route it to the extension_ui channel which drainExtensionUI
	// is reading.
	if err := pc.writeInbound(map[string]any{
		"type":     "extension_ui_request",
		"id":       "id-d",
		"method":   auth.MethodPromptCode,
		"provider": "openai-codex",
	}); err != nil {
		t.Fatalf("writeInbound: %v", err)
	}

	// Wait for the UI event to confirm the dispatcher saw it.
	select {
	case ev := <-w.events:
		if _, ok := ev.(auth.PromptCode); !ok {
			t.Fatalf("expected auth.PromptCode, got %T", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for auth event")
	}

	// Closing the inbound write pipe causes Client.readLoop to EOF, which
	// closes the extensionUI channel and unblocks drainExtensionUI's loop.
	_ = pc.clientStdout.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("drainExtensionUI did not exit after channel close")
	}
}

func TestSendAuthCommand_HappyPath(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	// Run SendAuthCommand in a goroutine; it blocks on Call until we
	// supply a response.
	errCh := make(chan error, 1)
	go func() { errCh <- w.SendAuthCommand(auth.CommandLogin, "openai-codex") }()

	// Wait for the outbound command frame so we can read its id.
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != auth.CommandLogin {
		t.Fatalf("expected outbound command type %q, got %v", auth.CommandLogin, frame["type"])
	}
	id, _ := frame["id"].(string)
	if id == "" {
		t.Fatalf("expected non-empty id in outbound command")
	}

	// Synthesize a success Response.
	if err := pc.writeInbound(map[string]any{
		"type":    "response",
		"id":      id,
		"command": auth.CommandLogin,
		"success": true,
		"data":    map[string]any{"provider": "openai-codex", "ok": true},
	}); err != nil {
		t.Fatalf("write inbound: %v", err)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("SendAuthCommand returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SendAuthCommand")
	}
}

func TestSendAuthCommand_FailureResponse(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	errCh := make(chan error, 1)
	go func() { errCh <- w.SendAuthCommand(auth.CommandLogout, "openai-codex") }()

	frame := pc.waitForFrame(t, 2*time.Second)
	id := frame["id"].(string)
	_ = pc.writeInbound(map[string]any{
		"type":    "response",
		"id":      id,
		"command": auth.CommandLogout,
		"success": false,
		"error":   "no such provider",
	})
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatalf("expected error, got nil")
		}
		if !contains(err.Error(), "no such provider") {
			t.Fatalf("expected error containing 'no such provider', got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SendAuthCommand")
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestSetProviderAPIKey_NilClientIsNoOp(t *testing.T) {
	t.Parallel()
	// Matches Crush's prior contract: callers may invoke SetProviderAPIKey
	// before the gmp client is wired up (test rigs, very early onboarding),
	// and the call must succeed silently rather than error.
	w := &GmpWorkspace{}
	if err := w.SetProviderAPIKey(config.ScopeGlobal, "openai", "sk-x"); err != nil {
		t.Fatalf("SetProviderAPIKey nil client should be no-op, got %v", err)
	}
}

func TestSetProviderAPIKey_HappyPath(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	errCh := make(chan error, 1)
	go func() {
		errCh <- w.SetProviderAPIKey(config.ScopeGlobal, "openai", "sk-test-1234")
	}()

	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != auth.CommandSetAPIKey {
		t.Fatalf("expected outbound type %q, got %v", auth.CommandSetAPIKey, frame["type"])
	}
	if frame["provider"] != "openai" {
		t.Fatalf("expected provider=openai, got %v", frame["provider"])
	}
	if frame["apiKey"] != "sk-test-1234" {
		t.Fatalf("expected apiKey forwarded verbatim, got %v", frame["apiKey"])
	}
	id, _ := frame["id"].(string)
	if id == "" {
		t.Fatalf("expected non-empty id in outbound command")
	}

	if err := pc.writeInbound(map[string]any{
		"type":    "response",
		"id":      id,
		"command": auth.CommandSetAPIKey,
		"success": true,
		"data":    map[string]any{"provider": "openai"},
	}); err != nil {
		t.Fatalf("write inbound: %v", err)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("SetProviderAPIKey returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SetProviderAPIKey")
	}
}

func TestSetProviderAPIKey_BackendErrorPropagates(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	errCh := make(chan error, 1)
	go func() {
		errCh <- w.SetProviderAPIKey(config.ScopeGlobal, "openai", "sk-test")
	}()

	frame := pc.waitForFrame(t, 2*time.Second)
	id, _ := frame["id"].(string)
	_ = pc.writeInbound(map[string]any{
		"type":    "response",
		"id":      id,
		"command": auth.CommandSetAPIKey,
		"success": false,
		"error":   "provider must be a non-empty string",
	})

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatalf("expected error from backend, got nil")
		}
		if !contains(err.Error(), "provider must be a non-empty string") {
			t.Fatalf("expected backend error to propagate, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SetProviderAPIKey")
	}
}

func TestSetProviderAPIKey_NonStringIsSilentNoOp(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	// OAuth tokens (Hyper / Copilot legacy dialogs) flow through this method
	// in Crush, but gmp drives those providers through auth.login. Anything
	// other than a string credential should not produce a wire frame.
	tok := &oauth.Token{AccessToken: "hyper-token"}
	if err := w.SetProviderAPIKey(config.ScopeGlobal, "hyper", tok); err != nil {
		t.Fatalf("non-string credential should be silent no-op, got %v", err)
	}
	// Give the (possibly faulty) write goroutine a moment to flush.
	time.Sleep(20 * time.Millisecond)
	if frames := pc.frames(); len(frames) != 0 {
		t.Fatalf("expected no outbound frames for non-string credential, got %#v", frames)
	}
}

func TestSetProviderAPIKey_EmptyArgsAreSilentNoOp(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	if err := w.SetProviderAPIKey(config.ScopeGlobal, "", "sk-x"); err != nil {
		t.Fatalf("empty providerID should be no-op, got %v", err)
	}
	if err := w.SetProviderAPIKey(config.ScopeGlobal, "openai", ""); err != nil {
		t.Fatalf("empty apiKey should be no-op, got %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if frames := pc.frames(); len(frames) != 0 {
		t.Fatalf("expected no outbound frames for empty args, got %#v", frames)
	}
}

// silence unused-import lint
var _ = context.Background
