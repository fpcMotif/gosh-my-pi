package dialog

import (
	"testing"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

type reasoningTestWorkspace struct {
	workspace.Workspace
	agentModel workspace.AgentModel
}

func (w *reasoningTestWorkspace) AgentModel() workspace.AgentModel { return w.agentModel }

func TestNewReasoning_UsesActiveModelMetadata(t *testing.T) {
	t.Parallel()

	st := uistyles.CharmtonePantera()
	dialog, err := NewReasoning(&common.Common{
		Styles: &st,
		Workspace: &reasoningTestWorkspace{agentModel: workspace.AgentModel{
			CatwalkCfg: catwalk.Model{
				ID:                     "gpt-5",
				ReasoningLevels:        []string{"low", "medium", "high"},
				DefaultReasoningEffort: "medium",
			},
			ModelCfg: config.SelectedModel{ReasoningEffort: "high"},
		}},
	})
	require.NoError(t, err)

	selected, ok := dialog.list.SelectedItem().(*ReasoningItem)
	require.True(t, ok)
	require.Equal(t, "high", selected.effort)
}

func TestNewReasoning_RejectsUnknownActiveModel(t *testing.T) {
	t.Parallel()

	st := uistyles.CharmtonePantera()
	_, err := NewReasoning(&common.Common{
		Styles:    &st,
		Workspace: &reasoningTestWorkspace{},
	})
	require.EqualError(t, err, "model configuration not found")
}
