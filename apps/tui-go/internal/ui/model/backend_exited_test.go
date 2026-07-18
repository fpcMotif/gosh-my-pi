package model

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

// TestBackendExitedMsg_EntersBannerRenderState asserts the model transitions
// into the backend-exited render state on workspace.BackendExitedMsg and that
// View then draws the legible "connection lost" banner instead of the normal
// transcript. This is the UI half of gap G28: a dead RPC subprocess must show
// a styled notice, not a frozen UI.
func TestBackendExitedMsg_EntersBannerRenderState(t *testing.T) {
	t.Parallel()

	m := newTestUI()
	// View() reads Workspace.WorkingDir() for the window title; the default
	// test UI has a nil workspace, so wire a minimal stub (Styles stay as
	// populated by newTestUI).
	m.com.Workspace = &bannerWorkspace{}

	if m.backendExited {
		t.Fatal("backendExited set before any BackendExitedMsg")
	}

	updated, _ := m.Update(workspace.BackendExitedMsg{})
	ui, ok := updated.(*UI)
	if !ok {
		t.Fatalf("Update returned %T, want *UI", updated)
	}

	if !ui.backendExited {
		t.Fatal("backendExited flag not set after BackendExitedMsg")
	}

	// View must short-circuit to the banner — not the frozen transcript.
	content := ui.View().Content
	if !strings.Contains(content, backendExitedHeading) {
		t.Fatalf("banner heading %q not rendered after backend exit; got:\n%s", backendExitedHeading, content)
	}
	if !strings.Contains(content, "exited unexpectedly") {
		t.Fatalf("banner detail missing after backend exit; got:\n%s", content)
	}
}

func TestBackendExitedMsg_OverloadRendersCause(t *testing.T) {
	t.Parallel()

	m := newTestUI()
	m.com.Workspace = &bannerWorkspace{}

	updated, _ := m.Update(workspace.BackendExitedMsg{Reason: workspace.BackendExitUIOverload})
	ui, ok := updated.(*UI)
	if !ok {
		t.Fatalf("Update returned %T, want *UI", updated)
	}
	if ui.backendExitReason != workspace.BackendExitUIOverload {
		t.Fatalf("backend exit reason = %v, want UI overload", ui.backendExitReason)
	}
	if content := ui.View().Content; !strings.Contains(content, backendOverloadDetail) {
		t.Fatalf("overload detail missing after UI mailbox overload; got:\n%s", content)
	}
}

// bannerWorkspace is a minimal Workspace stub: the backend-exited View path
// only consults WorkingDir() (for the window title) before returning the
// banner, so nothing else needs implementing.
type bannerWorkspace struct {
	workspace.Workspace
}

func (*bannerWorkspace) WorkingDir() string { return "/tmp/banner-test" }
