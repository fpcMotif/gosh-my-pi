package workspace

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"

	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// ModelCatalog is Go's immutable projection of the backend RpcModelCatalog.
// It is the only model source used by the gmp picker.
type ModelCatalog struct {
	Models  []ModelCatalogEntry `json:"models"`
	Roles   []ModelCatalogRole  `json:"roles"`
	Current *ModelCatalogModel  `json:"current,omitempty"`
}

// ModelCatalogEntry mirrors one backend catalog model.
type ModelCatalogEntry struct {
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

// ModelCatalogRole mirrors one backend role assignment. Selector is retained
// even when it cannot be parsed as a provider/model reference.
type ModelCatalogRole struct {
	Role     string `json:"role"`
	Selector string `json:"selector,omitempty"`
	Provider string `json:"provider,omitempty"`
	ModelID  string `json:"modelId,omitempty"`
}

// ModelCatalogModel mirrors the backend Model value returned as current and
// by set_model. The catalog entry remains the display-oriented model shape.
type ModelCatalogModel struct {
	Provider               string                `json:"provider"`
	ID                     string                `json:"id"`
	Name                   string                `json:"name"`
	API                    string                `json:"api"`
	BaseURL                string                `json:"baseUrl"`
	Reasoning              bool                  `json:"reasoning"`
	Input                  []string              `json:"input"`
	Cost                   ModelCatalogCost      `json:"cost"`
	PremiumMultiplier      *float64              `json:"premiumMultiplier,omitempty"`
	ContextWindow          int64                 `json:"contextWindow"`
	MaxTokens              int64                 `json:"maxTokens"`
	Headers                map[string]string     `json:"headers,omitempty"`
	PreferWebSockets       bool                  `json:"preferWebsockets,omitempty"`
	ContextPromotionTarget string                `json:"contextPromotionTarget,omitempty"`
	Priority               *int64                `json:"priority,omitempty"`
	Thinking               *ModelCatalogThinking `json:"thinking,omitempty"`
	Compat                 json.RawMessage       `json:"compat,omitempty"`
	ApplyPatchToolType     string                `json:"applyPatchToolType,omitempty"`
	IsOAuth                bool                  `json:"isOAuth,omitempty"`
}

// ModelCatalogCost mirrors Model.cost.
type ModelCatalogCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// ModelCatalogThinking mirrors the backend ThinkingConfig.
type ModelCatalogThinking struct {
	Mode         string `json:"mode"`
	MinLevel     string `json:"minLevel"`
	MaxLevel     string `json:"maxLevel"`
	DefaultLevel string `json:"defaultLevel,omitempty"`
}

// ModelSelection asks the backend to assign one role to one catalog model.
type ModelSelection struct {
	Role           string
	Provider       string
	ModelID        string
	Reauthenticate bool
}

// ModelSelectionResult reports a required backend login without treating it
// as an RPC failure. LoginProvider is empty after an applied selection.
type ModelSelectionResult struct {
	LoginProvider string
}

// ModelSelectionError is a user-actionable selection failure.
type ModelSelectionError struct {
	Message string
}

func (e *ModelSelectionError) Error() string { return e.Message }

var errModelCatalogClientUnavailable = errors.New("model catalog client is unavailable")

func (e ModelCatalogEntry) key() string {
	return modelCatalogKey(e.Provider, e.ID)
}

func modelCatalogKey(providerID, modelID string) string {
	if providerID == "" || modelID == "" {
		return ""
	}
	return providerID + "/" + modelID
}

type modelCatalogResponse struct {
	Models  *[]ModelCatalogEntry `json:"models"`
	Roles   *[]ModelCatalogRole  `json:"roles"`
	Current *ModelCatalogModel   `json:"current,omitempty"`
}

// ModelCatalog returns an immutable snapshot of the last verified backend
// catalog. It never performs I/O.
func (w *GmpWorkspace) ModelCatalog() ModelCatalog {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return cloneModelCatalog(w.modelCatalog)
}

// RefreshModelCatalog validates a complete models.catalog response before one
// atomic state update. A failed refresh leaves the last good snapshot intact.
func (w *GmpWorkspace) RefreshModelCatalog(ctx context.Context) (ModelCatalog, error) {
	if err := w.acquireCatalogOp(ctx); err != nil {
		return w.ModelCatalog(), err
	}
	defer w.releaseCatalogOp()
	return w.refreshModelCatalogLocked(ctx)
}

func (w *GmpWorkspace) refreshModelCatalogLocked(ctx context.Context) (ModelCatalog, error) {
	catalog, err := FetchModelCatalog(ctx, w.client)
	if err != nil {
		return w.ModelCatalog(), err
	}
	w.mu.Lock()
	w.applyModelCatalogLocked(catalog)
	snapshot := cloneModelCatalog(w.modelCatalog)
	w.mu.Unlock()
	return snapshot, nil
}

// FetchModelCatalog fetches and validates one backend models.catalog response.
// It does not read or mutate workspace state.
func FetchModelCatalog(ctx context.Context, client *ompclient.Client) (ModelCatalog, error) {
	if client == nil {
		return ModelCatalog{}, errModelCatalogClientUnavailable
	}
	resp, err := client.Call(ctx, ompclient.Command{Type: "models.catalog"})
	if err != nil {
		return ModelCatalog{}, err
	}
	catalog, err := parseModelCatalog(resp.Data)
	if err != nil {
		return ModelCatalog{}, fmt.Errorf("parse models.catalog response: %w", err)
	}
	return catalog, nil
}

// SelectModel performs one backend-confirmed role change. It never changes
// local role or active-model state before set_model succeeds.
func (w *GmpWorkspace) SelectModel(ctx context.Context, selection ModelSelection) (ModelSelectionResult, error) {
	if selection.Role == "" || selection.Provider == "" || selection.ModelID == "" {
		return ModelSelectionResult{}, &ModelSelectionError{Message: "model selection requires role, provider, and model id"}
	}

	if err := w.acquireCatalogOp(ctx); err != nil {
		return ModelSelectionResult{}, err
	}
	defer w.releaseCatalogOp()

	catalog := w.ModelCatalog()
	entry, ok := catalog.entry(selection.Provider, selection.ModelID)
	if !ok {
		var err error
		catalog, err = w.refreshModelCatalogLocked(ctx)
		if err != nil {
			return ModelSelectionResult{}, err
		}
		entry, ok = catalog.entry(selection.Provider, selection.ModelID)
		if !ok {
			return ModelSelectionResult{}, &ModelSelectionError{Message: fmt.Sprintf("model not found: %s/%s", selection.Provider, selection.ModelID)}
		}
	}

	if selection.Reauthenticate || !entry.Available {
		if entry.LoginAvailable {
			return ModelSelectionResult{LoginProvider: entry.Provider}, nil
		}
		return ModelSelectionResult{}, &ModelSelectionError{Message: fmt.Sprintf("model unavailable: %s/%s", entry.Provider, entry.ID)}
	}
	if w.client == nil {
		return ModelSelectionResult{}, errModelCatalogClientUnavailable
	}

	resp, err := w.client.Call(ctx, ompclient.Command{
		Type:     "set_model",
		Provider: selection.Provider,
		ModelID:  selection.ModelID,
		Role:     selection.Role,
	})
	if err != nil {
		return ModelSelectionResult{}, err
	}
	receipt, err := parseSetModelResponse(resp.Data, selection, entry, catalog)
	if err != nil {
		return ModelSelectionResult{}, err
	}

	w.mu.Lock()
	w.applySelectionLocked(selection, receipt)
	w.mu.Unlock()
	return ModelSelectionResult{}, nil
}

func parseModelCatalog(data json.RawMessage) (ModelCatalog, error) {
	var response modelCatalogResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return ModelCatalog{}, err
	}
	if response.Models == nil || response.Roles == nil {
		return ModelCatalog{}, errors.New("models.catalog response must include models and roles")
	}
	catalog := ModelCatalog{
		Models:  slices.Clone(*response.Models),
		Roles:   slices.Clone(*response.Roles),
		Current: cloneModelCatalogModel(response.Current),
	}
	if err := validateModelCatalog(catalog); err != nil {
		return ModelCatalog{}, err
	}
	slices.SortFunc(catalog.Models, compareModelCatalogEntries)
	return catalog, nil
}

