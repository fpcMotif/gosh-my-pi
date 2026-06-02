package model

import (
	"testing"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/stretchr/testify/require"
)

// landingWorkspace is a minimal workspace stub that satisfies the calls made
// by landingView (AgentIsReady / WorkingDir / Config). The embedded interface
// supplies the rest; none of the remaining methods are reached on this path.
type landingWorkspace struct {
	*testWorkspace
}

func (w *landingWorkspace) AgentIsReady() bool { return false }
func (w *landingWorkspace) WorkingDir() string { return "/tmp/landing" }

// TestLandingView_OmitsLSPSection asserts that after the dead LSP sidebar
// section was dropped (G10), the landing view renders the MCP and Skills
// sections but no "LSPs" heading. The LSP section always read the in-process
// Crush global, which the gmp bridge never populates, so it was always empty.
func TestLandingView_OmitsLSPSection(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{Options: &config.Options{}}
	ws := &landingWorkspace{testWorkspace: &testWorkspace{cfg: cfg}}
	st := common.DefaultCommon(ws).Styles

	m := &UI{com: &common.Common{Workspace: ws, Styles: st}}
	m.layout.main = uv.Rect(0, 0, 120, 40)

	out := ansi.Strip(m.landingView())

	require.NotContains(t, out, "LSPs", "landing view must not render the dead LSP section")
	require.Contains(t, out, "MCPs", "landing view must still render the MCP section")
	require.Contains(t, out, "Skills", "landing view must still render the Skills section")
}

// TestGetDynamicHeightLimits_NoLSPBudget asserts the sidebar height budgeter
// allocates across exactly three sections (files / MCP / skills) after the LSP
// section was dropped. With abundant height every requested item fits, so each
// section's cap equals its requested count — proving no slice of the budget is
// silently diverted to a removed LSP section. The 3-value return signature
// (compile-time) is itself part of the post-G10 contract.
func TestGetDynamicHeightLimits_NoLSPBudget(t *testing.T) {
	t.Parallel()

	const (
		fileCount  = 3
		mcpCount   = 4
		skillCount = 5
	)

	maxFiles, maxMCPs, maxSkills := getDynamicHeightLimits(200, fileCount, mcpCount, skillCount)

	require.GreaterOrEqual(t, maxFiles, fileCount, "files section should fit all items with abundant height")
	require.GreaterOrEqual(t, maxMCPs, mcpCount, "mcp section should fit all items with abundant height")
	require.GreaterOrEqual(t, maxSkills, skillCount, "skills section should fit all items with abundant height")
}
