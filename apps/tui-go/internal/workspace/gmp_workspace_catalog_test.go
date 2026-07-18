package workspace

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"
)

func TestRefreshModelCatalogPreservesBackendShape(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.mu.Lock()
	w.setThinkingLevelLocked("high")
	w.mu.Unlock()

	result := make(chan struct {
		catalog ModelCatalog
		err     error
	}, 1)
	go func() {
		catalog, err := w.RefreshModelCatalog(context.Background())
		result <- struct {
			catalog ModelCatalog
			err     error
		}{catalog, err}
	}()

	frame := waitForCatalogFrame(t, pc, 0)
	if frame["type"] != "models.catalog" {
		t.Fatalf("command = %#v, want models.catalog", frame)
	}
	id, _ := frame["id"].(string)
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
					"loginSupported": true,
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
			},
			"roles": []map[string]any{
				{"role": "default", "selector": "chatgpt-sub/gpt-5.5", "provider": "chatgpt-sub", "modelId": "gpt-5.5"},
				{"role": "smol", "selector": "openai-codex/gpt-5.3-codex-spark", "provider": "openai-codex", "modelId": "gpt-5.3-codex-spark"},
				{"role": "review", "selector": "model:review"},
			},
			"current": map[string]any{
				"provider":      "chatgpt-sub",
				"id":            "gpt-5.5",
				"name":          "GPT-5.5",
				"api":           "responses",
				"baseUrl":       "https://example.invalid",
				"input":         []string{"text", "image"},
				"reasoning":     true,
				"thinking":      map[string]any{"mode": "effort", "minLevel": "low", "maxLevel": "high", "defaultLevel": "medium"},
				"contextWindow": 200000,
				"maxTokens":     8192,
				"cost":          map[string]any{"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4},
			},
		},
	}); err != nil {
		t.Fatalf("write catalog response: %v", err)
	}

	select {
	case got := <-result:
		if got.err != nil {
			t.Fatalf("RefreshModelCatalog: %v", got.err)
		}
		if len(got.catalog.Models) != 2 || len(got.catalog.Roles) != 3 || got.catalog.Current == nil {
			t.Fatalf("catalog = %#v", got.catalog)
		}
		if got.catalog.Roles[2].Selector != "model:review" || got.catalog.Current.Cost.CacheWrite != 4 {
			t.Fatalf("catalog lost backend data: %#v", got.catalog)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for catalog refresh")
	}

	snapshot := w.ModelCatalog()
	snapshot.Models[0].Roles[0] = "mutated"
	snapshot.Current.Headers = map[string]string{"changed": "yes"}
	snapshot.Current.Thinking.MinLevel = "mutated"
	if got := w.ModelCatalog(); got.Models[0].Roles[0] == "mutated" || got.Current.Headers != nil || got.Current.Thinking.MinLevel == "mutated" {
		t.Fatalf("ModelCatalog returned mutable state: %#v", got)
	}
	cfg := w.Config()
	if len(cfg.Models) != 0 {
		t.Fatalf("catalog populated compatibility cache: %#v", cfg.Models)
	}
	if cfg.Providers.Len() != 0 {
		t.Fatalf("bridge providers = %d, want none", cfg.Providers.Len())
	}
	model := w.AgentModel().CatwalkCfg
	if !reflect.DeepEqual(model.ReasoningLevels, []string{"low", "medium", "high"}) || model.DefaultReasoningEffort != "medium" {
		t.Fatalf("reasoning mapping = %#v", model)
	}
	if got := w.AgentModel().ModelCfg; !got.Think || got.ReasoningEffort != "high" {
		t.Fatalf("catalog refresh lost thinking level: %#v", got)
	}
}

