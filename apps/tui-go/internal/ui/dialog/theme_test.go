package dialog

import (
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	uistyles "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

func newTestTheme(t *testing.T, current string) *Theme {
	t.Helper()
	st := uistyles.CharmtonePantera()
	d, err := NewTheme(&common.Common{Styles: &st}, current)
	if err != nil {
		t.Fatalf("NewTheme: %v", err)
	}
	return d
}

func TestTheme_ListsAllAvailableThemes(t *testing.T) {
	t.Parallel()

	d := newTestTheme(t, "Charmtone Pantera")
	items := d.list.FilteredItems()

	want := uistyles.AvailableThemes()
	if len(items) != len(want) {
		t.Fatalf("listed %d themes, want %d", len(items), len(want))
	}
	for i, opt := range want {
		ti, ok := items[i].(*ThemeItem)
		if !ok {
			t.Fatalf("item %d is %T, want *ThemeItem", i, items[i])
		}
		if ti.name != opt.Name {
			t.Errorf("item %d name = %q, want %q", i, ti.name, opt.Name)
		}
	}
}

func TestTheme_PreselectsCurrentTheme(t *testing.T) {
	t.Parallel()

	const current = "Hypercrush Obsidiana"
	d := newTestTheme(t, current)

	sel, ok := d.list.SelectedItem().(*ThemeItem)
	if !ok {
		t.Fatalf("SelectedItem is %T, want *ThemeItem", d.list.SelectedItem())
	}
	if sel.name != current {
		t.Errorf("preselected %q, want %q", sel.name, current)
	}
	if !sel.isCurrent {
		t.Errorf("preselected item not marked current")
	}
}

func TestTheme_SelectEmitsActionSelectTheme(t *testing.T) {
	t.Parallel()

	d := newTestTheme(t, "Charmtone Pantera")
	// Move to the second theme so the selection differs from the current one.
	d.HandleMsg(tea.KeyPressMsg(tea.Key{Code: tea.KeyDown}))

	action := d.HandleMsg(tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}))
	sel, ok := action.(ActionSelectTheme)
	if !ok {
		t.Fatalf("Enter produced %T, want ActionSelectTheme", action)
	}

	options := uistyles.AvailableThemes()
	if len(options) < 2 {
		t.Skip("need at least two themes to test selection movement")
	}
	if sel.Name != options[1].Name {
		t.Errorf("selected %q, want %q", sel.Name, options[1].Name)
	}
	// The selected theme must resolve to a real theme via the apply path.
	if _, known := uistyles.ThemeByName(sel.Name); !known {
		t.Errorf("ActionSelectTheme name %q is not a known theme", sel.Name)
	}
}

func TestTheme_CloseEmitsActionClose(t *testing.T) {
	t.Parallel()

	d := newTestTheme(t, "Charmtone Pantera")
	action := d.HandleMsg(tea.KeyPressMsg(tea.Key{Code: tea.KeyEsc}))
	if _, ok := action.(ActionClose); !ok {
		t.Fatalf("Esc produced %T, want ActionClose", action)
	}
}
