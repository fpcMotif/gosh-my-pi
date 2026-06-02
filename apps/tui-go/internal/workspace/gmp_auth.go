package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// Per-method auth.* extension_ui_request payloads. Each variant in the
// TS-side `RpcExtensionUIRequest.method: "auth.*"` union has a matching
// struct here, so JSON unmarshal targets the actual wire shape rather
// than a flat catch-all. Pair-locked with the TS-side `AuthRequestPayload`
// derived type (packages/coding-agent/src/modes/rpc/rpc-types.ts) and
// asserted at startup by the init() parity check below.
type (
	authShowLoginURLPayload struct {
		Provider     string `json:"provider"`
		URL          string `json:"url"`
		Instructions string `json:"instructions,omitempty"`
	}
	authShowProgressPayload struct {
		Provider string `json:"provider"`
		Message  string `json:"message"`
	}
	authPromptCodePayload struct {
		Provider    string `json:"provider"`
		Placeholder string `json:"placeholder,omitempty"`
		AllowEmpty  bool   `json:"allowEmpty,omitempty"`
	}
	authPromptManualRedirectPayload struct {
		Provider     string `json:"provider"`
		Instructions string `json:"instructions"`
	}
	authShowResultPayload struct {
		Provider  string   `json:"provider"`
		Success   bool     `json:"success"`
		Error     string   `json:"error,omitempty"`
		Providers []string `json:"providers,omitempty"`
	}
	authPickProviderPayload struct {
		Options   []string `json:"options"`
		DefaultID string   `json:"defaultId,omitempty"`
	}
)

// authDecoder is the shared shape of an authDecoders entry: a function
// that consumes the inbound id + raw JSON for one auth.* method and
// produces either a typed tea.Msg or a decode error. The decodeAuth[T]
// helper builds these from a typed builder closure so each entry's
// payload is statically known.
type authDecoder func(id string, raw json.RawMessage) (tea.Msg, error)

// decodeAuth wires a typed payload builder into the authDecoder shape.
// Generic over the payload struct so each map entry can be written with
// its actual decoded type rather than a flat catch-all. Pure for
// testability.
func decodeAuth[T any](build func(id string, p T) tea.Msg) authDecoder {
	return func(id string, raw json.RawMessage) (tea.Msg, error) {
		var p T
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return build(id, p), nil
	}
}

// authMethods is the canonical list of auth.* method constants this
// dispatcher must support. Sourced once so the init() parity check
// and TestAuthDecoderParity drive off the same set. Adding a new
// auth.MethodX constant requires appending to this list AND adding a
// decoder; the init() check turns either omission into a startup
// panic.
var authMethods = []string{
	auth.MethodShowLoginURL,
	auth.MethodShowProgress,
	auth.MethodPromptCode,
	auth.MethodPromptManualRedirect,
	auth.MethodShowResult,
	auth.MethodPickProvider,
}

// authDecoders maps each auth.* method constant to its decoder. Pair-
// locked with the TS-side AuthRequestPayload union; the init() block
// below ensures every authMethods entry has a matching decoder.
var authDecoders = map[string]authDecoder{
	auth.MethodShowLoginURL: decodeAuth(func(id string, p authShowLoginURLPayload) tea.Msg {
		return auth.ShowLoginURL{ID: id, Provider: p.Provider, URL: p.URL, Instructions: p.Instructions}
	}),
	auth.MethodShowProgress: decodeAuth(func(id string, p authShowProgressPayload) tea.Msg {
		return auth.ShowProgress{ID: id, Provider: p.Provider, Message: p.Message}
	}),
	auth.MethodPromptCode: decodeAuth(func(id string, p authPromptCodePayload) tea.Msg {
		return auth.PromptCode{ID: id, Provider: p.Provider, Placeholder: p.Placeholder, AllowEmpty: p.AllowEmpty}
	}),
	auth.MethodPromptManualRedirect: decodeAuth(func(id string, p authPromptManualRedirectPayload) tea.Msg {
		return auth.PromptManualRedirect{ID: id, Provider: p.Provider, Instructions: p.Instructions}
	}),
	auth.MethodShowResult: decodeAuth(func(id string, p authShowResultPayload) tea.Msg {
		return auth.ShowResult{ID: id, Provider: p.Provider, Success: p.Success, Error: p.Error, Providers: p.Providers}
	}),
	auth.MethodPickProvider: decodeAuth(func(id string, p authPickProviderPayload) tea.Msg {
		return auth.PickProvider{ID: id, Options: p.Options, DefaultID: p.DefaultID}
	}),
}

