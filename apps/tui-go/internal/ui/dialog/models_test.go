package dialog

import (
	"testing"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

// modelsTestWorkspace is the minimum Workspace stub the picker needs.
// We embed the interface so unimplemented methods panic loudly if a
// future test path reaches them — exposing untested code paths instead
// of silently returning zero values.
type modelsTestWorkspace struct {
	workspace.Workspace
	cfg     *config.Config
	gmpMode bool
}

func (w *modelsTestWorkspace) Config() *config.Config { return w.cfg }
func (w *modelsTestWorkspace) IsGmpMode() bool        { return w.gmpMode }

// gmpModeCfg mirrors the Bridge Model Catalog shape GmpWorkspace builds
// from backend models.catalog: real backend providers, not the synthetic
// gmp/gmp-backend placeholder.
func gmpModeCfg(t *testing.T) *config.Config {
	t.Helper()
	progress := true
	providers := csync.NewMap[string, config.ProviderConfig]()
	providers.Set("chatgpt-sub", config.ProviderConfig{
		ID:     "chatgpt-sub",
		Name:   "ChatGPT subscription",
		Type:   catwalk.TypeOpenAI,
		APIKey: "gmp-authenticated",
		Models: []catwalk.Model{
			{ID: "gpt-5.5", Name: "GPT-5.5"},
		},
	})
	providers.Set("openai-codex", config.ProviderConfig{
		ID:   "openai-codex",
		Name: "OpenAI Codex",
		Type: catwalk.TypeOpenAI,
		Models: []catwalk.Model{
			{ID: "gpt-5.3-codex-spark", Name: "gpt-5.3-codex-spark (login required)"},
		},
	})
	return &config.Config{
		Models: map[config.SelectedModelType]config.SelectedModel{
			config.SelectedModelTypeLarge: {Provider: "chatgpt-sub", Model: "gpt-5.5"},
			config.SelectedModelTypeSmall: {Provider: "openai-codex", Model: "gpt-5.3-codex-spark"},
		},
		RecentModels: make(map[config.SelectedModelType][]config.SelectedModel),
		Providers:    providers,
		Options: &config.Options{
			ContextPaths:              []string{},
			DataDirectory:             ".omp",
			Progress:                  &progress,
			TUI:                       &config.TUIOptions{},
			DisableDefaultProviders:   true,
			DisableProviderAutoUpdate: true,
		},
		Permissions: &config.Permissions{},
	}
}

func newTestModels(t *testing.T, ws workspace.Workspace) *Models {
	t.Helper()
	st := uistyles.CharmtonePantera()
	com := &common.Common{Workspace: ws, Styles: &st}
	m, err := NewModels(com, false)
	if err != nil {
		t.Fatalf("NewModels failed: %v", err)
	}
	return m
}

// TestModels_GmpModeShowsBridgeCatalogProviders guards the bridge
// contract: in gmp mode the picker renders the backend catalog snapshot
// already installed in cfg.Providers, rather than collapsing everything
// back to the legacy synthetic gmp/gmp-backend placeholder.
func TestModels_GmpModeShowsBridgeCatalogProviders(t *testing.T) {
	t.Parallel()

	cfg := gmpModeCfg(t)
	ws := &modelsTestWorkspace{cfg: cfg, gmpMode: true}
	m := newTestModels(t, ws)

	groups := m.list.Groups()
	titles := groupTitles(groups)
	if !containsTitle(titles, "ChatGPT subscription") || !containsTitle(titles, "OpenAI Codex") {
		t.Fatalf("group titles = %v, want backend providers", titles)
	}
	for _, group := range groups {
		for _, item := range group.Items {
			if item.model.ID == "gmp-backend" {
				t.Fatalf("picker leaked synthetic model: %#v", item.model)
			}
		}
	}
}

// TestModels_NonGmpModeKeepsCustomProviders guards the non-gmp branch:
// vanilla Crush users with custom providers (e.g. chatgpt-sub via a
// localhost openai-compat) and DisableDefaultProviders=true must still
// see their entries. Regression target: the gmp-mode filter must not
// leak into non-gmp installs.
func TestModels_NonGmpModeKeepsCustomProviders(t *testing.T) {
	t.Parallel()

	progress := true
	providers := csync.NewMap[string, config.ProviderConfig]()
	providers.Set("chatgpt-sub", config.ProviderConfig{
		ID:   "chatgpt-sub",
		Name: "ChatGPT subscription via local Codex proxy",
		Type: catwalk.TypeOpenAI,
		Models: []catwalk.Model{
			{ID: "gpt-5.5", Name: "GPT-5.5"},
		},
	})
	cfg := &config.Config{
		Models: map[config.SelectedModelType]config.SelectedModel{
			config.SelectedModelTypeLarge: {Provider: "chatgpt-sub", Model: "gpt-5.5"},
		},
		RecentModels: make(map[config.SelectedModelType][]config.SelectedModel),
		Providers:    providers,
		Options: &config.Options{
			Progress:                  &progress,
			TUI:                       &config.TUIOptions{},
			DisableDefaultProviders:   true,
			DisableProviderAutoUpdate: true,
		},
		Permissions: &config.Permissions{},
	}
	ws := &modelsTestWorkspace{cfg: cfg, gmpMode: false}
	m := newTestModels(t, ws)

	groups := m.list.Groups()
	if len(groups) != 1 {
		t.Fatalf("groups len = %d, want 1; titles = %v",
			len(groups), groupTitles(groups))
	}
	if got := string(groups[0].Items[0].prov.ID); got != "chatgpt-sub" {
		t.Fatalf("item provider = %q, want %q", got, "chatgpt-sub")
	}
}

// TestModels_GmpVirtualProviderConstantMatchesWorkspace pins the
// hard-coded id in the dialog package to the canonical workspace
// constant. We intentionally don't import workspace at runtime to
// avoid a back-reference; this test is the integrity check that keeps
// the two in sync.
func TestModels_GmpVirtualProviderConstantMatchesWorkspace(t *testing.T) {
	t.Parallel()
	if gmpVirtualProviderID != workspace.GmpProviderID {
		t.Fatalf("gmpVirtualProviderID = %q, workspace.GmpProviderID = %q",
			gmpVirtualProviderID, workspace.GmpProviderID)
	}
}

func groupTitles(groups []ModelGroup) []string {
	out := make([]string, len(groups))
	for i, g := range groups {
		out[i] = g.Title
	}
	return out
}

func containsTitle(titles []string, want string) bool {
	for _, title := range titles {
		if title == want {
			return true
		}
	}
	return false
}
