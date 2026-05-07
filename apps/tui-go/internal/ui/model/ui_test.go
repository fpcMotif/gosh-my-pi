package model

import (
	"testing"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/dialog"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

func TestCurrentModelSupportsImages(t *testing.T) {
	t.Parallel()

	t.Run("returns false when config is nil", func(t *testing.T) {
		t.Parallel()

		ui := newTestUIWithConfig(t, nil)
		require.False(t, ui.currentModelSupportsImages())
	})

	t.Run("returns false when coder agent is missing", func(t *testing.T) {
		t.Parallel()

		cfg := &config.Config{
			Providers: csync.NewMap[string, config.ProviderConfig](),
			Agents:    map[string]config.Agent{},
		}
		ui := newTestUIWithConfig(t, cfg)
		require.False(t, ui.currentModelSupportsImages())
	})

	t.Run("returns false when model is not found", func(t *testing.T) {
		t.Parallel()

		cfg := &config.Config{
			Providers: csync.NewMap[string, config.ProviderConfig](),
			Agents: map[string]config.Agent{
				config.AgentCoder: {Model: config.SelectedModelTypeLarge},
			},
		}
		ui := newTestUIWithConfig(t, cfg)
		require.False(t, ui.currentModelSupportsImages())
	})

	t.Run("returns true when current model supports images", func(t *testing.T) {
		t.Parallel()

		providers := csync.NewMap[string, config.ProviderConfig]()
		providers.Set("test-provider", config.ProviderConfig{
			ID: "test-provider",
			Models: []catwalk.Model{
				{ID: "test-model", SupportsImages: true},
			},
		})

		cfg := &config.Config{
			Models: map[config.SelectedModelType]config.SelectedModel{
				config.SelectedModelTypeLarge: {
					Provider: "test-provider",
					Model:    "test-model",
				},
			},
			Providers: providers,
			Agents: map[string]config.Agent{
				config.AgentCoder: {Model: config.SelectedModelTypeLarge},
			},
		}

		ui := newTestUIWithConfig(t, cfg)
		require.True(t, ui.currentModelSupportsImages())
	})
}

func TestEditorSendMessageMatchesReturnKeyEncodings(t *testing.T) {
	t.Parallel()

	keyMap := DefaultKeyMap()
	messages := []tea.KeyPressMsg{
		tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}),
		tea.KeyPressMsg(tea.Key{Code: 'm', Mod: tea.ModCtrl}),
	}

	for _, msg := range messages {
		require.True(t, key.Matches(msg, keyMap.Editor.SendMessage), "expected %q to send message", msg.String())
		require.False(t, key.Matches(msg, keyMap.Editor.Newline), "expected %q not to insert newline", msg.String())
	}
}

func TestEditorCtrlMSubmitsPrompt(t *testing.T) {
	providers := csync.NewMap[string, config.ProviderConfig]()
	providers.Set("test-provider", config.ProviderConfig{ID: "test-provider"})
	cfg := &config.Config{
		Providers: providers,
		Options: &config.Options{
			TUI: &config.TUIOptions{},
		},
	}

	ui := New(common.DefaultCommon(&testWorkspace{cfg: cfg}), "", false)
	ui.textarea.SetValue("quit")

	cmd := ui.handleKeyPressMsg(tea.KeyPressMsg(tea.Key{Code: 'm', Mod: tea.ModCtrl}))

	require.Nil(t, cmd)
	require.True(t, ui.dialog.ContainsDialog(dialog.QuitID))
	require.False(t, ui.dialog.ContainsDialog(dialog.ModelsID))
	require.Empty(t, ui.textarea.Value())
}

func newTestUIWithConfig(t *testing.T, cfg *config.Config) *UI {
	t.Helper()

	return &UI{
		com: &common.Common{
			Workspace: &testWorkspace{cfg: cfg},
		},
	}
}

// testWorkspace is a minimal [workspace.Workspace] stub for unit tests.
type testWorkspace struct {
	workspace.Workspace
	cfg *config.Config
	gmp bool
}

func (w *testWorkspace) Config() *config.Config {
	return w.cfg
}

func (w *testWorkspace) ProjectNeedsInitialization() (bool, error) {
	return false, nil
}

func (w *testWorkspace) IsGmpMode() bool { return w.gmp }

// TestOpenAuthenticationDialog_DispatchesGmpAuth asserts the
// gmp-only contract from ADR 0002: openAuthenticationDialog
// dispatches through runGmpAuthCommand → SendAuthCommand. The
// legacy Crush auth dialogs (NewAPIKeyInput / NewOAuthHyper /
// NewOAuthCopilot) and the non-gmp branch were deleted in
// carve-out Phase 1 lite — there is no path that opens them.
func TestOpenAuthenticationDialog_DispatchesGmpAuth(t *testing.T) {
	t.Parallel()

	providers := csync.NewMap[string, config.ProviderConfig]()
	cfg := &config.Config{
		Providers: providers,
		Options:   &config.Options{TUI: &config.TUIOptions{}},
	}

	ui := New(common.DefaultCommon(&testWorkspace{cfg: cfg, gmp: true}), "", false)

	// Pick a provider that historically routed to NewAPIKeyInput
	// (openai is not "hyper" / not catwalk.InferenceProviderCopilot).
	prov := catwalk.Provider{ID: "openai", Name: "OpenAI"}
	cmd := ui.openAuthenticationDialog(prov, config.SelectedModel{}, config.SelectedModelTypeLarge)

	require.NotNil(t, cmd, "openAuthenticationDialog should produce a gmp auth dispatch cmd")
	// GmpAuth dialog opens later, when the backend's first
	// extension_ui_request frame arrives — not synchronously here.
	require.False(t, ui.dialog.ContainsDialog(dialog.GmpAuthID), "GmpAuth dialog should be opened by the inbound frame, not the dispatch")
}
