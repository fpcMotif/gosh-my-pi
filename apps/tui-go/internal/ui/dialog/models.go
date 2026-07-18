package dialog

import (
	"cmp"
	"fmt"
	"slices"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/util"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

// ModelType represents the type of model to select.
type ModelType int

const (
	ModelTypeLarge ModelType = iota
	ModelTypeSmall
)

// String returns the string representation of the [ModelType].
func (mt ModelType) String() string {
	switch mt {
	case ModelTypeLarge:
		return "Large Task"
	case ModelTypeSmall:
		return "Small Task"
	default:
		return "Unknown"
	}
}

// Config returns the corresponding config model type.
func (mt ModelType) Config() config.SelectedModelType {
	switch mt {
	case ModelTypeLarge:
		return config.SelectedModelTypeLarge
	case ModelTypeSmall:
		return config.SelectedModelTypeSmall
	default:
		return ""
	}
}

// Placeholder returns the input placeholder for the model type.
func (mt ModelType) Placeholder() string {
	switch mt {
	case ModelTypeLarge:
		return largeModelInputPlaceholder
	case ModelTypeSmall:
		return smallModelInputPlaceholder
	default:
		return ""
	}
}

const (
	onboardingModelInputPlaceholder = "Find your fave"
	largeModelInputPlaceholder      = "Choose a model for large, complex tasks"
	smallModelInputPlaceholder      = "Choose a model for small, simple tasks"
)

// ModelsID is the identifier for the model selection dialog.
const ModelsID = "models"

const defaultModelsDialogMaxWidth = 73

// Models represents a model selection dialog.
type Models struct {
	com          *common.Common
	isOnboarding bool

	modelType ModelType
	catalog   workspace.ModelCatalog

	keyMap struct {
		Tab      key.Binding
		UpDown   key.Binding
		Select   key.Binding
		Edit     key.Binding
		Next     key.Binding
		Previous key.Binding
		Close    key.Binding
	}
	list  *ModelsList
	input textinput.Model
	help  help.Model
}

var _ Dialog = (*Models)(nil)

// NewModels creates a new Models dialog.
func NewModels(com *common.Common, catalog workspace.ModelCatalog, isOnboarding bool) (*Models, error) {
	t := com.Styles
	m := &Models{}
	m.com = com
	m.catalog = catalog
	m.isOnboarding = isOnboarding

	help := help.New()
	help.Styles = t.DialogHelpStyles()

	m.help = help
	m.list = NewModelsList(t)
	m.list.Focus()
	m.list.SetSelected(0)

	m.input = textinput.New()
	m.input.SetVirtualCursor(false)
	m.input.Placeholder = onboardingModelInputPlaceholder
	m.input.SetStyles(com.Styles.TextInput)
	m.input.Focus()

	m.keyMap.Tab = key.NewBinding(
		key.WithKeys("tab", "shift+tab"),
		key.WithHelp("tab", "toggle type"),
	)
	m.keyMap.Select = key.NewBinding(
		key.WithKeys("enter", "ctrl+y"),
		key.WithHelp("enter", "confirm"),
	)
	m.keyMap.Edit = key.NewBinding(
		key.WithKeys("ctrl+e"),
		key.WithHelp("ctrl+e", "edit"),
	)
	m.keyMap.UpDown = key.NewBinding(
		key.WithKeys("up", "down"),
		key.WithHelp("↑/↓", "choose"),
	)
	m.keyMap.Next = key.NewBinding(
		key.WithKeys("down", "ctrl+n"),
		key.WithHelp("↓", "next item"),
	)
	m.keyMap.Previous = key.NewBinding(
		key.WithKeys("up", "ctrl+p"),
		key.WithHelp("↑", "previous item"),
	)
	m.keyMap.Close = CloseKey

	if err := m.setProviderItems(); err != nil {
		return nil, fmt.Errorf("failed to set provider items: %w", err)
	}

	return m, nil
}

// ID implements Dialog.
func (m *Models) ID() string {
	return ModelsID
}

// HandleMsg implements Dialog.
func (m *Models) HandleMsg(msg tea.Msg) Action {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		switch {
		case key.Matches(msg, m.keyMap.Close):
			return ActionClose{}
		case key.Matches(msg, m.keyMap.Previous):
			m.list.Focus()
			if m.list.IsSelectedFirst() {
				m.list.SelectLast()
			} else {
				m.list.SelectPrev()
			}
			m.list.ScrollToSelected()
		case key.Matches(msg, m.keyMap.Next):
			m.list.Focus()
			if m.list.IsSelectedLast() {
				m.list.SelectFirst()
			} else {
				m.list.SelectNext()
			}
			m.list.ScrollToSelected()
		case key.Matches(msg, m.keyMap.Select, m.keyMap.Edit):
			selectedItem := m.list.SelectedItem()
			if selectedItem == nil {
				break
			}

			modelItem, ok := selectedItem.(*ModelItem)
			if !ok {
				break
			}

			isEdit := key.Matches(msg, m.keyMap.Edit)

			return ActionSelectModel{
				Provider:       modelItem.prov,
				Model:          modelItem.SelectedModel(),
				ModelType:      modelItem.SelectedModelType(),
				ReAuthenticate: isEdit,
			}
		case key.Matches(msg, m.keyMap.Tab):
			if m.isOnboarding {
				break
			}
			if m.modelType == ModelTypeLarge {
				m.modelType = ModelTypeSmall
			} else {
				m.modelType = ModelTypeLarge
			}
			if err := m.setProviderItems(); err != nil {
				return util.ReportError(err)
			}
		default:
			var cmd tea.Cmd
			m.input, cmd = m.input.Update(msg)
			value := m.input.Value()
			m.list.Focus()
			m.list.SetFilter(value)
			m.list.SelectFirst()
			m.list.ScrollToTop()
			return ActionCmd{cmd}
		}
	}
	return nil
}

