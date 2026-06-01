package styles

import "testing"

func TestAvailableThemes_DefaultFirst(t *testing.T) {
	t.Parallel()

	options := AvailableThemes()
	if len(options) < 2 {
		t.Fatalf("expected at least two themes, got %d", len(options))
	}
	if options[0].Name != "Charmtone Pantera" {
		t.Errorf("default theme = %q, want Charmtone Pantera", options[0].Name)
	}
	for _, opt := range options {
		if opt.Build == nil {
			t.Errorf("theme %q has nil Build", opt.Name)
		}
	}
}

func TestThemeByName_ResolvesDistinctThemes(t *testing.T) {
	t.Parallel()

	pantera, ok := ThemeByName("Charmtone Pantera")
	if !ok {
		t.Fatal("Charmtone Pantera not found")
	}
	hyper, ok := ThemeByName("Hypercrush Obsidiana")
	if !ok {
		t.Fatal("Hypercrush Obsidiana not found")
	}

	// The two themes differ in the keyword color, surfaced on the OAuth enter
	// style. Asserting the difference proves ThemeByName returns distinct
	// styles rather than the same default for both names.
	if pantera.Dialog.OAuth.Enter.GetForeground() == hyper.Dialog.OAuth.Enter.GetForeground() {
		t.Error("expected Pantera and Hyper themes to differ, got identical styles")
	}
}

func TestThemeByName_UnknownFallsBackToDefault(t *testing.T) {
	t.Parallel()

	got, ok := ThemeByName("does-not-exist")
	if ok {
		t.Error("unknown theme reported as known")
	}
	want := CharmtonePantera()
	if got.Dialog.OAuth.Enter.GetForeground() != want.Dialog.OAuth.Enter.GetForeground() {
		t.Error("unknown theme did not fall back to the default theme")
	}
}

func TestThemeNameForProvider_MatchesThemeForProvider(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"hyper":   "Hypercrush Obsidiana",
		"openai":  "Charmtone Pantera",
		"":        "Charmtone Pantera",
		"unknown": "Charmtone Pantera",
	}
	for provider, wantName := range cases {
		name := ThemeNameForProvider(provider)
		if name != wantName {
			t.Errorf("ThemeNameForProvider(%q) = %q, want %q", provider, name, wantName)
		}
		// The named theme must resolve to the same style ThemeForProvider picks.
		byName, _ := ThemeByName(name)
		byProvider := ThemeForProvider(provider)
		if byName.Dialog.OAuth.Enter.GetForeground() != byProvider.Dialog.OAuth.Enter.GetForeground() {
			t.Errorf("provider %q: name lookup and provider lookup disagree", provider)
		}
	}
}
