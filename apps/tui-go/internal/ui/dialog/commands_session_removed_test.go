package dialog

import (
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

// commandsTestWorkspace supplies the config defaultCommands reads. The embedded
// interface panics if any other method is reached, keeping the path honest.
type commandsTestWorkspace struct {
	workspace.Workspace
	cfg *config.Config
}

func (w *commandsTestWorkspace) Config() *config.Config { return w.cfg }

// TestDefaultCommands_NoSessionSwitcher asserts the in-TUI session picker (G15)
// is unreachable from the command palette: the "switch_session"/"Sessions"
// entry that dispatched ActionOpenDialog{SessionsID} was removed because the
// gmp bridge only ever exposes the single current session. Session selection
// stays available via the --session / --continue CLI flags.
func TestDefaultCommands_NoSessionSwitcher(t *testing.T) {
	t.Parallel()

	st := uistyles.CharmtonePantera()
	ws := &commandsTestWorkspace{cfg: &config.Config{}}
	c := &Commands{com: &common.Common{Styles: &st, Workspace: ws}}

	items := c.defaultCommands()
	require.NotEmpty(t, items)

	for _, item := range items {
		require.NotEqual(t, "switch_session", item.ID(), "session picker command must be removed")
		require.NotEqual(t, "Sessions", item.title, "session picker command must be removed")
	}
}
