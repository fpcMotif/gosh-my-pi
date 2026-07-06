package workspace

import (
	"testing"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/toolapproval"
)

func TestTranslateToolApprovalRequest_Decodes(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	req := raw(t, "ta-1", toolapproval.MethodRequestApproval, map[string]any{
		"toolCallId": "call-1",
		"toolName":   "bash",
		"params":     map[string]any{"command": "rm -rf /tmp/x", "workingDir": "/repo"},
	})
	got := w.translateToolApprovalRequest(req)
	msg, ok := got.(toolapproval.Request)
	if !ok {
		t.Fatalf("expected toolapproval.Request, got %T", got)
	}
	if msg.ID != "ta-1" || msg.ToolCallID != "call-1" || msg.ToolName != "bash" {
		t.Fatalf("envelope mismatch: %#v", msg)
	}
	if msg.Params.Command != "rm -rf /tmp/x" || msg.Params.WorkingDir != "/repo" {
		t.Fatalf("params mismatch: %#v", msg.Params)
	}
}

func TestTranslateToolApprovalRequest_NonMatchingMethodReturnsNil(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	if got := w.translateToolApprovalRequest(raw(t, "x", "select", map[string]any{"title": "x"})); got != nil {
		t.Fatalf("expected nil for non tool-approval method, got %#v", got)
	}
}

func TestTranslateToolApprovalRequest_MalformedJSONReturnsNil(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{}
	req := &ompclient.ExtensionUIReq{ID: "x", Method: toolapproval.MethodRequestApproval, Raw: []byte("{not json")}
	if got := w.translateToolApprovalRequest(req); got != nil {
		t.Fatalf("expected nil for malformed JSON, got %#v", got)
	}
}

// TestDispatchExtensionUIRequest_ToolApprovalForwardsToUI confirms the
// dispatcher routes a tool.request_approval frame to the UI rather than
// auto-cancelling it (the read loop must surface the gate, not silently
// deny).
func TestDispatchExtensionUIRequest_ToolApprovalForwardsToUI(t *testing.T) {
	t.Parallel()
	w := newTestGmpWorkspace()
	req := raw(t, "ta-2", toolapproval.MethodRequestApproval, map[string]any{
		"toolCallId": "c2",
		"toolName":   "write",
		"params":     map[string]any{"filePath": "a.txt", "newContent": "hi"},
	})
	w.dispatchExtensionUIRequest(req)
	select {
	case ev := <-w.events:
		got, ok := ev.(toolapproval.Request)
		if !ok {
			t.Fatalf("expected toolapproval.Request event, got %T", ev)
		}
		if got.ID != "ta-2" || got.ToolName != "write" || got.Params.FilePath != "a.txt" {
			t.Fatalf("event payload mismatch: %#v", got)
		}
	case <-time.After(testEventTimeout):
		t.Fatalf("timed out waiting for tool-approval UI event")
	}
}

func TestToolApprovalPermissionRequest_PerToolParams(t *testing.T) {
	t.Parallel()
	bash := ToolApprovalPermissionRequest(toolapproval.Request{
		ID: "id-b", ToolCallID: "c", ToolName: tools.BashToolName,
		Params: toolapproval.Params{Command: "ls", WorkingDir: "/w", Description: "list"},
	})
	if bash.ID != "id-b" {
		t.Fatalf("bash request must carry the wire id, got %q", bash.ID)
	}
	bp, ok := bash.Params.(tools.BashPermissionsParams)
	if !ok {
		t.Fatalf("bash params type mismatch: %T", bash.Params)
	}
	if bp.Command != "ls" || bp.WorkingDir != "/w" {
		t.Fatalf("bash params mismatch: %#v", bp)
	}

	edit := ToolApprovalPermissionRequest(toolapproval.Request{
		ID: "id-e", ToolName: tools.EditToolName,
		Params: toolapproval.Params{FilePath: "a.ts", OldContent: "x", NewContent: "y"},
	})
	ep, ok := edit.Params.(tools.EditPermissionsParams)
	if !ok {
		t.Fatalf("edit params type mismatch: %T", edit.Params)
	}
	if ep.FilePath != "a.ts" || ep.OldContent != "x" || ep.NewContent != "y" {
		t.Fatalf("edit params mismatch: %#v", ep)
	}

	write := ToolApprovalPermissionRequest(toolapproval.Request{
		ID: "id-w", ToolName: tools.WriteToolName,
		Params: toolapproval.Params{FilePath: "b.txt", NewContent: "z"},
	})
	if _, ok := write.Params.(tools.WritePermissionsParams); !ok {
		t.Fatalf("write params type mismatch: %T", write.Params)
	}

	// apply_patch has no dedicated renderer → generic fallback, but still
	// carries the wire id so the reply can be correlated.
	patch := ToolApprovalPermissionRequest(toolapproval.Request{
		ID: "id-p", ToolName: "apply_patch",
		Params: toolapproval.Params{FilePath: "c.go", Description: "patch c.go"},
	})
	if patch.ID != "id-p" || patch.Path != "c.go" || patch.Description != "patch c.go" {
		t.Fatalf("apply_patch fallback mismatch: %#v", patch)
	}
}

func TestBuildToolApprovalReplyFrame(t *testing.T) {
	t.Parallel()
	approve := buildToolApprovalReplyFrame("id-1", true)
	if approve.Type != "extension_ui_response" || approve.ID != "id-1" || approve.Confirmed == nil || !*approve.Confirmed {
		t.Fatalf("approve frame mismatch: %#v", approve)
	}
	deny := buildToolApprovalReplyFrame("id-2", false)
	if deny.Confirmed == nil || *deny.Confirmed {
		t.Fatalf("deny frame must carry confirmed=false: %#v", deny)
	}
}

func TestHandleToolApprovalReply_SendsConfirmFrame(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	w.HandleToolApprovalReply(permRequestWithID("id-x"), true)
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "extension_ui_response" || frame["id"] != "id-x" || frame["confirmed"] != true {
		t.Fatalf("unexpected approve frame: %#v", frame)
	}
}

func TestHandleToolApprovalReply_SendsDenyFrame(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	w.HandleToolApprovalReply(permRequestWithID("id-y"), false)
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["id"] != "id-y" || frame["confirmed"] != false {
		t.Fatalf("expected confirmed=false deny frame, got %#v", frame)
	}
}

func TestHandleToolApprovalReply_NoOpOnEmptyID(t *testing.T) {
	t.Parallel()
	w := &GmpWorkspace{} // nil client; must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("HandleToolApprovalReply panicked: %v", r)
		}
	}()
	w.HandleToolApprovalReply(permRequestWithID(""), true)
}

// The tool-approval decoder parity tests (TestDecoderParity / TestEnsureParity_*)
// moved into package toolapproval alongside the decode layer they exercise —
// see internal/toolapproval/decode_test.go.

func permRequestWithID(id string) permission.PermissionRequest {
	return ToolApprovalPermissionRequest(toolapproval.Request{ID: id, ToolName: tools.BashToolName})
}
