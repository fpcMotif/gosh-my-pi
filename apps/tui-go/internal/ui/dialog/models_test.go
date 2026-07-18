package dialog

import (
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

// modelsTestWorkspace supplies only the local UI state the picker retains.
// Catalog truth arrives separately as a ModelCatalog snapshot.
type modelsTestWorkspace struct {
	workspace.Workspace
	cfg *config.Config
}

func (w *modelsTestWorkspace) Config() *config.Config { return w.cfg }

func newTestModels(t *testing.T, catalog workspace.ModelCatalog) *Models {
	t.Helper()
	styles := uistyles.CharmtonePantera()
	ws := &modelsTestWorkspace{cfg: &config.Config{
		Models:       make(map[config.SelectedModelType]config.SelectedModel),
		RecentModels: make(map[config.SelectedModelType][]config.SelectedModel),
	}}
	m, err := NewModels(&common.Common{Workspace: ws, Styles: &styles}, catalog, false)
	if err != nil {
		t.Fatalf("NewModels failed: %v", err)
	}
	return m
}

func testCatalog() workspace.ModelCatalog {
	return workspace.ModelCatalog{
		Models: []workspace.ModelCatalogEntry{
			{
				Provider:       "chatgpt-sub",
				ProviderName:   "ChatGPT subscription",
				ID:             "gpt-5.5",
				Name:           "GPT-5.5",
				Available:      true,
				Authenticated:  true,
				LoginAvailable: true,
			},
			{
				Provider:       "openai-codex",
				ProviderName:   "OpenAI Codex",
				ID:             "gpt-5.3-codex-spark",
				Name:           "GPT-5.3 Codex Spark",
				Available:      false,
				LoginAvailable: true,
			},
		},
		Roles: []workspace.ModelCatalogRole{
			{Role: "default", Provider: "chatgpt-sub", ModelID: "gpt-5.5"},
			{Role: "smol", Provider: "openai-codex", ModelID: "gpt-5.3-codex-spark"},
		},
	}
}

func TestModels_RendersDirectCatalogGroups(t *testing.T) {
	t.Parallel()

	m := newTestModels(t, testCatalog())
	titles := groupTitles(m.list.Groups())
	if !containsTitle(titles, "ChatGPT subscription") || !containsTitle(titles, "OpenAI Codex") {
		t.Fatalf("group titles = %v, want direct catalog providers", titles)
	}
	for _, group := range m.list.Groups() {
		for _, item := range group.Items {
			if item.model.ID == "gmp-backend" {
				t.Fatalf("picker rendered synthetic model: %#v", item.model)
			}
		}
	}
}

func TestModels_UsesTopLevelRolesForSelection(t *testing.T) {
	t.Parallel()

	m := newTestModels(t, testCatalog())
	assertSelectedModel(t, m, "chatgpt-sub", "gpt-5.5", config.SelectedModelTypeLarge)

	m.modelType = ModelTypeSmall
	if err := m.setProviderItems(); err != nil {
		t.Fatalf("setProviderItems failed: %v", err)
	}
	assertSelectedModel(t, m, "openai-codex", "gpt-5.3-codex-spark", config.SelectedModelTypeSmall)
}

func TestModels_CurrentDoesNotReplaceMissingDefaultRole(t *testing.T) {
	t.Parallel()

	catalog := testCatalog()
	catalog.Roles = nil
	catalog.Current = &workspace.ModelCatalogModel{Provider: "openai-codex", ID: "gpt-5.3-codex-spark"}
	m := newTestModels(t, catalog)

	if _, ok := m.roleSelection("default"); ok {
		t.Fatal("default role was inferred from current")
	}
}

func TestModels_LabelsUnavailableAndGatesReauthentication(t *testing.T) {
	t.Parallel()

	m := newTestModels(t, testCatalog())
	item := findModelItem(t, m.list.Groups(), "openai-codex", "gpt-5.3-codex-spark")
	if item.model.Name != "GPT-5.3 Codex Spark (login required)" {
		t.Fatalf("model label = %q", item.model.Name)
	}
	m.list.SetSelectedItem(item.ID())
	if m.isSelectedConfigured() {
		t.Fatal("unauthenticated model offered reauthentication")
	}

	item = findModelItem(t, m.list.Groups(), "chatgpt-sub", "gpt-5.5")
	m.list.SetSelectedItem(item.ID())
	if !m.isSelectedConfigured() {
		t.Fatal("authenticated model with login support hid reauthentication")
	}
}

func TestModels_EmitsCatalogRoleSelection(t *testing.T) {
	t.Parallel()

	m := newTestModels(t, testCatalog())
	action, ok := m.HandleMsg(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter})).(ActionSelectModel)
	if !ok {
		t.Fatalf("action = %T, want ActionSelectModel", action)
	}
	if action.Provider.ID != "chatgpt-sub" || action.Model.Model != "gpt-5.5" || action.ModelType != config.SelectedModelTypeLarge {
		t.Fatalf("selection = %#v", action)
	}
}

func assertSelectedModel(t *testing.T, m *Models, provider, model string, modelType config.SelectedModelType) {
	t.Helper()
	selected, ok := m.list.SelectedItem().(*ModelItem)
	if !ok {
		t.Fatalf("selected item = %T, want ModelItem", m.list.SelectedItem())
	}
	got := selected.SelectedModel()
	if got.Provider != provider || got.Model != model || selected.SelectedModelType() != modelType {
		t.Fatalf("selected = %#v, type = %q", got, selected.SelectedModelType())
	}
}

func findModelItem(t *testing.T, groups []ModelGroup, provider, model string) *ModelItem {
	t.Helper()
	for _, group := range groups {
		for _, item := range group.Items {
			if string(item.prov.ID) == provider && item.model.ID == model {
				return item
			}
		}
	}
	t.Fatalf("model %s/%s not found", provider, model)
	return nil
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
