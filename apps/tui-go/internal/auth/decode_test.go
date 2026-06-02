package auth

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecode_KnownMethodRoundTrips(t *testing.T) {
	raw := json.RawMessage(`{"provider":"openai","url":"https://example/auth","instructions":"open this"}`)
	msg, ok, err := Decode(MethodShowLoginURL, "id-1", raw)
	if !ok || err != nil {
		t.Fatalf("Decode = ok=%v err=%v, want ok=true err=nil", ok, err)
	}
	m, isType := msg.(ShowLoginURL)
	if !isType {
		t.Fatalf("Decode returned %T, want ShowLoginURL", msg)
	}
	if m.ID != "id-1" || m.Provider != "openai" || m.URL != "https://example/auth" || m.Instructions != "open this" {
		t.Fatalf("decoded fields mismatch: %+v", m)
	}
}

func TestDecode_UnknownMethodReturnsNotOk(t *testing.T) {
	msg, ok, err := Decode("auth.does_not_exist", "id", json.RawMessage(`{}`))
	if ok || msg != nil || err != nil {
		t.Fatalf("Decode(unknown) = (%v, %v, %v), want (nil, false, nil)", msg, ok, err)
	}
}

func TestDecode_KnownMethodBadPayloadReturnsError(t *testing.T) {
	// ok=true (the method is known) but err!=nil so the caller logs and
	// falls back to cancel rather than silently dropping a malformed frame.
	msg, ok, err := Decode(MethodPromptCode, "id", json.RawMessage(`{not valid json`))
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

// TestDecoderParity is the runtime half of the type contract. Pair-locked with
// the TS-side `AuthRequestPayload type contract` block in
// packages/coding-agent/test/rpc-oauth-controller.test.ts. Each side asserts the
// same shape: every auth.MethodX constant has a matching decoder/payload variant,
// and there are no orphan decoders without a constant. Drift fails its own suite.
func TestDecoderParity(t *testing.T) {
	t.Parallel()
	if missing := missingDecoders(methods, decoders); len(missing) > 0 {
		t.Fatalf("decoders missing entries for: %v", missing)
	}
	known := make(map[string]struct{}, len(methods))
	for _, m := range methods {
		known[m] = struct{}{}
	}
	for k := range decoders {
		if _, ok := known[k]; !ok {
			t.Errorf("decoders entry %q has no matching MethodX in methods", k)
		}
	}
}

// TestEnsureParity_PanicsOnMissing exercises the init-time panic path via the
// extracted ensureParity helper (init() itself can't be re-triggered from a
// test). This is the load-bearing check that surfaces a wire-vs-decoder
// mismatch at binary startup.
func TestEnsureParity_PanicsOnMissing(t *testing.T) {
	t.Parallel()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("expected ensureParity to panic on a missing decoder")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic value was not a string: %T %v", r, r)
		}
		if !strings.Contains(msg, "auth.synthetic_missing") {
			t.Fatalf("panic message did not mention the missing method: %s", msg)
		}
	}()

	synthMethods := []string{MethodShowLoginURL, "auth.synthetic_missing"}
	synthDecoders := map[string]decoder{MethodShowLoginURL: decoders[MethodShowLoginURL]}
	ensureParity(synthMethods, synthDecoders)
}

// TestEnsureParity_NoPanicOnComplete confirms the helper is silent when the
// pair is in sync — together with the panic test it pins ensureParity's full
// contract.
func TestEnsureParity_NoPanicOnComplete(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ensureParity panicked unexpectedly: %v", r)
		}
	}()
	ensureParity(methods, decoders)
}
