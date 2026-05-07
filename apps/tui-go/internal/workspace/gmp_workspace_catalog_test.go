package workspace

import (
	"context"
	"testing"
	"time"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
)

func TestRefreshModelCatalogRequestsAndAppliesBackendCatalog(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	errCh := make(chan error, 1)
	go func() {
		errCh <- w.RefreshModelCatalog(context.Background())
	}()

	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "models.catalog" {
		t.Fatalf("expected models.catalog command, got %#v", frame)
	}
	id, _ := frame["id"].(string)
	if id == "" {
		t.Fatalf("models.catalog command missing id: %#v", frame)
	}

	if err := pc.writeInbound(map[string]any{
		"type":    "response",
		"id":      id,
		"command": "models.catalog",
		"success": true,
		"data": map[string]any{
			"models": []map[string]any{
				{
					"provider":       "openai-codex",
					"providerName":   "OpenAI Codex",
					"id":             "gpt-5.3-codex-spark",
					"name":           "Spark",
					"available":      false,
					"authenticated":  false,
					"loginAvailable": true,
					"roles":          []string{"smol"},
					"contextWindow":  128000,
					"maxTokens":      8192,
					"reasoning":      true,
					"supportsImages": true,
				},
				{
					"provider":      "chatgpt-sub",
					"providerName":  "ChatGPT subscription",
					"id":            "gpt-5.5",
					"name":          "GPT-5.5",
					"available":     true,
					"authenticated": true,
					"current":       true,
					"roles":         []string{"default"},
				},
				{"provider": "", "id": "ignored"},
			},
		},
	}); err != nil {
		t.Fatalf("write catalog response: %v", err)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("RefreshModelCatalog returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for RefreshModelCatalog")
	}

	entry, ok := w.ModelCatalogEntry("openai-codex", "gpt-5.3-codex-spark")
	if !ok || entry.ProviderName != "OpenAI Codex" || !entry.LoginAvailable {
		t.Fatalf("catalog entry mismatch: %#v, ok=%v", entry, ok)
	}
	if _, ok := w.ModelCatalogEntry("", "ignored"); ok {
		t.Fatalf("empty provider entry should not be indexed")
	}

	cfg := w.Config()
	if got := cfg.Models[config.SelectedModelTypeLarge]; got.Provider != "chatgpt-sub" || got.Model != "gpt-5.5" {
		t.Fatalf("large model = %#v, want chatgpt-sub/gpt-5.5", got)
	}
	if got := cfg.Models[config.SelectedModelTypeSmall]; got.Provider != "openai-codex" || got.Model != "gpt-5.3-codex-spark" {
		t.Fatalf("small model = %#v, want openai-codex/gpt-5.3-codex-spark", got)
	}
	codex, ok := cfg.Providers.Get("openai-codex")
	if !ok {
		t.Fatalf("openai-codex provider missing from config")
	}
	if codex.APIKey != "" {
		t.Fatalf("unauthenticated provider APIKey = %q, want empty", codex.APIKey)
	}
	if len(codex.Models) != 1 || codex.Models[0].Name != "Spark (login required)" {
		t.Fatalf("codex models = %#v, want login-required display label", codex.Models)
	}
}

