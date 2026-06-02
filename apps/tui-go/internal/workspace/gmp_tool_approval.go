package workspace

import (
	"cmp"
	"log/slog"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/toolapproval"
)

// ============================================================================
// Tool-approval gate (ADR 0007)
// ============================================================================

// translateToolApprovalRequest returns a Bubble Tea message for an inbound
// tool.request_approval extension_ui_request, or nil if the method is not a
// known tool-approval method (drainExtensionUI then falls back to its
// default-cancel response, which denies the tool — the safe default). The pure
// decode layer (payload, decoder table, startup parity check) lives in the
// `toolapproval` package alongside the method constant and Request type.
func (w *GmpWorkspace) translateToolApprovalRequest(req *ompclient.ExtensionUIReq) tea.Msg {
	msg, ok, err := toolapproval.Decode(req.Method, req.ID, req.Raw)
	if !ok {
		return nil
	}
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