func validateModelCatalog(catalog ModelCatalog) error {
	entries := make(map[string]struct{}, len(catalog.Models))
	markedCurrent := 0
	for _, entry := range catalog.Models {
		key := entry.key()
		if key == "" {
			return errors.New("model has blank provider or id")
		}
		if _, exists := entries[key]; exists {
			return fmt.Errorf("duplicate model: %s", key)
		}
		entries[key] = struct{}{}
		if entry.Current {
			markedCurrent++
			if catalog.Current == nil || entry.Provider != catalog.Current.Provider || entry.ID != catalog.Current.ID {
				return errors.New("model current marker disagrees with current model")
			}
		}
	}
	if markedCurrent > 1 {
		return errors.New("multiple models are marked current")
	}
	roles := make(map[string]struct{}, len(catalog.Roles))
	for _, role := range catalog.Roles {
		if role.Role == "" {
			return errors.New("model role has blank name")
		}
		if _, exists := roles[role.Role]; exists {
			return fmt.Errorf("duplicate model role: %s", role.Role)
		}
		roles[role.Role] = struct{}{}
		if (role.Provider == "") != (role.ModelID == "") {
			return fmt.Errorf("model role %q has incomplete reference", role.Role)
		}
	}
	if catalog.Current != nil {
		key := modelCatalogKey(catalog.Current.Provider, catalog.Current.ID)
		if key == "" {
			return errors.New("current model has blank provider or id")
		}
		if _, exists := entries[key]; !exists {
			return errors.New("current model is absent from models")
		}
	}
	return nil
}