// init enforces every entry in authMethods has a decoder. Without this
// check, a method added to the const list but forgotten in authDecoders
// would silently fall through to auto-cancel at runtime. The matching
// guarantee on the TS side is `AuthRequestPayload` rejecting unknown
// methods at compile time.
func init() {
	ensureAuthDecoderParity(authMethods, authDecoders)
}

// ensureAuthDecoderParity panics if any entry in `methods` lacks an
// entry in `decoders`. Extracted for testability; the production
// init() block calls this with the package-level maps, while
// TestAuthDecoderInitPanicsOnMissing passes a synthesized pair to
// exercise the panic path.
func ensureAuthDecoderParity(methods []string, decoders map[string]authDecoder) {
	if missing := missingAuthDecoders(methods, decoders); len(missing) > 0 {
		panic("gmp workspace: auth decoder missing for: " + strings.Join(missing, ", "))
	}
}

// missingAuthDecoders returns the entries in `methods` that have no
// entry in `decoders`. Pure for testability.
func missingAuthDecoders(methods []string, decoders map[string]authDecoder) []string {
	var missing []string
	for _, m := range methods {
		if _, ok := decoders[m]; !ok {
			missing = append(missing, m)
		}
	}
	return missing
}

// translateAuthRequest returns a Bubble Tea message for an inbound
// auth.* extension_ui_request, or nil if the method is not a known auth
// flow method (in which case drainExtensionUI falls back to its
// default-cancel response).
func (w *GmpWorkspace) translateAuthRequest(req *ompclient.ExtensionUIReq) tea.Msg {
	if !strings.HasPrefix(req.Method, "auth.") {
		return nil
	}
	decode, ok := authDecoders[req.Method]
	if !ok {
		slog.Debug("gmp workspace: unknown auth.* method, falling back to cancel", "method", req.Method, "id", req.ID)
		return nil
	}
	msg, err := decode(req.ID, req.Raw)
	if err != nil {
		slog.Warn("gmp workspace: failed to parse auth payload", "method", req.Method, "id", req.ID, "error", err)
		return nil
	}
	return msg
}

// SendAuthCommand fires an auth.login or auth.logout Command at the
// gmp backend. Returns when the backend acknowledges the command (the
// actual login flow is driven asynchronously by extension_ui_request
// frames once the dialog is open).
func (w *GmpWorkspace) SendAuthCommand(method string, provider string) error {
	if w.client == nil {
		return errors.New("gmp client not initialised")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	resp, err := w.client.Call(ctx, buildAuthCommand(method, provider))
	if err != nil {
		return err
	}
	return interpretAuthResponse(resp)
}

// buildAuthCommand assembles the wire frame for an auth.login / auth.logout
// command. Pure for testability.
func buildAuthCommand(method, provider string) ompclient.Command {
	return ompclient.Command{Type: method, Provider: provider}
}

// interpretAuthResponse converts an `auth.*` Response back into a Go error
// (nil on success). Pure for testability.
func interpretAuthResponse(resp *ompclient.Response) error {
	if resp != nil && !resp.Success && resp.Error != "" {
		return errors.New(resp.Error)
	}
	return nil
}

// HandleAuthReply translates a Bubble Tea reply (auth.Submit /
// Confirm / Cancel) into the matching extension_ui_response on the
// wire. The model layer calls this when the user dismisses an auth
// dialog.
func (w *GmpWorkspace) HandleAuthReply(msg tea.Msg) {
	resp, ok := buildAuthReplyFrame(msg)
	if !ok {
		return
	}
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: auth reply send failed", "id", resp.ID, "error", err)
	}
}

// buildAuthReplyFrame converts an inbound Bubble Tea auth reply message into
// the wire-level ExtensionUIResp. Returns ok=false for any unrelated message.
// Pure for testability.
func buildAuthReplyFrame(msg tea.Msg) (ompclient.ExtensionUIResp, bool) {
	switch m := msg.(type) {
	case auth.Submit:
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Value: m.Value}, true
	case auth.Confirm:
		confirmed := true
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Confirmed: &confirmed}, true
	case auth.Cancel:
		return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Cancelled: true}, true
	default:
		return ompclient.ExtensionUIResp{}, false
	}
}