func TestRefreshModelCatalogFailureRetainsLastSnapshot(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, availableCatalog("old", "old-model"))
	want := w.ModelCatalog()

	result := make(chan error, 1)
	frameCount := len(pc.frames())
	go func() {
		_, err := w.RefreshModelCatalog(context.Background())
		result <- err
	}()
	frame := waitForCatalogFrame(t, pc, frameCount)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "models.catalog", "success": true,
		"data": map[string]any{"models": []map[string]any{{"provider": "", "id": "broken"}}, "roles": []map[string]any{}},
	}); err != nil {
		t.Fatalf("write malformed response: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("malformed catalog succeeded")
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, want) {
		t.Fatalf("malformed refresh changed snapshot:\n got %#v\nwant %#v", got, want)
	}

	frameCount = len(pc.frames())
	go func() {
		_, err := w.RefreshModelCatalog(context.Background())
		result <- err
	}()
	frame = waitForCatalogFrame(t, pc, frameCount)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "models.catalog", "success": false, "error": "backend down",
	}); err != nil {
		t.Fatalf("write failed response: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("failed catalog RPC succeeded")
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, want) {
		t.Fatalf("failed refresh changed snapshot:\n got %#v\nwant %#v", got, want)
	}
}

func TestSelectModelCommitsOnlyAfterAcknowledgement(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, availableCatalog("old", "old-model"))
	w.mu.Lock()
	w.setThinkingLevelLocked("high")
	w.mu.Unlock()
	w.mu.Lock()
	w.modelCatalog.Models = append(w.modelCatalog.Models, ModelCatalogEntry{Provider: "new", ID: "new-model", Name: "New", Available: true})
	w.mu.Unlock()
	before := w.ModelCatalog()

	result := make(chan error, 1)
	go func() {
		_, err := w.SelectModel(context.Background(), ModelSelection{Role: "default", Provider: "new", ModelID: "new-model"})
		result <- err
	}()
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "set_model" || frame["role"] != "default" || frame["provider"] != "new" || frame["modelId"] != "new-model" {
		t.Fatalf("set_model command = %#v", frame)
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, before) {
		t.Fatalf("selection changed state before acknowledgement")
	}
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_model", "success": true,
		"data": map[string]any{
			"provider": "new", "id": "new-model", "name": "New", "input": []string{"text"},
			"assignment":    map[string]any{"role": "default", "provider": "new", "modelId": "new-model", "selector": "new/new-model"},
			"activeModel":   map[string]any{"provider": "new", "id": "new-model", "name": "New", "input": []string{"text"}},
			"thinkingLevel": "high",
		},
	}); err != nil {
		t.Fatalf("write selection response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("SelectModel: %v", err)
	}
	if got := w.AgentModel(); got.ModelCfg.Provider != "new" || got.ModelCfg.Model != "new-model" {
		t.Fatalf("agent model = %#v", got)
	}
	if got := w.ModelCatalog(); got.Current == nil || got.Current.Provider != "new" || got.Current.ID != "new-model" || !got.Models[1].Current {
		t.Fatalf("default selection did not commit effective model: %#v", got)
	}
	if len(w.Config().Models) != 0 {
		t.Fatalf("selection populated compatibility cache: %#v", w.Config().Models)
	}
	if got := w.AgentModel().ModelCfg; !got.Think || got.ReasoningEffort != "high" {
		t.Fatalf("model selection lost thinking level: %#v", got)
	}
}

func TestSelectModelSmolPreservesActiveModel(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, ModelCatalog{
		Models: []ModelCatalogEntry{
			{Provider: "large", ID: "large-model", Name: "Large", Available: true, Current: true, Roles: []string{"default"}},
			{Provider: "small", ID: "small-model", Name: "Small", Available: true},
		},
		Roles: []ModelCatalogRole{
			{Role: "default", Provider: "large", ModelID: "large-model", Selector: "large/large-model"},
			{Role: "smol", Provider: "large", ModelID: "large-model", Selector: "large/large-model"},
		},
		Current: &ModelCatalogModel{Provider: "large", ID: "large-model", Name: "Large"},
	})
	before := w.ModelCatalog()
	beforeModel := w.AgentModel()

	result := make(chan error, 1)
	go func() {
		_, err := w.SelectModel(context.Background(), ModelSelection{Role: "smol", Provider: "small", ModelID: "small-model"})
		result <- err
	}()
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "set_model" || frame["role"] != "smol" || frame["provider"] != "small" || frame["modelId"] != "small-model" {
		t.Fatalf("set_model command = %#v", frame)
	}
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_model", "success": true,
		"data": map[string]any{
			"provider": "small", "id": "small-model", "name": "Small", "input": []string{"text"},
			"assignment":    map[string]any{"role": "smol", "provider": "small", "modelId": "small-model", "selector": "small/small-model:xhigh"},
			"activeModel":   map[string]any{"provider": "large", "id": "large-model", "name": "Large"},
			"thinkingLevel": nil,
		},
	}); err != nil {
		t.Fatalf("write selection response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("SelectModel: %v", err)
	}

	got := w.ModelCatalog()
	if !reflect.DeepEqual(got.Current, before.Current) {
		t.Fatalf("smol selection changed current model:\n got %#v\nwant %#v", got.Current, before.Current)
	}
	if got.Models[0].Current != before.Models[0].Current || got.Models[1].Current != before.Models[1].Current {
		t.Fatalf("smol selection changed current entry flags: %#v", got.Models)
	}
	if !reflect.DeepEqual(w.AgentModel(), beforeModel) {
		t.Fatalf("smol selection changed active agent model:\n got %#v\nwant %#v", w.AgentModel(), beforeModel)
	}
	if got.Roles[1].Provider != "small" || got.Roles[1].ModelID != "small-model" || got.Roles[1].Selector != "small/small-model:xhigh" {
		t.Fatalf("smol role = %#v", got.Roles[1])
	}
	if slices.Contains(got.Models[0].Roles, "smol") || !slices.Contains(got.Models[1].Roles, "smol") {
		t.Fatalf("smol model roles = %#v", got.Models)
	}
}

