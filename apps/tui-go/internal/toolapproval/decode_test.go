package toolapproval

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecode_RequestApprovalRoundTrips(t *testing.T) {
	raw := json.RawMessage(`{"toolCallId":"tc-1","toolName":"bash","params":{"command":"rm -rf /tmp/x","workingDir":"/repo"}}`)
	msg, ok, err := Decode(MethodRequestApproval, "id-1", raw)
	if !ok || err != nil {
		t.Fatalf("Decode = ok=%v err=%v, want ok=true err=nil", ok, err)
	}
	req, isType := msg.(Request)
	if !isType {
		t.Fatalf("Decode returned %T, want Request", msg)
	}
	if req.ID != "id-1" || req.ToolCallID != "tc-1" || req.ToolName != "bash" {
		t.Fatalf("decoded request mismatch: %+v", req)
	}
	if req.Params.Command != "rm -rf /tmp/x" || req.Params.WorkingDir != "/repo" {
		t.Fatalf("decoded params mismatch: %+v", req.Params)
	}
}

func TestDecode_UnknownMethodReturnsNotOk(t *testing.T) {
	msg, ok, err := Decode("tool.does_not_exist", "id", json.RawMessage(`{}`))
	if ok || msg != nil || err != nil {
		t.Fatalf("Decode(unknown) = (%v, %v, %v), want (nil, false, nil)", msg, ok, err)
	}
}

func TestDecode_BadPayloadReturnsError(t *testing.T) {
	msg, ok, err := Decode(MethodRequestApproval, "id", json.RawMessage(`{not valid`))
	if !ok {
		t.Fatalf("Decode(known, bad json) ok=false, want true")
	}
	if err == nil {
		t.Fatalf("Decode(known, bad json) err=nil, want a decode error")
	}
	if msg != nil {
		t.Fatalf("Decode(known, bad json) msg=%v, want nil", msg)
	}
}

// TestDecoderParity is the runtime half of the wire contract, pair-locked with
// the ToolApprovalRequestPayload type in
// packages/coding-agent/src/modes/rpc/rpc-types.ts: every method constant has a
// matching decoder, and no orphan decoder exists without a constant.
func TestDecoderParity(t *testing.T) {
	t.Parallel()
	if missing := missingDecoders(methods, decoders); len(missing) > 0 {
		t.Fatalf("methods without a decoder: %v", missing)
	}
	known := make(map[string]struct{}, len(methods))
	for _, m := range methods {
		known[m] = struct{}{}
	}
	for k := range decoders {
		if _, ok := known[k]; !ok {
			t.Errorf("decoders entry %q has no matching method in methods", k)
		}
	}
}

func TestEnsureParity_PanicsOnMissing(t *testing.T) {
	t.Parallel()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("expected ensureParity to panic on a missing decoder")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "tool.synthetic_missing") {
			t.Fatalf("panic message did not name the missing method: %v", r)
		}
	}()
	ensureParity([]string{MethodRequestApproval, "tool.synthetic_missing"}, decoders)
}

func TestEnsureParity_NoPanicOnComplete(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ensureParity panicked unexpectedly: %v", r)
		}
	}()
	ensureParity(methods, decoders)
}