func compareModelCatalogEntries(a, b ModelCatalogEntry) int {
	if n := cmp.Compare(cmp.Or(a.ProviderName, a.Provider), cmp.Or(b.ProviderName, b.Provider)); n != 0 {
		return n
	}
	if n := cmp.Compare(a.Provider, b.Provider); n != 0 {
		return n
	}
	if n := cmp.Compare(cmp.Or(a.Name, a.ID), cmp.Or(b.Name, b.ID)); n != 0 {
		return n
	}
	return cmp.Compare(a.ID, b.ID)
}

// modelSelectionReceipt is the backend's authoritative postcondition for a
// successful role assignment. Selected is encoded at the top level for wire
// compatibility; ActiveModel and ThinkingLevel state what is effective now.
type modelSelectionReceipt struct {
	Selected      *ModelCatalogModel
	Assignment    ModelCatalogRole
	ActiveModel   *ModelCatalogModel
	ThinkingLevel *string
}

func parseSetModelResponse(data json.RawMessage, selection ModelSelection, entry ModelCatalogEntry, catalog ModelCatalog) (modelSelectionReceipt, error) {
	if len(data) == 0 || string(data) == "null" {
		return modelSelectionReceipt{}, errors.New("set_model response must contain the selected model")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return modelSelectionReceipt{}, fmt.Errorf("parse set_model response: %w", err)
	}
	activeData, ok := fields["activeModel"]
	if !ok {
		return modelSelectionReceipt{}, errors.New("set_model response must include activeModel")
	}
	thinkingData, ok := fields["thinkingLevel"]
	if !ok {
		return modelSelectionReceipt{}, errors.New("set_model response must include thinkingLevel")
	}
	assignmentData, ok := fields["assignment"]
	if !ok {
		return modelSelectionReceipt{}, errors.New("set_model response must include assignment")
	}

	var selected ModelCatalogModel
	if err := json.Unmarshal(data, &selected); err != nil {
		return modelSelectionReceipt{}, fmt.Errorf("parse selected model: %w", err)
	}
	if selected.Provider != entry.Provider || selected.ID != entry.ID {
		return modelSelectionReceipt{}, fmt.Errorf("set_model response mismatched selection: got %s/%s, want %s/%s", selected.Provider, selected.ID, entry.Provider, entry.ID)
	}
	assignment, err := parseModelAssignment(assignmentData, selection, entry)
	if err != nil {
		return modelSelectionReceipt{}, err
	}

	active, err := parseNullableCatalogModel(activeData, "activeModel")
	if err != nil {
		return modelSelectionReceipt{}, err
	}
	if active != nil {
		if _, ok := catalog.entry(active.Provider, active.ID); !ok {
			return modelSelectionReceipt{}, fmt.Errorf("set_model response activeModel is absent from catalog: %s/%s", active.Provider, active.ID)
		}
	}
	if selection.Role == "default" && (active == nil || active.Provider != entry.Provider || active.ID != entry.ID) {
		return modelSelectionReceipt{}, errors.New("set_model response default selection did not become active")
	}
	thinkingLevel, err := parseNullableThinkingLevel(thinkingData, "set_model")
	if err != nil {
		return modelSelectionReceipt{}, err
	}
	return modelSelectionReceipt{Selected: &selected, Assignment: assignment, ActiveModel: active, ThinkingLevel: thinkingLevel}, nil
}

