package workspace

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
)

func TestSetThinkingLevelCommitsAfterAcknowledgement(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.model = AgentModel{ModelCfg: config.SelectedModel{Provider: "openai", Model: "gpt", Think: true, ReasoningEffort: "low"}}
	w.thinkingLevel = "low"

	result := make(chan error, 1)
	go func() { result <- w.SetThinkingLevel(context.Background(), "high") }()
	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "set_thinking_level" || frame["level"] != "high" {
		t.Fatalf("thinking command = %#v", frame)
	}
	if got := w.ThinkingLevel(); got != "low" {
		t.Fatalf("thinking level before acknowledgement = %q, want low", got)
	}
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_thinking_level", "success": true,
		"data": map[string]any{"thinkingLevel": "high"},
	}); err != nil {
		t.Fatalf("write thinking response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("SetThinkingLevel: %v", err)
	}
	if got := w.ThinkingLevel(); got != "high" {
		t.Fatalf("thinking level = %q, want high", got)
	}
	if got := w.AgentModel().ModelCfg; !got.Think || got.ReasoningEffort != "high" {
		t.Fatalf("model thinking config = %#v", got)
	}
}

func TestSetThinkingLevelCommitsBackendEffectiveLevel(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.model = AgentModel{ModelCfg: config.SelectedModel{Provider: "openai", Model: "gpt", Think: true, ReasoningEffort: "low"}}
	w.thinkingLevel = "low"

	result := make(chan error, 1)
	go func() { result <- w.SetThinkingLevel(context.Background(), "high") }()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_thinking_level", "success": true,
		"data": map[string]any{"thinkingLevel": "medium"},
	}); err != nil {
		t.Fatalf("write thinking response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("SetThinkingLevel: %v", err)
	}
	if got := w.ThinkingLevel(); got != "medium" {
		t.Fatalf("thinking level = %q, want backend-effective medium", got)
	}
	if got := w.AgentModel().ModelCfg; !got.Think || got.ReasoningEffort != "medium" {
		t.Fatalf("model thinking config = %#v", got)
	}
}

func TestSetThinkingLevelNullClearsState(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.model = AgentModel{ModelCfg: config.SelectedModel{Provider: "openai", Model: "gpt", Think: true, ReasoningEffort: "high"}}
	w.thinkingLevel = "high"

	result := make(chan error, 1)
	go func() { result <- w.SetThinkingLevel(context.Background(), "off") }()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_thinking_level", "success": true,
		"data": map[string]any{"thinkingLevel": nil},
	}); err != nil {
		t.Fatalf("write thinking response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("SetThinkingLevel: %v", err)
	}
	if got := w.ThinkingLevel(); got != "" {
		t.Fatalf("thinking level = %q, want cleared", got)
	}
	if got := w.AgentModel().ModelCfg; got.Think || got.ReasoningEffort != "" {
		t.Fatalf("model thinking config = %#v", got)
	}
}

func TestSetThinkingLevelMalformedReceiptLeavesStateUnchanged(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.model = AgentModel{ModelCfg: config.SelectedModel{Provider: "openai", Model: "gpt", Think: true, ReasoningEffort: "medium"}}
	w.thinkingLevel = "medium"
	before := w.AgentModel()

	result := make(chan error, 1)
	go func() { result <- w.SetThinkingLevel(context.Background(), "high") }()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_thinking_level", "success": true,
		"data": map[string]any{},
	}); err != nil {
		t.Fatalf("write malformed response: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("malformed receipt succeeded")
	}
	if got := w.ThinkingLevel(); got != "medium" || !reflect.DeepEqual(w.AgentModel(), before) {
		t.Fatalf("malformed receipt changed state: level=%q model=%#v", got, w.AgentModel())
	}
}

