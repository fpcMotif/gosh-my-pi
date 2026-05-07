package workspace

import (
	"encoding/json"
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
