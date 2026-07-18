package common

import (
	"testing"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

func TestLargeModelProviderIDUsesAgentModel(t *testing.T) {
	t.Parallel()

	ws := &agentModelWorkspace{
		ready: true,
		model: workspace.AgentModel{ModelCfg: config.SelectedModel{Provider: "hyper"}},
	}
	require.Equal(t, "hyper", largeModelProviderID(ws))
}

func TestLargeModelProviderIDRequiresReadyAgent(t *testing.T) {
	t.Parallel()

	ws := &agentModelWorkspace{
		model: workspace.AgentModel{CatwalkCfg: catwalk.Model{ID: "ignored"}, ModelCfg: config.SelectedModel{Provider: "hyper"}},
	}
	require.Empty(t, largeModelProviderID(ws))
}

type agentModelWorkspace struct {
	workspace.Workspace
	ready bool
	model workspace.AgentModel
}

func (w *agentModelWorkspace) AgentIsReady() bool { return w.ready }

func (w *agentModelWorkspace) AgentModel() workspace.AgentModel { return w.model }
