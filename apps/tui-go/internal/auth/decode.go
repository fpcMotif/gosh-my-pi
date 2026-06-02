package auth

import (
	"encoding/json"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// Per-method auth.* extension_ui_request payloads. Each variant in the TS-side
// `RpcExtensionUIRequest.method: "auth.*"` union has a matching struct here, so
// JSON unmarshal targets the actual wire shape rather than a flat catch-all.
// Pair-locked with the TS-side `AuthRequestPayload` derived type
// (packages/coding-agent/src/modes/rpc/rpc-types.ts) and asserted at startup by
// the init() parity check below.
type (
	showLoginURLPayload struct {
		Provider     string `json:"provider"`
		URL          string `json:"url"`
		Instructions string `json:"instructions,omitempty"`
	}
	showProgressPayload struct {
		Provider string `json:"provider"`
		Message  string `json:"message"`
	}
	promptCodePayload struct {
		Provider    string `json:"provider"`
		Placeholder string `json:"placeholder,omitempty"`
		AllowEmpty  bool   `json:"allowEmpty,omitempty"`
	}
	promptManualRedirectPayload struct {
		Provider     string `json:"provider"`
		Instructions string `json:"instructions"`
	}
	showResultPayload struct {
		Provider  string   `json:"provider"`
		Success   bool     `json:"success"`
		Error     string   `json:"error,omitempty"`
		Providers []string `json:"providers,omitempty"`
	}
	pickProviderPayload struct {
		Options   []string `json:"options"`
		DefaultID string   `json:"defaultId,omitempty"`
	}
)

// decoder consumes the inbound id + raw JSON for one auth.* method and produces
// either a typed tea.Msg or a decode error. decodeAs[T] builds these from a
// typed builder closure so each entry's payload is statically known.
type decoder func(id string, raw json.RawMessage) (tea.Msg, error)

// decodeAs wires a typed payload builder into the decoder shape. Generic over
// the payload struct so each map entry can be written with its actual decoded
// type rather than a flat catch-all.
func decodeAs[T any](build func(id string, p T) tea.Msg) decoder {
	return func(id string, raw json.RawMessage) (tea.Msg, error) {
		var p T
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return build(id, p), nil
	}
}

// methods is the canonical list of auth.* method constants this package
// decodes. Sourced once so the init() parity check and TestDecoderParity drive
// off the same set. Adding a new MethodX constant requires appending here AND
// adding a decoder; the init() check turns either omission into a startup panic.
var methods = []string{
	MethodShowLoginURL,
	MethodShowProgress,
	MethodPromptCode,
	MethodPromptManualRedirect,
	MethodShowResult,
	MethodPickProvider,
}

// decoders maps each auth.* method constant to its decoder. Pair-locked with
// the TS-side AuthRequestPayload union; the init() block ensures every methods
// entry has a matching decoder.
var decoders = map[string]decoder{
	MethodShowLoginURL: decodeAs(func(id string, p showLoginURLPayload) tea.Msg {
		return ShowLoginURL{ID: id, Provider: p.Provider, URL: p.URL, Instructions: p.Instructions}
	}),
	MethodShowProgress: decodeAs(func(id string, p showProgressPayload) tea.Msg {
		return ShowProgress{ID: id, Provider: p.Provider, Message: p.Message}
	}),
	MethodPromptCode: decodeAs(func(id string, p promptCodePayload) tea.Msg {
		return PromptCode{ID: id, Provider: p.Provider, Placeholder: p.Placeholder, AllowEmpty: p.AllowEmpty}
	}),
	MethodPromptManualRedirect: decodeAs(func(id string, p promptManualRedirectPayload) tea.Msg {
		return PromptManualRedirect{ID: id, Provider: p.Provider, Instructions: p.Instructions}
	}),
	MethodShowResult: decodeAs(func(id string, p showResultPayload) tea.Msg {
		return ShowResult{ID: id, Provider: p.Provider, Success: p.Success, Error: p.Error, Providers: p.Providers}
	}),
	MethodPickProvider: decodeAs(func(id string, p pickProviderPayload) tea.Msg {
		return PickProvider{ID: id, Options: p.Options, DefaultID: p.DefaultID}
	}),
}

// init enforces every entry in methods has a decoder. Without this check, a
// method added to the const list but forgotten in decoders would silently fall
// through to auto-cancel at runtime. The matching guarantee on the TS side is
// `AuthRequestPayload` rejecting unknown methods at compile time.
func init() {
	ensureParity(methods, decoders)
}

// ensureParity panics if any entry in methods lacks a decoder. Extracted so the
// startup panic path is unit-testable without re-triggering package init().
func ensureParity(methods []string, decoders map[string]decoder) {
	if missing := missingDecoders(methods, decoders); len(missing) > 0 {
		panic("auth: decoder missing for: " + strings.Join(missing, ", "))
	}
}

// missingDecoders returns the entries in methods that have no entry in
// decoders. Pure for testability.
func missingDecoders(methods []string, decoders map[string]decoder) []string {
	var missing []string
	for _, m := range methods {
		if _, ok := decoders[m]; !ok {
			missing = append(missing, m)
		}
	}
	return missing
}

// Decode decodes an inbound auth.* extension_ui_request into a Bubble Tea
// message. Returns (msg, true, nil) on success, (nil, false, nil) for an
// unknown method (caller falls back to its default-cancel path), and
// (nil, true, err) for a known method whose payload failed to parse.
func Decode(method, id string, raw json.RawMessage) (tea.Msg, bool, error) {
	dec, ok := decoders[method]
	if !ok {
		return nil, false, nil
	}
	msg, err := dec(id, raw)
	return msg, true, err
}