func TestSelectModelFailureLeavesStateUnchanged(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, availableCatalog("provider", "model"))
	before := w.ModelCatalog()
	beforeModel := w.AgentModel()

	result := make(chan error, 1)
	go func() {
		_, err := w.SelectModel(context.Background(), ModelSelection{Role: "default", Provider: "provider", ModelID: "model"})
		result <- err
	}()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_model", "success": false, "error": "rejected",
	}); err != nil {
		t.Fatalf("write selection failure: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("failed selection succeeded")
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, before) {
		t.Fatalf("failed selection changed catalog")
	}
	if got := w.AgentModel(); !reflect.DeepEqual(got, beforeModel) {
		t.Fatalf("failed selection changed agent model")
	}
}

func TestSelectModelMalformedReceiptLeavesStateUnchanged(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, availableCatalog("old", "old-model"))
	w.mu.Lock()
	w.modelCatalog.Models = append(w.modelCatalog.Models, ModelCatalogEntry{Provider: "new", ID: "new-model", Available: true})
	w.mu.Unlock()
	beforeCatalog := w.ModelCatalog()
	beforeModel := w.AgentModel()
	beforeThinking := w.ThinkingLevel()

	result := make(chan error, 1)
	go func() {
		_, err := w.SelectModel(context.Background(), ModelSelection{Role: "default", Provider: "new", ModelID: "new-model"})
		result <- err
	}()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_model", "success": true,
		"data": map[string]any{
			"provider": "new", "id": "new-model",
			"activeModel":   map[string]any{"provider": "new", "id": "new-model"},
			"thinkingLevel": "high",
		},
	}); err != nil {
		t.Fatalf("write malformed selection response: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("malformed selection receipt succeeded")
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, beforeCatalog) {
		t.Fatalf("malformed selection changed catalog:\n got %#v\nwant %#v", got, beforeCatalog)
	}
	if got := w.AgentModel(); !reflect.DeepEqual(got, beforeModel) {
		t.Fatalf("malformed selection changed active model: %#v", got)
	}
	if got := w.ThinkingLevel(); got != beforeThinking {
		t.Fatalf("malformed selection changed thinking level: %q", got)
	}
}

func TestSelectModelReturnsLoginRequirementWithoutMutation(t *testing.T) {
	w := newTestGmpWorkspace()
	seedModelCatalog(t, w, ModelCatalog{
		Models: []ModelCatalogEntry{{Provider: "openai-codex", ID: "spark", LoginAvailable: true}},
		Roles:  []ModelCatalogRole{{Role: "default", Provider: "openai-codex", ModelID: "spark"}},
	})
	before := w.ModelCatalog()
	result, err := w.SelectModel(context.Background(), ModelSelection{Role: "default", Provider: "openai-codex", ModelID: "spark", Reauthenticate: true})
	if err != nil {
		t.Fatalf("SelectModel: %v", err)
	}
	if result.LoginProvider != "openai-codex" {
		t.Fatalf("login provider = %q", result.LoginProvider)
	}
	if got := w.ModelCatalog(); !reflect.DeepEqual(got, before) {
		t.Fatalf("login requirement changed catalog")
	}
}