func TestSetThinkingLevelFailureAndRejectionLeaveStateUnchanged(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	w.model = AgentModel{ModelCfg: config.SelectedModel{Provider: "openai", Model: "gpt", Think: true, ReasoningEffort: "medium"}}
	w.thinkingLevel = "medium"
	before := w.AgentModel()

	if err := w.SetThinkingLevel(context.Background(), "invalid"); err == nil {
		t.Fatal("unsupported level succeeded")
	}
	if got := w.ThinkingLevel(); got != "medium" || !reflect.DeepEqual(w.AgentModel(), before) {
		t.Fatalf("unsupported level changed state: level=%q model=%#v", got, w.AgentModel())
	}

	result := make(chan error, 1)
	go func() { result <- w.SetThinkingLevel(context.Background(), "off") }()
	frame := pc.waitForFrame(t, 2*time.Second)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "set_thinking_level", "success": false, "error": "rejected",
	}); err != nil {
		t.Fatalf("write rejected response: %v", err)
	}
	if err := <-result; err == nil {
		t.Fatal("rejected level succeeded")
	}
	if got := w.ThinkingLevel(); got != "medium" || !reflect.DeepEqual(w.AgentModel(), before) {
		t.Fatalf("rejected level changed state: level=%q model=%#v", got, w.AgentModel())
	}
}

func TestSetThinkingLevelWaitsForModelSelectionReceipt(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, ModelCatalog{
		Models: []ModelCatalogEntry{
			{Provider: "old", ID: "old-model", Name: "Old", Available: true, Current: true, Roles: []string{"default"}},
			{Provider: "new", ID: "new-model", Name: "New", Available: true},
		},
		Roles:   []ModelCatalogRole{{Role: "default", Provider: "old", ModelID: "old-model", Selector: "old/old-model"}},
		Current: &ModelCatalogModel{Provider: "old", ID: "old-model", Name: "Old"},
	})
	w.mu.Lock()
	w.setThinkingLevelLocked("low")
	w.mu.Unlock()

	selectionDone := make(chan error, 1)
	go func() {
		_, err := w.SelectModel(context.Background(), ModelSelection{Role: "default", Provider: "new", ModelID: "new-model"})
		selectionDone <- err
	}()
	selectionFrame := pc.waitForFrame(t, 2*time.Second)
	if selectionFrame["type"] != "set_model" {
		t.Fatalf("first command = %#v, want set_model", selectionFrame)
	}

	thinkingCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	thinkingDone := make(chan error, 1)
	go func() { thinkingDone <- w.SetThinkingLevel(thinkingCtx, "high") }()
	if err := <-thinkingDone; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("interleaved thinking call = %v, want deadline exceeded", err)
	}
	if frames := pc.frames(); len(frames) != 1 {
		t.Fatalf("thinking command bypassed pending model receipt: %#v", frames)
	}

	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": selectionFrame["id"], "command": "set_model", "success": true,
		"data": map[string]any{
			"provider": "new", "id": "new-model", "name": "New", "input": []string{"text"},
			"assignment":    map[string]any{"role": "default", "provider": "new", "modelId": "new-model", "selector": "new/new-model"},
			"activeModel":   map[string]any{"provider": "new", "id": "new-model", "name": "New", "input": []string{"text"}},
			"thinkingLevel": "low",
		},
	}); err != nil {
		t.Fatalf("write selection response: %v", err)
	}
	if err := <-selectionDone; err != nil {
		t.Fatalf("SelectModel: %v", err)
	}
	if got := w.ThinkingLevel(); got != "low" {
		t.Fatalf("selection receipt thinking level = %q, want low", got)
	}
}

