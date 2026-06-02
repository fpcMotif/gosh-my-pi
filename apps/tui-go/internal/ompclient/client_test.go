package ompclient

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

const testTimeout = 2 * time.Second

// fakePeer wires a Client to an in-memory peer over two io.Pipes. The
// Client reads frames the peer writes via peerWrite, and the peer can
// observe commands the Client sends via peerRead. Closing either pipe
// simulates the subprocess exiting. This drives the NewWithIO seam
// without forking a real gmp process.
type fakePeer struct {
	client    *Client
	peerWrite *io.PipeWriter // Client.stdout source (peer -> client)
	peerRead  *bufio.Scanner // Client.stdin sink (client -> peer)
	stdinR    *io.PipeReader
	stdoutW   *io.PipeWriter
}

func newFakePeer(t *testing.T) *fakePeer {
	t.Helper()
	// stdin: Client writes -> stdinR is the peer's read end.
	stdinR, stdinW := io.Pipe()
	// stdout: peer writes via stdoutW -> Client reads from stdoutR.
	stdoutR, stdoutW := io.Pipe()

	client := NewWithIO(stdinW, stdoutR)
	fp := &fakePeer{
		client:    client,
		peerWrite: stdoutW,
		peerRead:  bufio.NewScanner(stdinR),
		stdinR:    stdinR,
		stdoutW:   stdoutW,
	}
	t.Cleanup(func() {
		_ = stdoutW.Close()
		_ = stdinW.Close()
		_ = stdinR.Close()
		_ = stdoutR.Close()
	})
	return fp
}

// writeFrame emits one JSONL frame from the peer to the Client.
func (fp *fakePeer) writeFrame(t *testing.T, frame any) {
	t.Helper()
	data, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}
	if _, err := fp.peerWrite.Write(append(data, '\n')); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// readCommand blocks until the Client sends one command, returning its
// decoded id and type.
func (fp *fakePeer) readCommand(t *testing.T) (id, typ string) {
	t.Helper()
	type result struct {
		id, typ string
		ok      bool
	}
	ch := make(chan result, 1)
	go func() {
		if !fp.peerRead.Scan() {
			ch <- result{}
			return
		}
		var cmd struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(fp.peerRead.Bytes(), &cmd)
		ch <- result{id: cmd.ID, typ: cmd.Type, ok: true}
	}()
	select {
	case r := <-ch:
		if !r.ok {
			t.Fatal("peer: client sent no command before stdin closed")
		}
		return r.id, r.typ
	case <-time.After(testTimeout):
		t.Fatal("peer: timed out waiting for client command")
		return "", ""
	}
}

// TestCallResponseRoundTrip asserts Call correlates a response by id: the
// matching-id response resolves the call, while a non-matching id is
// dropped and must not resolve it.
func TestCallResponseRoundTrip(t *testing.T) {
	fp := newFakePeer(t)

	respCh := make(chan *Response, 1)
	errCh := make(chan error, 1)
	go func() {
		resp, err := fp.client.Call(context.Background(), Command{ID: "c1", Type: "prompt"})
		respCh <- resp
		errCh <- err
	}()

	if id, typ := fp.readCommand(t); id != "c1" || typ != "prompt" {
		t.Fatalf("client sent id=%q type=%q, want c1/prompt", id, typ)
	}

	// A non-matching id must not resolve the pending c1 call.
	fp.writeFrame(t, map[string]any{
		"id": "other", "type": "response", "command": "prompt", "success": true,
	})
	select {
	case resp := <-respCh:
		t.Fatalf("non-matching id resolved the call: %#v", resp)
	case <-time.After(100 * time.Millisecond):
	}

	// The matching id resolves it with the response payload.
	fp.writeFrame(t, map[string]any{
		"id": "c1", "type": "response", "command": "prompt", "success": true,
		"data": map[string]any{"ok": true},
	})
	select {
	case resp := <-respCh:
		if err := <-errCh; err != nil {
			t.Fatalf("Call error: %v", err)
		}
		if resp == nil || resp.ID != "c1" || !resp.Success {
			t.Fatalf("resp = %#v, want successful c1", resp)
		}
	case <-time.After(testTimeout):
		t.Fatal("matching id did not resolve the call")
	}
}

// TestCall_FailedResponseSurfacesError asserts a success=false response
// resolves the call with the backend error rather than hanging.
func TestCall_FailedResponseSurfacesError(t *testing.T) {
	fp := newFakePeer(t)

	errCh := make(chan error, 1)
	go func() {
		_, err := fp.client.Call(context.Background(), Command{ID: "c1", Type: "set_model"})
		errCh <- err
	}()
	fp.readCommand(t)

	fp.writeFrame(t, map[string]any{
		"id": "c1", "type": "response", "command": "set_model",
		"success": false, "error": "unknown model",
	})
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("want error for success=false response, got nil")
		}
	case <-time.After(testTimeout):
		t.Fatal("failed response did not resolve the call")
	}
}