func parseModelAssignment(data json.RawMessage, selection ModelSelection, entry ModelCatalogEntry) (ModelCatalogRole, error) {
	if string(data) == "null" {
		return ModelCatalogRole{}, errors.New("set_model response assignment must be an object")
	}
	var assignment ModelCatalogRole
	if err := json.Unmarshal(data, &assignment); err != nil {
		return ModelCatalogRole{}, fmt.Errorf("parse set_model assignment: %w", err)
	}
	if assignment.Role != selection.Role {
		return ModelCatalogRole{}, fmt.Errorf("set_model response assignment role mismatched selection: got %q, want %q", assignment.Role, selection.Role)
	}
	if assignment.Provider != entry.Provider || assignment.ModelID != entry.ID {
		return ModelCatalogRole{}, fmt.Errorf("set_model response assignment target mismatched selection: got %s/%s, want %s/%s", assignment.Provider, assignment.ModelID, entry.Provider, entry.ID)
	}
	if assignment.Selector == "" {
		return ModelCatalogRole{}, errors.New("set_model response assignment has blank selector")
	}
	return assignment, nil
}

func parseNullableCatalogModel(data json.RawMessage, field string) (*ModelCatalogModel, error) {
	if string(data) == "null" {
		return nil, nil
	}
	var model ModelCatalogModel
	if err := json.Unmarshal(data, &model); err != nil {
		return nil, fmt.Errorf("parse %s: %w", field, err)
	}
	if modelCatalogKey(model.Provider, model.ID) == "" {
		return nil, fmt.Errorf("%s has blank provider or id", field)
	}
	return &model, nil
}

func parseNullableThinkingLevel(data json.RawMessage, command string) (*string, error) {
	if string(data) == "null" {
		return nil, nil
	}
	var level string
	if err := json.Unmarshal(data, &level); err != nil {
		return nil, fmt.Errorf("parse %s thinkingLevel: %w", command, err)
	}
	if !isThinkingLevel(level) {
		return nil, fmt.Errorf("%s response has unsupported thinking level %q", command, level)
	}
	return &level, nil
}

func (catalog ModelCatalog) entry(providerID, modelID string) (ModelCatalogEntry, bool) {
	for _, entry := range catalog.Models {
		if entry.Provider == providerID && entry.ID == modelID {
			return entry, true
		}
	}
	return ModelCatalogEntry{}, false
}

func (w *GmpWorkspace) applyModelCatalogLocked(catalog ModelCatalog) {
	w.modelCatalog = cloneModelCatalog(catalog)
	thinkingLevel := w.thinkingLevel
	w.applyActiveModelLocked(catalog.Current, &thinkingLevel)
}

func (w *GmpWorkspace) applySelectionLocked(selection ModelSelection, receipt modelSelectionReceipt) {
	for i := range w.modelCatalog.Models {
		entry := &w.modelCatalog.Models[i]
		entry.Roles = removeModelRole(entry.Roles, selection.Role)
		if entry.Provider == selection.Provider && entry.ID == selection.ModelID {
			entry.Roles = appendRole(entry.Roles, selection.Role)
		}
	}
	updated := false
	for i := range w.modelCatalog.Roles {
		if w.modelCatalog.Roles[i].Role != selection.Role {
			continue
		}
		w.modelCatalog.Roles[i] = receipt.Assignment
		updated = true
		break
	}
	if !updated {
		w.modelCatalog.Roles = append(w.modelCatalog.Roles, receipt.Assignment)
	}
	w.applyActiveModelLocked(receipt.ActiveModel, receipt.ThinkingLevel)
}

