package model

import (
	"strings"
	"testing"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/charmbracelet/x/ansi"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

type headerTestWorkspace struct {
	workspace.Workspace
	model workspace.AgentModel
}

func (w *headerTestWorkspace) AgentIsReady() bool { return false }

func (w *headerTestWorkspace) AgentModel() workspace.AgentModel { return w.model }

func (w *headerTestWorkspace) WorkingDir() string { return "/tmp/project" }

func TestRenderHeaderDetailsUsesAgentModelContextWindow(t *testing.T) {
	t.Parallel()

	style := styles.ThemeForProvider("")
	com := &common.Common{
		Workspace: &headerTestWorkspace{model: workspace.AgentModel{
			CatwalkCfg: catwalk.Model{ContextWindow: 200},
		}},
		Styles: &style,
	}
	sess := &session.Session{PromptTokens: 80, CompletionTokens: 20}

	got := ansi.Strip(renderHeaderDetails(com, sess, 0, false, 120, nil))
	require.Contains(t, got, "50%")
}

func TestRenderHeaderDetailsOmitsUsageWithoutContextWindow(t *testing.T) {
	t.Parallel()

	style := styles.ThemeForProvider("")
	com := &common.Common{
		Workspace: &headerTestWorkspace{},
		Styles:    &style,
	}
	sess := &session.Session{PromptTokens: 80, CompletionTokens: 20}

	got := ansi.Strip(renderHeaderDetails(com, sess, 0, false, 120, nil))
	require.False(t, strings.Contains(got, "%"))
}