// TestCall_SubprocessExitWakesPending is the key regression guard: when
// the peer's stdout closes mid-call (subprocess exit), a pending Call
// must return a subprocess-exited error promptly instead of hanging
// forever on its response channel.
func TestCall_SubprocessExitWakesPending(t *testing.T) {
	fp := newFakePeer(t)

	errCh := make(chan error, 1)
	go func() {
		_, err := fp.client.Call(context.Background(), Command{ID: "c1", Type: "prompt"})
		errCh <- err
	}()
	fp.readCommand(t) // ensure the call is registered as pending

	// Close the Client's stdout source: readLoop ends and must wake the
	// pending caller via the closed pending channel / done signal.
	_ = fp.peerWrite.Close()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("subprocess exit did not produce an error")
		}
	case <-time.After(testTimeout):
		t.Fatal("pending Call hung after subprocess exit — regression")
	}
}

// TestCall_ContextCancelUnblocks asserts a cancelled context unblocks a
// pending Call promptly with the context error.
func TestCall_ContextCancelUnblocks(t *testing.T) {
	fp := newFakePeer(t)
	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		_, err := fp.client.Call(ctx, Command{ID: "c1", Type: "prompt"})
		errCh <- err
	}()
	fp.readCommand(t)
	cancel()

	select {
	case err := <-errCh:
		if err != context.Canceled {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("cancelled Call did not unblock")
	}
}

// TestSideChannelFanOut asserts a frame with no pending caller — an
// extension_ui_request — is routed to its side channel rather than
// dropped, so the read loop never deadlocks waiting for a consumer.
func TestSideChannelFanOut(t *testing.T) {
	fp := newFakePeer(t)

	fp.writeFrame(t, map[string]any{
		"type": "extension_ui_request", "id": "u1", "method": "auth.showProgress",
	})
	select {
	case req := <-fp.client.ExtensionUIRequests():
		if req == nil || req.ID != "u1" || req.Method != "auth.showProgress" {
			t.Fatalf("side-channel req = %#v, want u1/auth.showProgress", req)
		}
	case <-time.After(testTimeout):
		t.Fatal("extension_ui_request not routed to side channel")
	}
}

// TestClose_ReturnsWithoutSubprocess asserts Close on a NewWithIO client
// (no os/exec process) returns promptly once the peer's stdout has
// closed, rather than panicking on the nil cmd or blocking forever.
func TestClose_ReturnsWithoutSubprocess(t *testing.T) {
	fp := newFakePeer(t)

	// Peer exit: closing stdout EOFs the read loop so Close resolves on
	// <-c.done well within the grace window.
	_ = fp.peerWrite.Close()

	done := make(chan error, 1)
	go func() { done <- fp.client.Close() }()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("Close blocked beyond timeout")
	}

	// Idempotent: a second Close (closeOnce) returns immediately.
	if err := fp.client.Close(); err != nil {
		t.Fatalf("second Close returned %v, want nil", err)
	}
}

// TestBackendExited_UnexpectedEOFSignalsOnce asserts an unexpected peer
// exit — closing the Client's stdout source WITHOUT calling Close — fires
// the BackendExited signal exactly once. This is the transport-local
// lifecycle signal the UI observes to render a "connection lost" banner
// instead of freezing.
func TestBackendExited_UnexpectedEOFSignalsOnce(t *testing.T) {
	fp := newFakePeer(t)

	// Peer crash: closing stdout EOFs the read loop. Since Close was never
	// called, this is an unexpected exit and must surface BackendExited.
	_ = fp.peerWrite.Close()

	select {
	case <-fp.client.BackendExited():
	case <-time.After(testTimeout):
		t.Fatal("BackendExited not signalled after unexpected peer EOF")
	}

	// Exactly once: the channel is closed (not a one-shot send), so a second
	// read must also be ready — and crucially must not panic from a double
	// close. A fresh select observing it again confirms idempotency.
	select {
	case <-fp.client.BackendExited():
	case <-time.After(testTimeout):
		t.Fatal("BackendExited should stay observable after the first read")
	}
}