// applyActiveModelLocked commits one backend-owned active-model snapshot.
// Catalog current markers stay internally valid even when the snapshot is
// newer than the last catalog refresh.
func (w *GmpWorkspace) applyActiveModelLocked(active *ModelCatalogModel, thinkingLevel *string) {
	currentInCatalog := false
	for i := range w.modelCatalog.Models {
		entry := &w.modelCatalog.Models[i]
		entry.Current = active != nil && entry.Provider == active.Provider && entry.ID == active.ID
		currentInCatalog = currentInCatalog || entry.Current
	}
	if currentInCatalog {
		w.modelCatalog.Current = cloneModelCatalogModel(active)
	} else {
		w.modelCatalog.Current = nil
	}
	w.model = agentModelFromCatalogModel(active)
	w.setThinkingLevelLocked(optionalThinkingLevel(thinkingLevel))
}

func optionalThinkingLevel(level *string) string {
	if level == nil {
		return ""
	}
	return *level
}

func agentModelFromCatalogModel(model *ModelCatalogModel) AgentModel {
	if model == nil {
		return AgentModel{}
	}
	return AgentModel{
		CatwalkCfg: catwalk.Model{
			ID:               model.ID,
			Name:             cmp.Or(model.Name, model.ID),
			ContextWindow:    model.ContextWindow,
			DefaultMaxTokens: model.MaxTokens,
			CanReason:        model.Reasoning,
			ReasoningLevels:  reasoningLevels(model.Thinking),
			DefaultReasoningEffort: func() string {
				if model.Thinking == nil {
					return ""
				}
				return model.Thinking.DefaultLevel
			}(),
			SupportsImages: slices.Contains(model.Input, "image"),
		},
		ModelCfg: config.SelectedModel{Provider: model.Provider, Model: model.ID},
	}
}

func reasoningLevels(thinking *ModelCatalogThinking) []string {
	if thinking == nil {
		return nil
	}
	levels := []string{"minimal", "low", "medium", "high", "xhigh"}
	start := slices.Index(levels, thinking.MinLevel)
	end := slices.Index(levels, thinking.MaxLevel)
	if start < 0 || end < start {
		return nil
	}
	return slices.Clone(levels[start : end+1])
}

func removeModelRole(roles []string, role string) []string {
	return slices.DeleteFunc(roles, func(candidate string) bool { return candidate == role })
}

func appendRole(roles []string, role string) []string {
	if slices.Contains(roles, role) {
		return roles
	}
	return append(roles, role)
}

func cloneModelCatalog(catalog ModelCatalog) ModelCatalog {
	clone := ModelCatalog{
		Models:  make([]ModelCatalogEntry, len(catalog.Models)),
		Roles:   slices.Clone(catalog.Roles),
		Current: cloneModelCatalogModel(catalog.Current),
	}
	for i, entry := range catalog.Models {
		clone.Models[i] = entry
		clone.Models[i].Roles = slices.Clone(entry.Roles)
	}
	return clone
}

func cloneModelCatalogModel(model *ModelCatalogModel) *ModelCatalogModel {
	if model == nil {
		return nil
	}
	clone := *model
	clone.Input = slices.Clone(model.Input)
	clone.Headers = maps.Clone(model.Headers)
	clone.PremiumMultiplier = cloneFloat64(model.PremiumMultiplier)
	clone.Priority = cloneInt64(model.Priority)
	clone.Thinking = cloneModelCatalogThinking(model.Thinking)
	clone.Compat = slices.Clone(model.Compat)
	return &clone
}

func cloneFloat64(value *float64) *float64 {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func cloneModelCatalogThinking(thinking *ModelCatalogThinking) *ModelCatalogThinking {
	if thinking == nil {
		return nil
	}
	clone := *thinking
	return &clone
}

func (w *GmpWorkspace) acquireCatalogOp(ctx context.Context) error {
	select {
	case w.catalogOps <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *GmpWorkspace) releaseCatalogOp() {
	<-w.catalogOps
}