func TestApplyModelCatalogUsesCurrentFallbackAndUnavailableLabel(t *testing.T) {
	w := newTestGmpWorkspace()
	w.cfg.Providers.Set("stale", config.ProviderConfig{
		ID:     "stale",
		Name:   "Stale",
		Type:   catwalk.TypeOpenAI,
		APIKey: "old",
	})

	w.applyModelCatalogLocked(gmpModelCatalogResponse{
		Models: []GmpModelCatalogEntry{
			{
				Provider:       "offline",
				ProviderName:   "Offline Provider",
				ID:             "offline-model",
				Name:           "Offline Model",
				Available:      false,
				LoginAvailable: false,
			},
		},
		Current: &struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
			Name     string `json:"name"`
		}{
			Provider: "offline",
			ID:       "offline-model",
			Name:     "Offline Model",
		},
	})

	if _, ok := w.cfg.Providers.Get("stale"); ok {
		t.Fatalf("stale provider survived catalog reset")
	}
	offline, ok := w.cfg.Providers.Get("offline")
	if !ok {
		t.Fatalf("offline provider missing from catalog config")
	}
	if offline.APIKey != "" {
		t.Fatalf("offline APIKey = %q, want empty", offline.APIKey)
	}
	if len(offline.Models) != 1 || offline.Models[0].Name != "Offline Model (unavailable)" {
		t.Fatalf("offline models = %#v, want unavailable label", offline.Models)
	}
	if got := w.AgentModel(); got.ModelCfg.Provider != "offline" || got.ModelCfg.Model != "offline-model" || got.CatwalkCfg.Name != "Offline Model" {
		t.Fatalf("agent model = %#v, want current fallback offline/offline-model", got)
	}
}

func TestApplyModelCatalogClearsProvidersWhenBackendCatalogIsEmpty(t *testing.T) {
	w := newTestGmpWorkspace()
	w.cfg.Providers.Set("stale", config.ProviderConfig{
		ID:     "stale",
		Name:   "Stale",
		Type:   catwalk.TypeOpenAI,
		APIKey: "old",
	})

	w.applyModelCatalogLocked(gmpModelCatalogResponse{})

	if w.cfg.Providers.Len() != 0 {
		t.Fatalf("providers length = %d, want empty bridge catalog", w.cfg.Providers.Len())
	}
}

func TestUpdatePreferredModelSendsRoleForSelectedModelType(t *testing.T) {
	cases := []struct {
		name      string
		modelType config.SelectedModelType
		wantRole  string
	}{
		{name: "large", modelType: config.SelectedModelTypeLarge, wantRole: "default"},
		{name: "small", modelType: config.SelectedModelTypeSmall, wantRole: "smol"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, pc := gmpWorkspaceWithClient(t)
			defer pc.close()

			errCh := make(chan error, 1)
			go func() {
				errCh <- w.UpdatePreferredModel(config.ScopeGlobal, tc.modelType, config.SelectedModel{
					Provider: "openai-codex",
					Model:    "gpt-5.3-codex-spark",
				})
			}()

			frame := pc.waitForFrame(t, 2*time.Second)
			if frame["type"] != "set_model" || frame["provider"] != "openai-codex" ||
				frame["modelId"] != "gpt-5.3-codex-spark" || frame["role"] != tc.wantRole {
				t.Fatalf("set_model frame = %#v, want role %q", frame, tc.wantRole)
			}
			id := frame["id"].(string)
			if err := pc.writeInbound(map[string]any{
				"type":    "response",
				"id":      id,
				"command": "set_model",
				"success": true,
				"data":    map[string]any{"provider": "openai-codex", "id": "gpt-5.3-codex-spark"},
			}); err != nil {
				t.Fatalf("write set_model response: %v", err)
			}

			select {
			case err := <-errCh:
				if err != nil {
					t.Fatalf("UpdatePreferredModel returned error: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("timed out waiting for UpdatePreferredModel")
			}
			if got := w.AgentModel(); got.ModelCfg.Provider != "openai-codex" || got.ModelCfg.Model != "gpt-5.3-codex-spark" {
				t.Fatalf("agent model = %#v, want selected model", got)
			}
			if !w.IsGmpMode() {
				t.Fatalf("GmpWorkspace must report gmp mode")
			}
		})
	}
}

func TestGmpModelCatalogKeyRejectsIncompleteIDs(t *testing.T) {
	if got := gmpModelCatalogKey("", "model"); got != "" {
		t.Fatalf("empty provider key = %q, want empty", got)
	}
	if got := gmpModelCatalogKey("provider", ""); got != "" {
		t.Fatalf("empty model key = %q, want empty", got)
	}
	if got := gmpModelCatalogKey("provider", "model"); got != "provider/model" {
		t.Fatalf("full key = %q, want provider/model", got)
	}
}