// Cursor returns the cursor for the dialog.
func (m *Models) Cursor() *tea.Cursor {
	return InputCursor(m.com.Styles, m.input.Cursor())
}

// modelTypeRadioView returns the radio view for model type selection.
func (m *Models) modelTypeRadioView() string {
	t := m.com.Styles
	textStyle := t.Radio.Label
	largeRadioStyle := t.Radio.Off
	smallRadioStyle := t.Radio.Off
	if m.modelType == ModelTypeLarge {
		largeRadioStyle = t.Radio.On
	} else {
		smallRadioStyle = t.Radio.On
	}

	largeRadio := largeRadioStyle.Padding(0, 1).Render()
	smallRadio := smallRadioStyle.Padding(0, 1).Render()

	return fmt.Sprintf("%s%s  %s%s",
		largeRadio, textStyle.Render(ModelTypeLarge.String()),
		smallRadio, textStyle.Render(ModelTypeSmall.String()))
}

// Draw implements [Dialog].
func (m *Models) Draw(scr uv.Screen, area uv.Rectangle) *tea.Cursor {
	t := m.com.Styles
	width := max(0, min(defaultModelsDialogMaxWidth, area.Dx()-t.Dialog.View.GetHorizontalBorderSize()))
	height := max(0, min(defaultDialogHeight, area.Dy()-t.Dialog.View.GetVerticalBorderSize()))
	innerWidth := width - t.Dialog.View.GetHorizontalFrameSize()
	heightOffset := t.Dialog.Title.GetVerticalFrameSize() + titleContentHeight +
		t.Dialog.InputPrompt.GetVerticalFrameSize() + inputContentHeight +
		t.Dialog.HelpView.GetVerticalFrameSize() +
		t.Dialog.View.GetVerticalFrameSize()

	m.input.SetWidth(max(0, innerWidth-t.Dialog.InputPrompt.GetHorizontalFrameSize()-1)) // (1) cursor padding
	m.list.SetSize(innerWidth, height-heightOffset)
	m.help.SetWidth(innerWidth)

	rc := NewRenderContext(t, width)
	rc.Title = "Switch Model"
	rc.TitleInfo = m.modelTypeRadioView()

	if m.isOnboarding {
		titleText := t.Dialog.PrimaryText.Render("To start, let's choose a provider and model.")
		rc.AddPart(titleText)
	}

	inputView := t.Dialog.InputPrompt.Render(m.input.View())
	rc.AddPart(inputView)

	listView := t.Dialog.List.Height(m.list.Height()).Render(m.list.Render())
	rc.AddPart(listView)

	rc.Help = m.help.View(m)

	cur := m.Cursor()

	if m.isOnboarding {
		rc.Title = ""
		rc.TitleInfo = ""
		rc.IsOnboarding = true
		view := rc.Render()
		cur = adjustOnboardingInputCursor(t, cur)
		DrawOnboardingCursor(scr, area, view, cur)
	} else {
		view := rc.Render()
		DrawCenterCursor(scr, area, view, cur)
	}
	return cur
}

// ShortHelp returns the short help view.
func (m *Models) ShortHelp() []key.Binding {
	if m.isOnboarding {
		return []key.Binding{
			m.keyMap.UpDown,
			m.keyMap.Select,
		}
	}
	h := []key.Binding{
		m.keyMap.UpDown,
		m.keyMap.Tab,
		m.keyMap.Select,
	}
	if m.isSelectedConfigured() {
		h = append(h, m.keyMap.Edit)
	}
	h = append(h, m.keyMap.Close)
	return h
}

// FullHelp returns the full help view.
func (m *Models) FullHelp() [][]key.Binding {
	return [][]key.Binding{m.ShortHelp()}
}

func (m *Models) isSelectedConfigured() bool {
	selectedItem := m.list.SelectedItem()
	if selectedItem == nil {
		return false
	}
	modelItem, ok := selectedItem.(*ModelItem)
	if !ok {
		return false
	}
	entry, ok := m.catalogEntry(modelItem.SelectedModel())
	return ok && entry.Authenticated && entry.LoginAvailable
}