// TestBackendExited_IntentionalCloseDoesNotSignal asserts a normal Close —
// the intentional-shutdown path — does NOT fire BackendExited, so the UI
// never shows a false "connection lost" banner on a clean quit. Close marks
// the shutdown intentional before the read loop's EOF, so the resulting
// loop termination is not mistaken for a crash.
func TestBackendExited_IntentionalCloseDoesNotSignal(t *testing.T) {
	fp := newFakePeer(t)

	// Close drives the intentional shutdown. With a real subprocess, closing
	// stdin makes the peer exit and close its stdout, which EOFs the read
	// loop. The fake peer has no such linkage, so model the peer winding
	// down in response: close its stdout writer once Close has marked the
	// shutdown intentional, letting the read loop drain.
	go func() {
		// Close blocks on <-c.done until the read loop ends; closing the
		// peer's stdout from here is what ends it. closeRequested is already
		// set by the time Close reaches the wait, so the EOF is classified as
		// intentional, not a crash.
		<-time.After(20 * time.Millisecond)
		_ = fp.peerWrite.Close()
	}()

	done := make(chan error, 1)
	go func() { done <- fp.client.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close returned %v, want nil", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Close blocked beyond timeout")
	}

	// Read loop ended (Done closed), but BackendExited must remain open
	// because the shutdown was intentional.
	select {
	case <-fp.client.Done():
	case <-time.After(testTimeout):
		t.Fatal("Done not closed after Close")
	}
	select {
	case <-fp.client.BackendExited():
		t.Fatal("BackendExited fired on intentional Close — false connection-lost signal")
	default:
	}
}

// TestReadySchema_Match asserts the canonical ready frame negotiates the
// expected schema, sets no mismatch flag, and is preserved as a raw
// agent event (soft-buffer fan-out, not dropped).
func TestReadySchema_Match(t *testing.T) {
	fp := newFakePeer(t)

	fp.writeFrame(t, ReadyFrame{Type: "ready", Schema: ExpectedSchema})

	select {
	case ev := <-fp.client.Events():
		if ev == nil || ev.Kind != "ready" {
			t.Fatalf("event = %#v, want preserved ready frame", ev)
		}
	case <-time.After(testTimeout):
		t.Fatal("ready frame not fanned out as agent event")
	}
	if got := fp.client.Schema(); got != ExpectedSchema {
		t.Fatalf("Schema() = %q, want %q", got, ExpectedSchema)
	}
	if fp.client.SchemaMismatch() {
		t.Fatal("SchemaMismatch() = true for matching schema")
	}
}

// TestReadySchema_Mismatch asserts a divergent schema is surfaced via the
// mismatch flag while the read loop keeps running: the ready frame is
// still preserved as a raw event and a subsequent Call still correlates.
// This is the soft-buffer contract — warn, do not crash.
func TestReadySchema_Mismatch(t *testing.T) {
	fp := newFakePeer(t)

	fp.writeFrame(t, ReadyFrame{Type: "ready", Schema: "omp-rpc/v2"})
	select {
	case ev := <-fp.client.Events():
		if ev == nil || ev.Kind != "ready" {
			t.Fatalf("event = %#v, want preserved ready frame", ev)
		}
	case <-time.After(testTimeout):
		t.Fatal("mismatched ready frame not fanned out — read loop may have crashed")
	}
	if got := fp.client.Schema(); got != "omp-rpc/v2" {
		t.Fatalf("Schema() = %q, want omp-rpc/v2", got)
	}
	if !fp.client.SchemaMismatch() {
		t.Fatal("SchemaMismatch() = false for divergent schema")
	}

	// Read loop survived: a normal request/response still correlates.
	errCh := make(chan error, 1)
	go func() {
		_, err := fp.client.Call(context.Background(), Command{ID: "c1", Type: "get_state"})
		errCh <- err
	}()
	fp.readCommand(t)
	fp.writeFrame(t, map[string]any{
		"id": "c1", "type": "response", "command": "get_state", "success": true,
	})
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("Call after schema mismatch failed: %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("read loop died after schema mismatch — Call hung")
	}
}

// TestDispatch_MalformedAndUnknownFramesSoftBuffer pins the soft-buffer contract
// (TC8): a non-JSON line surfaces as Kind "_raw" and an unknown frame type
// surfaces with its type as the event Kind — both delivered via Events() through
// the non-blocking emitEvent path (GMP-CORR-2), never crashing or wedging the
// read loop on a frame the consumer doesn't recognize.
func TestDispatch_MalformedAndUnknownFramesSoftBuffer(t *testing.T) {
	fp := newFakePeer(t)

	// A non-JSON line must not kill the read loop; it is preserved as _raw.
	if _, err := fp.peerWrite.Write([]byte("this is not json\n")); err != nil {
		t.Fatalf("write malformed line: %v", err)
	}
	select {
	case ev := <-fp.client.Events():
		if ev.Kind != "_raw" {
			t.Errorf("malformed frame Kind = %q, want _raw", ev.Kind)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for _raw event")
	}

	// An unknown frame type is preserved with its type as the Kind so the
	// consumer can soft-buffer it (additive v1 evolution).
	fp.writeFrame(t, map[string]any{"type": "totally_new_event", "payload": 1})
	select {
	case ev := <-fp.client.Events():
		if ev.Kind != "totally_new_event" {
			t.Errorf("unknown frame Kind = %q, want totally_new_event", ev.Kind)
		}
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for unknown-type event")
	}
}