func TestCatalogOperationRespectsWaitingDeadline(t *testing.T) {
	w := newTestGmpWorkspace()
	w.catalogOps <- struct{}{}
	defer func() { <-w.catalogOps }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := w.RefreshModelCatalog(ctx)
	if err != context.DeadlineExceeded {
		t.Fatalf("RefreshModelCatalog error = %v, want deadline exceeded", err)
	}
}

func TestFetchModelCatalogRejectsNilClient(t *testing.T) {
	_, err := FetchModelCatalog(context.Background(), nil)
	if err != errModelCatalogClientUnavailable {
		t.Fatalf("FetchModelCatalog error = %v, want unavailable client", err)
	}
}

func TestValidateModelCatalogRejectsConflictingCurrentMarkers(t *testing.T) {
	modelA := ModelCatalogEntry{Provider: "a", ID: "one"}
	modelB := ModelCatalogEntry{Provider: "b", ID: "two"}
	cases := []struct {
		name    string
		catalog ModelCatalog
		wantErr bool
	}{
		{
			name:    "no current accepts no markers",
			catalog: ModelCatalog{Models: []ModelCatalogEntry{modelA}},
		},
		{
			name:    "current accepts no marker",
			catalog: ModelCatalog{Models: []ModelCatalogEntry{modelA}, Current: &ModelCatalogModel{Provider: "a", ID: "one"}},
		},
		{
			name:    "current accepts matching marker",
			catalog: ModelCatalog{Models: []ModelCatalogEntry{{Provider: "a", ID: "one", Current: true}}, Current: &ModelCatalogModel{Provider: "a", ID: "one"}},
		},
		{
			name:    "marker without current",
			catalog: ModelCatalog{Models: []ModelCatalogEntry{{Provider: "a", ID: "one", Current: true}}},
			wantErr: true,
		},
		{
			name: "marker disagrees with current",
			catalog: ModelCatalog{
				Models:  []ModelCatalogEntry{{Provider: "a", ID: "one", Current: true}, modelB},
				Current: &ModelCatalogModel{Provider: "b", ID: "two"},
			},
			wantErr: true,
		},
		{
			name: "multiple markers",
			catalog: ModelCatalog{
				Models:  []ModelCatalogEntry{{Provider: "a", ID: "one", Current: true}, {Provider: "b", ID: "two", Current: true}},
				Current: &ModelCatalogModel{Provider: "a", ID: "one"},
			},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateModelCatalog(tc.catalog)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateModelCatalog error = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}

func TestApplyModelCatalogClearsModelWhenCurrentIsMissing(t *testing.T) {
	w := newTestGmpWorkspace()
	seedModelCatalog(t, w, availableCatalog("provider", "model"))
	w.mu.Lock()
	w.applyModelCatalogLocked(ModelCatalog{Models: []ModelCatalogEntry{{Provider: "provider", ID: "model"}}})
	w.mu.Unlock()
	if got := w.AgentModel(); got.ModelCfg.Provider != "" || got.ModelCfg.Model != "" || got.CatwalkCfg.ID != "" {
		t.Fatalf("agent model = %#v, want cleared", got)
	}
}

func availableCatalog(provider, model string) ModelCatalog {
	return ModelCatalog{
		Models:  []ModelCatalogEntry{{Provider: provider, ID: model, Name: model, Available: true, Current: true, Roles: []string{"default"}}},
		Roles:   []ModelCatalogRole{{Role: "default", Provider: provider, ModelID: model, Selector: provider + "/" + model}},
		Current: &ModelCatalogModel{Provider: provider, ID: model, Name: model},
	}
}

func seedModelCatalog(t *testing.T, w *GmpWorkspace, catalog ModelCatalog) {
	t.Helper()
	if err := validateModelCatalog(catalog); err != nil {
		t.Fatalf("invalid test catalog: %v", err)
	}
	w.mu.Lock()
	w.applyModelCatalogLocked(catalog)
	w.mu.Unlock()
}

func waitForCatalogFrame(t *testing.T, pc *pipeClient, count int) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frames := pc.frames()
		if len(frames) > count {
			return frames[len(frames)-1]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for new outbound frame")
	return nil
}
