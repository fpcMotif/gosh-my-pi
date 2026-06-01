package model

import (
	"strings"
	"testing"

	"charm.land/bubbles/v2/key"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/dialog"
	"github.com/stretchr/testify/require"
)

// TestOpenDialog_SessionIDIsNoop asserts the in-TUI session picker (G15) is
// unreachable: routing the legacy "session" dialog id through openDialog opens
// no dialog. The picker only ever listed the single gmp session and could not
// switch; selection lives on the --session / --continue CLI flags instead.
func TestOpenDialog_SessionIDIsNoop(t *testing.T) {
	t.Parallel()

	m := &UI{dialog: dialog.NewOverlay()}

	cmd := m.openDialog("session")

	require.Nil(t, cmd, "opening the removed session dialog must produce no command")
	require.False(t, m.dialog.ContainsDialog("session"), "session picker must not open")
}

// TestDefaultKeyMap_NoSessionsBinding asserts the global keymap no longer binds
// a sessions shortcut after the picker was dropped. The Sessions field and its
// ctrl+s "sessions" binding were removed, so no global binding advertises a
// sessions shortcut.
func TestDefaultKeyMap_NoSessionsBinding(t *testing.T) {
	t.Parallel()

	km := DefaultKeyMap()

	globals := []key.Binding{km.Quit, km.Help, km.Commands, km.Models, km.Suspend, km.Tab}
	for _, b := range globals {
		require.NotEqual(t, "sessions", strings.ToLower(b.Help().Desc), "no global binding should advertise the sessions picker")
	}
}
