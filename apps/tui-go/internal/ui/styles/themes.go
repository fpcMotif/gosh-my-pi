package styles

import "github.com/charmbracelet/x/exp/charmtone"

// ThemeForProvider returns the Styles associated with the given provider
// ID. Unknown or empty provider IDs yield the default Charmtone Pantera
// theme.
func ThemeForProvider(providerID string) Styles {
	switch providerID {
	case "hyper":
		return HypercrushObsidiana()
	default:
		return CharmtonePantera()
	}
}

// ThemeNameForProvider returns the display name of the theme associated with
// the given provider ID, matching the selection made by [ThemeForProvider].
func ThemeNameForProvider(providerID string) string {
	switch providerID {
	case "hyper":
		return "Hypercrush Obsidiana"
	default:
		return "Charmtone Pantera"
	}
}

// ThemeOption describes a user-selectable theme: a stable name used for
// lookups and a builder that produces the concrete [Styles].
type ThemeOption struct {
	Name  string
	Build func() Styles
}

// AvailableThemes returns the themes a user can select, in display order. The
// default (Charmtone Pantera) is listed first.
func AvailableThemes() []ThemeOption {
	return []ThemeOption{
		{Name: "Charmtone Pantera", Build: CharmtonePantera},
		{Name: "Hypercrush Obsidiana", Build: HypercrushObsidiana},
	}
}

// ThemeByName returns the [Styles] for the named theme and whether the name
// matched a known theme. Unknown names yield the default theme and false.
func ThemeByName(name string) (Styles, bool) {
	for _, opt := range AvailableThemes() {
		if opt.Name == name {
			return opt.Build(), true
		}
	}
	return CharmtonePantera(), false
}

// CharmtonePantera returns the Charmtone dark theme. It's the default style
// for the UI.
func CharmtonePantera() Styles {
	return quickStyle(quickStyleOpts{
		primary:   charmtone.Charple,
		secondary: charmtone.Dolly,
		accent:    charmtone.Bok,
		keyword:   charmtone.Blush,

		fgBase:       charmtone.Ash,
		fgMoreSubtle: charmtone.Squid,
		fgSubtle:     charmtone.Smoke,
		fgMostSubtle: charmtone.Oyster,

		onPrimary: charmtone.Butter,

		bgBase:         charmtone.Pepper,
		bgLeastVisible: charmtone.BBQ,
		bgLessVisible:  charmtone.Charcoal,
		bgMostVisible:  charmtone.Iron,

		separator: charmtone.Charcoal,

		destructive:       charmtone.Coral,
		error:             charmtone.Sriracha,
		warningSubtle:     charmtone.Zest,
		warning:           charmtone.Mustard,
		busy:              charmtone.Citron,
		info:              charmtone.Malibu,
		infoMoreSubtle:    charmtone.Sardine,
		infoMostSubtle:    charmtone.Damson,
		success:           charmtone.Julep,
		successMoreSubtle: charmtone.Bok,
		successMostSubtle: charmtone.Guac,
	})
}

// HypercrushObsidiana returns the Hypercrush dark theme.
func HypercrushObsidiana() Styles {
	return quickStyle(quickStyleOpts{
		primary:   charmtone.Charple,
		secondary: charmtone.Dolly,
		accent:    charmtone.Bok,

		fgBase:       charmtone.Ash,
		fgMoreSubtle: charmtone.Squid,
		fgSubtle:     charmtone.Smoke,
		fgMostSubtle: charmtone.Oyster,

		onPrimary: charmtone.Butter,

		bgBase:         charmtone.Pepper,
		bgLeastVisible: charmtone.BBQ,
		bgLessVisible:  charmtone.Charcoal,
		bgMostVisible:  charmtone.Iron,

		separator: charmtone.Charcoal,

		destructive:       charmtone.Coral,
		error:             charmtone.Sriracha,
		warningSubtle:     charmtone.Zest,
		warning:           charmtone.Mustard,
		busy:              charmtone.Citron,
		info:              charmtone.Malibu,
		infoMoreSubtle:    charmtone.Sardine,
		infoMostSubtle:    charmtone.Damson,
		success:           charmtone.Julep,
		successMoreSubtle: charmtone.Bok,
		successMostSubtle: charmtone.Guac,
	})
}
