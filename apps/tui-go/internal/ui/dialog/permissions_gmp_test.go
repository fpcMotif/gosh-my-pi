package dialog

import (
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

func newToolApprovalPermissions(t *testing.T, action string) *Permissions {
	t.Helper()
	st := uistyles.CharmtonePantera()
	com := &common.Common{Styles: &st}
	perm := permission.PermissionRequest{
		ID:       "ta-id",
		ToolName: tools.BashToolName,
		Action:   "execute",
		Params:   tools.BashPermissionsParams{Command: action},
	}
	return NewPermissions(com, perm)
}

// TestPermissions_DenyKeyEmitsResponseWithWireID proves the gate's full
// loop: a permissions dialog built from a tool-approval wire payload emits
// an ActionPermissionResponse that carries the wire request ID, so
// GmpWorkspace.HandleToolApprovalReply can correlate the deny back to the
// gmp side. Escape (Close) and the explicit deny key both deny.
func TestPermissions_DenyKeyEmitsResponseWithWireID(t *testing.T) {
	t.Parallel()
	p := newToolApprovalPermissions(t, "rm -rf /")
	msg := p.HandleMsg(tea.KeyPressMsg(tea.Key{Code: 'd'}))
	resp, ok := msg.(ActionPermissionResponse)
	if !ok {
		t.Fatalf("expected ActionPermissionResponse, got %T", msg)
	}
	if resp.Action != PermissionDeny {
		t.Fatalf("expected deny action, got %q", resp.Action)
	}
	if resp.Permission.ID != "ta-id" {
		t.Fatalf("response must carry the wire id for correlation, got %q", resp.Permission.ID)
	}
}

func TestPermissions_AllowKeyEmitsResponseWithWireID(t *testing.T) {
	t.Parallel()
	p := newToolApprovalPermissions(t, "ls")
	msg := p.HandleMsg(tea.KeyPressMsg(tea.Key{Code: 'a'}))
	resp, ok := msg.(ActionPermissionResponse)
	if !ok {
		t.Fatalf("expected ActionPermissionResponse, got %T", msg)
	}
	if resp.Action != PermissionAllow {
		t.Fatalf("expected allow action, got %q", resp.Action)
	}
	if resp.Permission.ID != "ta-id" {
		t.Fatalf("response must carry the wire id, got %q", resp.Permission.ID)
	}
}

// TestPermissions_EscapeDenies guards that dismissing the dialog denies
// (never silently approves) — the gate-by-default contract from ADR 0007.
func TestPermissions_EscapeDenies(t *testing.T) {
	t.Parallel()
	p := newToolApprovalPermissions(t, "curl evil")
	msg := p.HandleMsg(tea.KeyPressMsg(tea.Key{Code: tea.KeyEscape}))
	resp, ok := msg.(ActionPermissionResponse)
	if !ok {
		t.Fatalf("expected ActionPermissionResponse on escape, got %T", msg)
	}
	if resp.Action != PermissionDeny {
		t.Fatalf("escape must deny, got %q", resp.Action)
	}
}
