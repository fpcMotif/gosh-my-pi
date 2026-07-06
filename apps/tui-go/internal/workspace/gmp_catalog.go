package workspace

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// GmpModelCatalogEntry is the Go-side projection of the backend-owned
// models.catalog entry. It is intentionally provider/model centric:
// GmpWorkspace uses it to build the Bridge Model Catalog that the Crush
// picker renders, and the UI uses it to decide whether a selection needs
// GmpAuth before set_model can succeed.
type GmpModelCatalogEntry struct {
	Provider       string   `json:"provider"`
	ProviderName   string   `json:"providerName"`
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Available      bool     `json:"available"`
	Authenticated  bool     `json:"authenticated"`
	LoginSupported bool     `json:"loginSupported"`
	LoginAvailable bool     `json:"loginAvailable"`
	Current        bool     `json:"current"`
	Roles          []string `json:"roles"`
	ContextWindow  int64    `json:"contextWindow,omitempty"`
	MaxTokens      int64    `json:"maxTokens,omitempty"`
	Reasoning      bool     `json:"reasoning"`
	SupportsImages bool     `json:"supportsImages"`
}

func (e GmpModelCatalogEntry) key() string {
	return gmpModelCatalogKey(e.Provider, e.ID)
}

func gmpModelCatalogKey(providerID, modelID string) string {
	if providerID == "" || modelID == "" {
		return ""
	}
	return providerID + "/" + modelID
}

type gmpModelCatalogResponse struct {
	Models  []GmpModelCatalogEntry `json:"models"`
	Current *struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
		Name     string `json:"name"`
	} `json:"current,omitempty"`
}

// RefreshModelCatalog reloads the Bridge Model Catalog from the backend
// ModelRegistry/AuthStorage over RPC. In gmp mode this is the only model
// picker source of truth; the legacy Crush catalog is deliberately ignored.
func (w *GmpWorkspace) RefreshModelCatalog(ctx context.Context) error {
	if w.client == nil {
		return nil
	}
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "models.catalog"})
	if err != nil {
		return err
	}
	var catalog gmpModelCatalogResponse
	if err := json.Unmarshal(resp.Data, &catalog); err != nil {
		return fmt.Errorf("parse models.catalog response: %w", err)
	}
	w.mu.Lock()
	w.applyModelCatalogLocked(catalog)
	w.mu.Unlock()
	return nil
}

// ModelCatalogEntry returns the last refreshed backend catalog entry for
// provider/model. The UI consults this before set_model so unavailable
// entries can route through GmpAuth instead of the legacy API-key dialog.
func (w *GmpWorkspace) ModelCatalogEntry(providerID, modelID string) (GmpModelCatalogEntry, bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	entry, ok := w.modelCatalog[gmpModelCatalogKey(providerID, modelID)]
	return entry, ok
}

func (w *GmpWorkspace) applyModelCatalogLocked(catalog gmpModelCatalogResponse) {
	if w.modelCatalog == nil {
		w.modelCatalog = make(map[string]GmpModelCatalogEntry)
	} else {
		for key := range w.modelCatalog {
			delete(w.modelCatalog, key)
		}
	}

	providerModels := make(map[string][]catwalk.Model)
	providerNames := make(map[string]string)
	providerConfigured := make(map[string]bool)
	selectedByRole := make(map[string]config.SelectedModel)

	models := slices.Clone(catalog.Models)
	slices.SortFunc(models, func(a, b GmpModelCatalogEntry) int {
		if n := cmp.Compare(cmp.Or(a.ProviderName, a.Provider), cmp.Or(b.ProviderName, b.Provider)); n != 0 {
			return n
		}
		return cmp.Compare(cmp.Or(a.Name, a.ID), cmp.Or(b.Name, b.ID))
	})

	for _, entry := range models {
		if entry.Provider == "" || entry.ID == "" {
			continue
		}
		w.modelCatalog[entry.key()] = entry
		providerNames[entry.Provider] = cmp.Or(entry.ProviderName, entry.Provider)
		if entry.Available || entry.Authenticated {
			providerConfigured[entry.Provider] = true
		}
		displayName := cmp.Or(entry.Name, entry.ID)
		if !entry.Available {
			if entry.LoginAvailable {
				displayName += " (login required)"
			} else {
				displayName += " (unavailable)"
			}
		}
		providerModels[entry.Provider] = append(providerModels[entry.Provider], catwalk.Model{
			ID:               entry.ID,
			Name:             displayName,
			ContextWindow:    entry.ContextWindow,
			DefaultMaxTokens: entry.MaxTokens,
			CanReason:        entry.Reasoning,
			SupportsImages:   entry.SupportsImages,
		})
		selected := config.SelectedModel{Provider: entry.Provider, Model: entry.ID}
		for _, role := range entry.Roles {
			selectedByRole[role] = selected
		}
		if entry.Current {
			selectedByRole["current"] = selected
		}
	}

	providers := make(map[string]config.ProviderConfig, len(providerModels))
	providerIDs := make([]string, 0, len(providerModels))
	for providerID := range providerModels {
		providerIDs = append(providerIDs, providerID)
	}
	slices.Sort(providerIDs)
	for _, providerID := range providerIDs {
		apiKey := ""
		if providerConfigured[providerID] {
			apiKey = "gmp-authenticated"
		}
		providers[providerID] = config.ProviderConfig{
			ID:     providerID,
			Name:   providerNames[providerID],
			Type:   catwalk.TypeOpenAI,
			APIKey: apiKey,
			Models: providerModels[providerID],
		}
	}

	w.cfg.Providers.Reset(providers)
	if selected, ok := selectedByRole["default"]; ok {
		w.cfg.Models[config.SelectedModelTypeLarge] = selected
	} else if selected, ok := selectedByRole["current"]; ok {
		w.cfg.Models[config.SelectedModelTypeLarge] = selected
	}
	if selected, ok := selectedByRole["smol"]; ok {
		w.cfg.Models[config.SelectedModelTypeSmall] = selected
	}
	if selected, ok := selectedByRole["current"]; ok {
		w.model = AgentModel{
			CatwalkCfg: catwalk.Model{ID: selected.Model, Name: selected.Model},
			ModelCfg:   selected,
		}
	} else if catalog.Current != nil && catalog.Current.ID != "" {
		name := cmp.Or(catalog.Current.Name, catalog.Current.ID)
		selected := config.SelectedModel{Provider: catalog.Current.Provider, Model: catalog.Current.ID}
		w.model = AgentModel{
			CatwalkCfg: catwalk.Model{ID: catalog.Current.ID, Name: name},
			ModelCfg:   selected,
		}
	}
}
