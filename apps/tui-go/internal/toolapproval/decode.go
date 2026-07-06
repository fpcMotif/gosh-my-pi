package toolapproval

import (
	"encoding/json"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// requestPayload is the wire payload for a tool.request_approval
// extension_ui_request. Pair-locked with ToolApprovalRequestPayload in
// packages/coding-agent/src/modes/rpc/rpc-types.ts and asserted at startup by
// the init() parity check below.
type requestPayload struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Params     Params `json:"params"`
}

// decoder consumes the inbound id + raw JSON for a tool-approval method and
// produces a typed tea.Msg or a decode error.
type decoder func(id string, raw json.RawMessage) (tea.Msg, error)

// methods is the canonical list of tool-approval method constants this package
// decodes. Sourced once so the init() parity check and TestDecoderParity drive
// off the same set; adding a method requires appending here AND a decoder, or
// the init() check turns the omission into a startup panic.
var methods = []string{MethodRequestApproval}

// decoders maps each tool-approval method to its decoder. Pair-locked with the
// TS-side ToolApprovalRequestPayload union; init() ensures every methods entry
// has a decoder.
var decoders = map[string]decoder{
	MethodRequestApproval: func(id string, raw json.RawMessage) (tea.Msg, error) {
		var p requestPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return Request{ID: id, ToolCallID: p.ToolCallID, ToolName: p.ToolName, Params: p.Params}, nil
	},
}

func init() {
	ensureParity(methods, decoders)
}

// ensureParity panics if any entry in methods lacks a decoder. Extracted so the
// startup panic path is unit-testable without re-triggering package init().
func ensureParity(methods []string, decoders map[string]decoder) {
	if missing := missingDecoders(methods, decoders); len(missing) > 0 {
		panic("toolapproval: decoder missing for: " + strings.Join(missing, ", "))
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

// Decode decodes an inbound tool-approval extension_ui_request into a Bubble Tea
// message. Returns (msg, true, nil) on success, (nil, false, nil) for an unknown
// method (the caller falls back to default-cancel, which denies — the safe
// default), and (nil, true, err) for a known method whose payload failed to parse.
func Decode(method, id string, raw json.RawMessage) (tea.Msg, bool, error) {
	dec, ok := decoders[method]
	if !ok {
		return nil, false, nil
	}
	msg, err := dec(id, raw)
	return msg, true, err
}
