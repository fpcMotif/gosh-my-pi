package workspace

import (
	"encoding/json"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// raw builds an ExtensionUIReq with the JSON-encoded payload as Raw, so
// translateAuthRequest can decode it the same way the read loop does in
// production.
func raw(t *testing.T, id string, method string, payload map[string]any) *ompclient.ExtensionUIReq {
	t.Helper()
	full := map[string]any{"type": "extension_ui_request", "id": id, "method": method}
	for k, v := range payload {
		full[k] = v
	}
	rawBytes, err := json.Marshal(full)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return &ompclient.ExtensionUIReq{ID: id, Method: method, Raw: rawBytes}
}

func TestTranslateAuthRequest_KnownMethods(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}

	cases := []struct {
		name    string
		method  string
		payload map[string]any
		want    tea.Msg
	}{
		{
			name:   "show_login_url",
			method: auth.MethodShowLoginURL,
			payload: map[string]any{
				"provider":     "openai-codex",
				"url":          "https://chatgpt.com/auth",
				"instructions": "Sign in",
			},
			want: auth.ShowLoginURL{
				ID: "id-1", Provider: "openai-codex", URL: "https://chatgpt.com/auth", Instructions: "Sign in",
			},
		},
		{
			name:   "show_progress",
			method: auth.MethodShowProgress,
			payload: map[string]any{
				"provider": "kimi-code",
				"message":  "exchanging token",
			},
			want: auth.ShowProgress{ID: "id-1", Provider: "kimi-code", Message: "exchanging token"},
		},
		{
			name:   "prompt_code",
			method: auth.MethodPromptCode,
			payload: map[string]any{
				"provider":    "kimi-code",
				"placeholder": "Paste device code…",
				"allowEmpty":  false,
			},
			want: auth.PromptCode{ID: "id-1", Provider: "kimi-code", Placeholder: "Paste device code…", AllowEmpty: false},
		},
		{
			name:   "prompt_manual_redirect",
			method: auth.MethodPromptManualRedirect,
			payload: map[string]any{
				"provider":     "openai-codex",
				"instructions": "Paste callback URL",
			},
			want: auth.PromptManualRedirect{ID: "id-1", Provider: "openai-codex", Instructions: "Paste callback URL"},
		},
		{
			name:   "show_result_success",
			method: auth.MethodShowResult,
			payload: map[string]any{
				"provider": "openai-codex",
				"success":  true,
			},
			want: auth.ShowResult{ID: "id-1", Provider: "openai-codex", Success: true},
		},
		{
			name:   "show_result_error",
			method: auth.MethodShowResult,
			payload: map[string]any{
				"provider": "openai-codex",
				"success":  false,
				"error":    "invalid grant",
			},
			want: auth.ShowResult{ID: "id-1", Provider: "openai-codex", Error: "invalid grant"},
		},
		{
			name:   "pick_provider",
			method: auth.MethodPickProvider,
			payload: map[string]any{
				"options":   []string{"openai-codex", "kimi-code"},
				"defaultId": "openai-codex",
			},
			want: auth.PickProvider{ID: "id-1", Options: []string{"openai-codex", "kimi-code"}, DefaultID: "openai-codex"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := w.translateAuthRequest(raw(t, "id-1", tc.method, tc.payload))
			if got == nil {
				t.Fatalf("expected non-nil message for %s", tc.method)
			}
			// Round-trip through JSON to compare; tea.Msg is interface{}.
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(tc.want)
			if string(gotJSON) != string(wantJSON) {
				t.Fatalf("decoded message mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestTranslateAuthRequest_NonAuthMethodReturnsNil(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	got := w.translateAuthRequest(raw(t, "id-x", "select", map[string]any{"title": "x", "options": []string{"a"}}))
	if got != nil {
		t.Fatalf("expected nil for non-auth method, got %#v", got)
	}
}

func TestTranslateAuthRequest_UnknownAuthMethodReturnsNil(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	got := w.translateAuthRequest(raw(t, "id-x", "auth.unknown_thing", map[string]any{"provider": "x"}))
	if got != nil {
		t.Fatalf("expected nil for unknown auth method, got %#v", got)
	}
}

func TestTranslateAuthRequest_MalformedJSONReturnsNil(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	req := &ompclient.ExtensionUIReq{ID: "id-x", Method: auth.MethodPromptCode, Raw: []byte("{not json")}
	got := w.translateAuthRequest(req)
	if got != nil {
		t.Fatalf("expected nil for malformed JSON, got %#v", got)
	}
}

// TestAuthDecoderParity is the runtime half of the type contract.
// Pair-locked with the TS-side `AuthRequestPayload type contract` block
// in packages/coding-agent/test/rpc-oauth-controller.test.ts. Each side
// asserts the same shape: every auth.MethodX constant has a matching
// decoder/payload variant. Drift on either side fails its own suite.
func TestAuthDecoderParity(t *testing.T) {
	t.Parallel()
	if missing := missingAuthDecoders(authMethods, authDecoders); len(missing) > 0 {
		t.Fatalf("authDecoders missing entries for: %v", missing)
	}
	// authMethods must also be a subset of authDecoders' keys (no orphan
	// decoder allowed without a const). Catches the mirror drift case.
	known := make(map[string]struct{}, len(authMethods))
	for _, m := range authMethods {
		known[m] = struct{}{}
	}
	for k := range authDecoders {
		if _, ok := known[k]; !ok {
			t.Errorf("authDecoders entry %q has no matching auth.MethodX in authMethods", k)
		}
	}
}

// TestAuthDecoderInitPanicsOnMissing exercises the init-time panic via
// the extracted ensureAuthDecoderParity helper. We can't re-trigger
// init() from a test, but the helper's body is the load-bearing part —
// it's what would surface a wire-vs-decoder mismatch on a real binary
// startup.
func TestAuthDecoderInitPanicsOnMissing(t *testing.T) {
	t.Parallel()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatalf("expected ensureAuthDecoderParity to panic on missing decoder")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic value was not a string: %T %v", r, r)
		}
		if !strings.Contains(msg, "auth.synthetic_missing") {
			t.Fatalf("panic message did not mention the missing method: %s", msg)
		}
	}()

	// Synthetic pair: one method present, one method missing.
	methods := []string{auth.MethodShowLoginURL, "auth.synthetic_missing"}
	decoders := map[string]authDecoder{
		auth.MethodShowLoginURL: authDecoders[auth.MethodShowLoginURL],
	}
	ensureAuthDecoderParity(methods, decoders)
}

// TestAuthDecoderInitNoPanicOnComplete confirms the helper is silent
// when the pair is in sync — paired with the panic test, the two
// together prove ensureAuthDecoderParity's full contract.
func TestAuthDecoderInitNoPanicOnComplete(t *testing.T) {
	t.Parallel()
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ensureAuthDecoderParity panicked unexpectedly: %v", r)
		}
	}()
	ensureAuthDecoderParity(authMethods, authDecoders)
}
