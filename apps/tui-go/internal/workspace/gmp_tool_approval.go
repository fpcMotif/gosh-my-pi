package workspace

import (
	"cmp"
	"encoding/json"
	"log/slog"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/toolapproval"
)

// ============================================================================
// Tool-approval gate (ADR 0007)
// ============================================================================

// toolApprovalRequestPayload is the wire payload for a tool.request_approval
// extension_ui_request. Pair-locked with ToolApprovalRequestPayload in
// packages/coding-agent/src/modes/rpc/rpc-types.ts and asserted at startup
// by the init() parity check below.
type toolApprovalRequestPayload struct {
	ToolCallID string              `json:"toolCallId"`
	ToolName   string              `json:"toolName"`
	Params     toolapproval.Params `json:"params"`
}

// toolApprovalDecoder mirrors authDecoder for the tool-approval flow: it
// consumes the inbound id + raw JSON for the method and produces a typed
// tea.Msg or a decode error.
type toolApprovalDecoder func(id string, raw json.RawMessage) (tea.Msg, error)

// toolApprovalMethods is the canonical list of tool-approval method
// constants this dispatcher must support. Sourced once so the init()
// parity check and TestToolApprovalDecoderParity drive off the same set —
// adding a new method requires appending here AND adding a decoder, or the
// init() check turns the omission into a startup panic.
var toolApprovalMethods = []string{
	toolapproval.MethodRequestApproval,
}

// toolApprovalDecoders maps each tool-approval method to its decoder.
// Pair-locked with the TS-side ToolApprovalRequestPayload union; the init()
// block below ensures every toolApprovalMethods entry has a decoder.
var toolApprovalDecoders = map[string]toolApprovalDecoder{
	toolapproval.MethodRequestApproval: func(id string, raw json.RawMessage) (tea.Msg, error) {
		var p toolApprovalRequestPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return toolapproval.Request{ID: id, ToolCallID: p.ToolCallID, ToolName: p.ToolName, Params: p.Params}, nil
	},
}

// init enforces every entry in toolApprovalMethods has a decoder, mirroring
// the auth parity check. A method added to the const list but forgotten in
// toolApprovalDecoders becomes a startup panic instead of a silent
// auto-cancel at runtime.
func init() {
	ensureToolApprovalDecoderParity(toolApprovalMethods, toolApprovalDecoders)
}

// ensureToolApprovalDecoderParity panics if any entry in `methods` lacks an
// entry in `decoders`. Extracted for testability.
func ensureToolApprovalDecoderParity(methods []string, decoders map[string]toolApprovalDecoder) {
	if missing := missingToolApprovalDecoders(methods, decoders); len(missing) > 0 {
		panic("gmp workspace: tool-approval decoder missing for: " + strings.Join(missing, ", "))
	}
}

// missingToolApprovalDecoders returns the entries in `methods` with no entry
// in `decoders`. Pure for testability.
func missingToolApprovalDecoders(methods []string, decoders map[string]toolApprovalDecoder) []string {
	var missing []string
	for _, m := range methods {
		if _, ok := decoders[m]; !ok {
			missing = append(missing, m)
		}
	}
	return missing
}

// translateToolApprovalRequest returns a Bubble Tea message for an inbound
// tool.request_approval extension_ui_request, or nil if the method is not a
// known tool-approval method (drainExtensionUI then falls back to its
// default-cancel response, which denies the tool — the safe default).
func (w *GmpWorkspace) translateToolApprovalRequest(req *ompclient.ExtensionUIReq) tea.Msg {
	decode, ok := toolApprovalDecoders[req.Method]
	if !ok {
		return nil
	}
	msg, err := decode(req.ID, req.Raw)
	if err != nil {
		slog.Warn("gmp workspace: failed to parse tool-approval payload", "method", req.Method, "id", req.ID, "error", err)
		return nil
	}
	return msg
}

// ToolApprovalPermissionRequest builds a permission.PermissionRequest from
// a tool-approval Request so the existing dialog.Permissions component can
// render it. The wire request ID is carried in PermissionRequest.ID so the
// approve/deny reply can be correlated back to the gmp side. Params are
// mapped into the per-tool tools.*PermissionsParams the dialog renders by
// ToolName; tools without a dedicated renderer fall back to the generic
// description. Pure for testability.
func ToolApprovalPermissionRequest(req toolapproval.Request) permission.PermissionRequest {
	perm := permission.PermissionRequest{
		ID:         req.ID,
		ToolCallID: req.ToolCallID,
		ToolName:   req.ToolName,
		Action:     "execute",
	}
	switch req.ToolName {
	case tools.BashToolName:
		perm.Path = req.Params.WorkingDir
		perm.Description = req.Params.Description
		perm.Params = tools.BashPermissionsParams{
			Description: req.Params.Description,
			Command:     req.Params.Command,
			WorkingDir:  req.Params.WorkingDir,
		}
	case tools.EditToolName:
		perm.Path = req.Params.FilePath
		perm.Params = tools.EditPermissionsParams{
			FilePath:   req.Params.FilePath,
			OldContent: req.Params.OldContent,
			NewContent: req.Params.NewContent,
		}
	case tools.WriteToolName:
		perm.Path = req.Params.FilePath
		perm.Params = tools.WritePermissionsParams{
			FilePath:   req.Params.FilePath,
			OldContent: req.Params.OldContent,
			NewContent: req.Params.NewContent,
		}
	default:
		// apply_patch and any future gated tool without a dedicated
		// renderer: carry the file path + a generic description so the
		// default dialog content path has something to show.
		perm.Path = req.Params.FilePath
		perm.Description = cmp.Or(req.Params.Description, req.Params.Command)
	}
	return perm
}

// HandleToolApprovalReply translates the dialog's approve/deny decision into
// the matching extension_ui_response on the wire, correlated by the wire
// request ID stored in PermissionRequest.ID. Sent through the same path
// HandleAuthReply uses. Approve → confirmed:true; deny (including a
// dismissed dialog) → confirmed:false. The model layer calls this in gmp
// mode instead of the inert Crush PermissionGrant/Deny no-ops.
func (w *GmpWorkspace) HandleToolApprovalReply(perm permission.PermissionRequest, approved bool) {
	if w.client == nil || perm.ID == "" {
		return
	}
	resp := buildToolApprovalReplyFrame(perm.ID, approved)
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: tool-approval reply send failed", "id", perm.ID, "error", err)
	}
}

// buildToolApprovalReplyFrame assembles the extension_ui_response for a
// tool-approval decision. Pure for testability.
func buildToolApprovalReplyFrame(id string, approved bool) ompclient.ExtensionUIResp {
	confirmed := approved
	return ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: id, Confirmed: &confirmed}
}
