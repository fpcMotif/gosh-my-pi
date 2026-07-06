// Package toolapproval carries the method constant and Bubble Tea message
// for the tool-approval extension_ui_request flow (ADR 0007).
//
// The gmp coding-agent (packages/coding-agent) gates the destructive
// built-in tools (bash / edit / apply_patch / write) behind an additive
// OMP-RPC v1 approval round-trip. Before a gated tool runs it emits an
// extension_ui_request whose method is "tool.request_approval". The
// workspace bridge (internal/workspace/gmp_workspace.go) decodes that
// frame into the Request message defined here and posts it to the Bubble
// Tea program. Higher layers (internal/ui/model) open the existing
// dialog.Permissions component; the dialog's approve/deny is routed back
// through GmpWorkspace.HandleToolApprovalReply, which sends the matching
// extension_ui_response on the wire. The in-process Crush permission
// service stays inert (ADR 0001/0002).
package toolapproval

// MethodRequestApproval mirrors ToolApprovalMethod.RequestApproval in
// packages/coding-agent/src/modes/rpc/rpc-types.ts. Keep both sides in
// sync — a typo on either side silently falls through to the workspace's
// default cancel path and denies the tool with no diagnostic.
const MethodRequestApproval = "tool.request_approval"
