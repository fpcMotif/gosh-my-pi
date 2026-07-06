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

// bannerWorkspace is a minimal Workspace stub: the backend-exited View path
// only consults WorkingDir() (for the window title) before returning the
// banner, so nothing else needs implementing.
type bannerWorkspace struct {
	workspace.Workspace
}

func (*bannerWorkspace) WorkingDir() string { return "/tmp/banner-test" }
