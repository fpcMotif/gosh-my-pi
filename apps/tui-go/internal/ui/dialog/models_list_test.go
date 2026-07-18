package dialog

import (
	"testing"

	"charm.land/catwalk/pkg/catwalk"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

func TestModelsList_SetSelectedItemTargetsModelAcrossGroups(t *testing.T) {
	t.Parallel()

	styles := uistyles.CharmtonePantera()
	first := testModelItem(&styles, "provider-a", "model-a", ModelTypeLarge)
	second := testModelItem(&styles, "provider-a", "model-b", ModelTypeLarge)
	target := testModelItem(&styles, "provider-b", "model-c", ModelTypeSmall)
	list := NewModelsList(
		&styles,
		NewModelGroup(&styles, "Provider A", false, first, second),
		NewModelGroup(&styles, "Provider B", false, target),
	)
	list.SetGroups(list.Groups()...)

	list.SetSelectedItem(target.ID())

	selected, ok := list.SelectedItem().(*ModelItem)
	if !ok {
		t.Fatalf("selected item = %T, want *ModelItem", list.SelectedItem())
	}
	if selected != target {
		t.Fatalf("selected item = %q, want target %q", selected.ID(), target.ID())
	}
	got := selected.SelectedModel()
	if got.Provider != "provider-b" || got.Model != "model-c" || selected.SelectedModelType() != ModelTypeSmall.Config() {
		t.Fatalf("selected action target = %#v, type = %q", got, selected.SelectedModelType())
	}
}

func testModelItem(styles *uistyles.Styles, providerID, modelID string, modelType ModelType) *ModelItem {
	return NewModelItem(
		styles,
		catwalk.Provider{ID: catwalk.InferenceProvider(providerID)},
		catwalk.Model{ID: modelID, Name: modelID},
		modelType,
		false,
	)
}
