package toolapproval

// Params is the small per-tool summary carried on a tool.request_approval
// request. Mirrors ToolApprovalParams in
// packages/coding-agent/src/modes/rpc/rpc-types.ts. Only the fields
// relevant to the gated tool are populated; the workspace renders these
// into the existing per-tool dialog.Permissions Params (bash command,
// file path + old/new content for the diff view).
type Params struct {
	Command     string `json:"command,omitempty"`
	WorkingDir  string `json:"workingDir,omitempty"`
	FilePath    string `json:"filePath,omitempty"`
	OldContent  string `json:"oldContent,omitempty"`
	NewContent  string `json:"newContent,omitempty"`
	Description string `json:"description,omitempty"`
}

// Request signals that the gmp backend wants the host to approve (or deny)
// a gated built-in tool before it executes. The UI opens dialog.Permissions
// built from ToolName + Params and replies via an
// ActionPermissionResponse, which GmpWorkspace.HandleToolApprovalReply
// translates into the extension_ui_response carrying this same ID so the
// gmp-side correlator unblocks. The read loop always replies (a dismissed
// dialog denies), so the backend never deadlocks waiting on a gate.
type Request struct {
	ID         string
	ToolCallID string
	ToolName   string
	Params     Params
}