func TestSyncInitialSnapshotAppliesBackendThinkingLevel(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	finished := make(chan struct{})
	go func() {
		if err := w.SyncInitialSnapshot(context.Background()); err != nil {
			t.Errorf("SyncInitialSnapshot: %v", err)
		}
		close(finished)
	}()

	stateFrame := waitForCatalogFrame(t, pc, 0)
	if stateFrame["type"] != "get_state" {
		t.Fatalf("state command = %#v", stateFrame)
	}
	frameCount := len(pc.frames())
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": stateFrame["id"], "command": "get_state", "success": true,
		"data": map[string]any{
			"sessionId":     "session-1",
			"model":         map[string]any{"provider": "openai", "id": "gpt"},
			"thinkingLevel": "high",
		},
	}); err != nil {
		t.Fatalf("write state response: %v", err)
	}
	messagesFrame := waitForCatalogFrame(t, pc, frameCount)
	if messagesFrame["type"] != "get_messages" {
		t.Fatalf("messages command = %#v", messagesFrame)
	}
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": messagesFrame["id"], "command": "get_messages", "success": true,
		"data": map[string]any{"messages": []any{}},
	}); err != nil {
		t.Fatalf("write messages response: %v", err)
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("syncState did not finish")
	}
	if got := w.ThinkingLevel(); got != "high" {
		t.Fatalf("thinking level = %q, want high", got)
	}
	if got := w.AgentModel().ModelCfg; !got.Think || got.ReasoningEffort != "high" {
		t.Fatalf("model thinking config = %#v", got)
	}
}

func TestSyncStateUsesRichBackendModelSnapshot(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	seedModelCatalog(t, w, ModelCatalog{
		Models: []ModelCatalogEntry{{Provider: "openai", ID: "gpt", Current: true}},
		Roles:  []ModelCatalogRole{{Role: "default", Provider: "openai", ModelID: "gpt"}},
		Current: &ModelCatalogModel{
			Provider:      "openai",
			ID:            "gpt",
			Name:          "GPT",
			ContextWindow: 200000,
			MaxTokens:     8192,
			Reasoning:     true,
			Input:         []string{"text", "image"},
			Thinking:      &ModelCatalogThinking{MinLevel: "low", MaxLevel: "high", DefaultLevel: "medium"},
		},
	})

	result := make(chan error, 1)
	go func() { result <- w.syncState(context.Background()) }()
	frame := waitForCatalogFrame(t, pc, 0)
	if err := pc.writeInbound(map[string]any{
		"type": "response", "id": frame["id"], "command": "get_state", "success": true,
		"data": map[string]any{
			"model": map[string]any{
				"provider": "openai", "id": "gpt", "name": "GPT", "contextWindow": 200000,
				"maxTokens": 8192, "reasoning": true, "input": []string{"text", "image"},
				"thinking": map[string]any{"minLevel": "low", "maxLevel": "high", "defaultLevel": "medium"},
			},
			"thinkingLevel": "high",
		},
	}); err != nil {
		t.Fatalf("write state response: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("syncState: %v", err)
	}
	model := w.AgentModel()
	if model.CatwalkCfg.ContextWindow != 200000 || !model.CatwalkCfg.SupportsImages || !model.ModelCfg.Think || model.ModelCfg.ReasoningEffort != "high" {
		t.Fatalf("state sync discarded backend metadata: %#v", model)
	}
	if !w.AgentIsReady() {
		t.Fatal("workspace not ready after backend model sync")
	}
}

func TestSyncInitialSnapshotReturnsCallerDeadline(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := w.SyncInitialSnapshot(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SyncInitialSnapshot error = %v, want deadline exceeded", err)
	}
	frame := pc.waitForFrame(t, time.Second)
	if frame["type"] != "get_state" {
		t.Fatalf("first snapshot command = %#v, want get_state", frame)
	}
	if len(pc.frames()) != 1 {
		t.Fatalf("expired state request sent extra commands: %#v", pc.frames())
	}
}

func TestNewGmpWorkspaceDoesNotSyncUntilRequested(t *testing.T) {
	pc := newPipeClient(t)
	defer pc.close()
	cwd := t.TempDir()
	constructed := make(chan *GmpWorkspace, 1)
	go func() { constructed <- NewGmpWorkspace(pc.Client, cwd) }()
	select {
	case <-constructed:
	case <-time.After(testEventTimeout):
		t.Fatal("constructor performed backend I/O")
	}
	if frames := pc.frames(); len(frames) != 0 {
		t.Fatalf("constructor performed backend I/O: %#v", frames)
	}
}