// setProviderItems adapts the backend-owned catalog for the inherited list.
// It does not consult the local provider catalog: that catalog belongs to the
// legacy Catwalk path, not the RPC backend.
func (m *Models) setProviderItems() error {
	t := m.com.Styles
	cfg := m.com.Config()

	var selectedItemID string
	selectedType := m.modelType.Config()
	currentModel, hasCurrentModel := m.roleSelection(modelRole(m.modelType))
	recentItems := cfg.RecentModels[selectedType]

	itemsMap := make(map[string]*ModelItem)
	providerEntries := make(map[string][]workspace.ModelCatalogEntry)
	providerNames := make(map[string]string)
	for _, entry := range m.catalog.Models {
		if entry.Provider == "" || entry.ID == "" {
			continue
		}
		providerEntries[entry.Provider] = append(providerEntries[entry.Provider], entry)
		providerNames[entry.Provider] = cmp.Or(entry.ProviderName, entry.Provider)
	}

	providerIDs := make([]string, 0, len(providerEntries))
	for providerID := range providerEntries {
		providerIDs = append(providerIDs, providerID)
	}
	slices.SortFunc(providerIDs, func(a, b string) int {
		if order := cmp.Compare(providerNames[a], providerNames[b]); order != 0 {
			return order
		}
		return cmp.Compare(a, b)
	})

	groups := make([]ModelGroup, 0, len(providerIDs))
	for _, providerID := range providerIDs {
		entries := providerEntries[providerID]
		slices.SortFunc(entries, func(a, b workspace.ModelCatalogEntry) int {
			if order := cmp.Compare(cmp.Or(a.Name, a.ID), cmp.Or(b.Name, b.ID)); order != 0 {
				return order
			}
			return cmp.Compare(a.ID, b.ID)
		})

		provider := catwalk.Provider{ID: catwalk.InferenceProvider(providerID), Name: providerNames[providerID]}
		configured := false
		group := NewModelGroup(t, providerNames[providerID], false)
		for _, entry := range entries {
			configured = configured || entry.Authenticated
			model := catwalk.Model{
				ID:               entry.ID,
				Name:             displayCatalogModelName(entry),
				ContextWindow:    entry.ContextWindow,
				DefaultMaxTokens: entry.MaxTokens,
				CanReason:        entry.Reasoning,
				SupportsImages:   entry.SupportsImages,
			}
			item := NewModelItem(t, provider, model, m.modelType, false)
			group.AppendItems(item)
			itemsMap[item.ID()] = item
			if hasCurrentModel && item.ID() == modelKey(currentModel.Provider, currentModel.Model) {
				selectedItemID = item.ID()
			}
		}
		group.configured = configured
		groups = append(groups, group)
	}

	if len(recentItems) > 0 {
		recentGroup := NewModelGroup(t, "Recently used", false)

		for _, recent := range recentItems {
			key := modelKey(recent.Provider, recent.Model)
			item, ok := itemsMap[key]
			if !ok {
				continue
			}

			// Show provider for recent items
			item = NewModelItem(t, item.prov, item.model, m.modelType, true)
			item.showProvider = true

			recentGroup.AppendItems(item)
			if recent.Model == currentModel.Model && recent.Provider == currentModel.Provider {
				selectedItemID = item.ID()
			}
		}

		if len(recentGroup.Items) > 0 {
			groups = append([]ModelGroup{recentGroup}, groups...)
		}
	}

	// Set model groups in the list.
	m.list.SetGroups(groups...)
	m.list.SetSelectedItem(selectedItemID)
	m.list.ScrollToTop()

	// Update placeholder based on model type
	if !m.isOnboarding {
		m.input.Placeholder = m.modelType.Placeholder()
	}

	return nil
}

func modelRole(modelType ModelType) string {
	if modelType == ModelTypeSmall {
		return "smol"
	}
	return "default"
}

func (m *Models) roleSelection(role string) (config.SelectedModel, bool) {
	for _, assignment := range m.catalog.Roles {
		if assignment.Role == role && assignment.Provider != "" && assignment.ModelID != "" {
			return config.SelectedModel{Provider: assignment.Provider, Model: assignment.ModelID}, true
		}
	}
	return config.SelectedModel{}, false
}

func (m *Models) catalogEntry(model config.SelectedModel) (workspace.ModelCatalogEntry, bool) {
	for _, entry := range m.catalog.Models {
		if entry.Provider == model.Provider && entry.ID == model.Model {
			return entry, true
		}
	}
	return workspace.ModelCatalogEntry{}, false
}

func displayCatalogModelName(entry workspace.ModelCatalogEntry) string {
	name := cmp.Or(entry.Name, entry.ID)
	if entry.Available {
		return name
	}
	if entry.LoginAvailable {
		return name + " (login required)"
	}
	return name + " (unavailable)"
}

func modelKey(providerID, modelID string) string {
	if providerID == "" || modelID == "" {
		return ""
	}
	return providerID + ":" + modelID
}
