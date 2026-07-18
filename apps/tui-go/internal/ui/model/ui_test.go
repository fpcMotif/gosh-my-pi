package model

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/dialog"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/util"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
	"github.com/stretchr/testify/require"
)

func TestCurrentModelSupportsImages(t *testing.T) {
	t.Parallel()

	t.Run("returns false before the agent is ready", func(t *testing.T) {
		t.Parallel()

		ui := newTestUIWithConfig(t, nil)
		require.False(t, ui.currentModelSupportsImages())
	})

	t.Run("returns false when the agent model lacks image input", func(t *testing.T) {
		t.Parallel()

		ui := &UI{com: &common.Common{Workspace: &testWorkspace{
			ready:      true,
			agentModel: workspace.AgentModel{CatwalkCfg: catwalk.Model{SupportsImages: false}},
		}}}
		require.False(t, ui.currentModelSupportsImages())
	})

	t.Run("returns true when current model supports images", func(t *testing.T) {
		t.Parallel()

		ui := &UI{com: &common.Common{Workspace: &testWorkspace{
			ready:      true,
			agentModel: workspace.AgentModel{CatwalkCfg: catwalk.Model{SupportsImages: true}},
		}}}
		require.True(t, ui.currentModelSupportsImages())
	})
}

func TestNewUsesBackendReadinessForOnboarding(t *testing.T) {
	t.Parallel()

	emptyProviders := csync.NewMap[string, config.ProviderConfig]()
	ready := New(common.DefaultCommon(&testWorkspace{
		cfg:   &config.Config{Providers: emptyProviders, Options: &config.Options{TUI: &config.TUIOptions{}}},
		ready: true,
	}), "", false)
	require.Equal(t, uiLanding, ready.state)

	localProviders := csync.NewMap[string, config.ProviderConfig]()
	localProviders.Set("stale-local", config.ProviderConfig{ID: "stale-local"})
	notReady := New(common.DefaultCommon(&testWorkspace{
		cfg: &config.Config{Providers: localProviders, Options: &config.Options{TUI: &config.TUIOptions{}}},
	}), "", false)
	require.Equal(t, uiOnboarding, notReady.state)
}

func TestModelInfoFallsBackToAgentModelProvider(t *testing.T) {
	t.Parallel()

	ws := &testWorkspace{
		ready: true,
		agentModel: workspace.AgentModel{
			CatwalkCfg: catwalk.Model{ID: "test-model", Name: "Test Model"},
			ModelCfg:   config.SelectedModel{Provider: "test-provider", Model: "test-model"},
		},
	}
	ui := &UI{com: common.DefaultCommon(ws)}

	require.True(t, strings.Contains(ui.modelInfo(80), "test-provider"))
}

func TestEditorSendMessageMatchesReturnKeyEncodings(t *testing.T) {
	t.Parallel()

	keyMap := DefaultKeyMap()
	messages := []tea.KeyPressMsg{
		tea.KeyPressMsg(tea.Key{Code: tea.KeyEnter}),
		tea.KeyPressMsg(tea.Key{Code: 'm', Mod: tea.ModCtrl}),
	}

	for _, msg := range messages {
		require.True(t, key.Matches(msg, keyMap.Editor.SendMessage), "expected %q to send message", msg.String())
		require.False(t, key.Matches(msg, keyMap.Editor.Newline), "expected %q not to insert newline", msg.String())
	}
}

func TestEditorCtrlMSubmitsPrompt(t *testing.T) {
	providers := csync.NewMap[string, config.ProviderConfig]()
	providers.Set("test-provider", config.ProviderConfig{ID: "test-provider"})
	cfg := &config.Config{
		Providers: providers,
		Options: &config.Options{
			TUI: &config.TUIOptions{},
		},
	}

	ui := New(common.DefaultCommon(&testWorkspace{cfg: cfg, ready: true}), "", false)
	ui.textarea.SetValue("quit")

	cmd := ui.handleKeyPressMsg(tea.KeyPressMsg(tea.Key{Code: 'm', Mod: tea.ModCtrl}))

	require.Nil(t, cmd)
	require.True(t, ui.dialog.ContainsDialog(dialog.QuitID))
	require.False(t, ui.dialog.ContainsDialog(dialog.ModelsID))
	require.Empty(t, ui.textarea.Value())
}

func TestFirstPromptCreatesSessionBeforeAgentRun(t *testing.T) {
	cfg := &config.Config{Options: &config.Options{TUI: &config.TUIOptions{}}}
	ws := &firstPromptWorkspace{
		testWorkspace:  testWorkspace{cfg: cfg, ready: true},
		createdSession: session.Session{ID: "session-1", Title: "New Session"},
	}
	ui := New(common.DefaultCommon(ws), "", false)

	createCmd := ui.sendMessage("hello")
	require.NotNil(t, createCmd)
	require.Zero(t, ws.createCalls)
	require.Zero(t, ws.runCalls)
	require.IsType(t, util.InfoMsg{}, ui.sendMessage("duplicate")())
	require.Zero(t, ws.createCalls)

	created := createCmd()
	require.IsType(t, sessionCreationResultMsg{}, created)
	require.Equal(t, 1, ws.createCalls)
	require.Zero(t, ws.runCalls)

	_, runCmd := ui.Update(created)
	require.NotNil(t, runCmd)
	require.Equal(t, "session-1", ui.session.ID)
	require.Zero(t, ws.runCalls)

	batch, ok := runCmd().(tea.BatchMsg)
	require.True(t, ok)
	for _, cmd := range batch {
		cmd()
	}
	require.Equal(t, 1, ws.runCalls)
	require.Equal(t, "session-1", ws.runSessionID)
	require.Equal(t, "hello", ws.runPrompt)
}

func TestCancelledSessionCreationDoesNotRunPrompt(t *testing.T) {
	cfg := &config.Config{Options: &config.Options{TUI: &config.TUIOptions{}}}
	ws := &firstPromptWorkspace{
		testWorkspace: testWorkspace{cfg: cfg, ready: true},
		createErr:     workspace.ErrSessionCreationCancelled,
	}
	ui := New(common.DefaultCommon(ws), "", false)

	created := ui.sendMessage("do not send")()
	_, cmd := ui.Update(created)

	require.Nil(t, cmd)
	require.Nil(t, ui.session)
	require.Zero(t, ws.runCalls)
}

func TestCancelAgentRunsOffUpdateLoop(t *testing.T) {
	cfg := &config.Config{Options: &config.Options{TUI: &config.TUIOptions{}}}
	ws := &firstPromptWorkspace{testWorkspace: testWorkspace{cfg: cfg, ready: true}}
	ui := New(common.DefaultCommon(ws), "", false)
	ui.session = &session.Session{ID: "session-1"}
	ui.isCanceling = true

	cmd := ui.cancelAgent()
	require.NotNil(t, cmd)
	require.Zero(t, ws.cancelCalls)
	require.Nil(t, cmd())
	require.Equal(t, 1, ws.cancelCalls)
}

type firstPromptWorkspace struct {
	testWorkspace
	createdSession session.Session
	createErr      error
	createCalls    int
	runCalls       int
	runSessionID   string
	runPrompt      string
	cancelCalls    int
}

func (w *firstPromptWorkspace) CreateSession(context.Context, string) (session.Session, error) {
	w.createCalls++
	return w.createdSession, w.createErr
}

func (w *firstPromptWorkspace) AgentRun(
	_ context.Context,
	sessionID string,
	prompt string,
	_ ...message.Attachment,
) error {
	w.runCalls++
	w.runSessionID = sessionID
	w.runPrompt = prompt
	return nil
}

func (w *firstPromptWorkspace) AgentCancel(context.Context, string) error {
	w.cancelCalls++
	return nil
}

func newTestUIWithConfig(t *testing.T, cfg *config.Config) *UI {
	t.Helper()

	return &UI{
		com: &common.Common{
			Workspace: &testWorkspace{cfg: cfg},
		},
	}
}

// testWorkspace is a minimal [workspace.Workspace] stub for unit tests.
type testWorkspace struct {
	workspace.Workspace
	cfg        *config.Config
	ready      bool
	agentModel workspace.AgentModel
}

func (w *testWorkspace) Config() *config.Config {
	return w.cfg
}

func (w *testWorkspace) ProjectNeedsInitialization() (bool, error) {
	return false, nil
}

func (w *testWorkspace) AgentIsReady() bool { return w.ready }

func (w *testWorkspace) AgentModel() workspace.AgentModel { return w.agentModel }

func (w *testWorkspace) AgentIsBusy() bool { return false }

func (w *testWorkspace) PermissionSkipRequests() bool { return false }

// TestOpenAuthenticationDialog_DispatchesGmpAuth asserts the
// gmp-only contract from ADR 0002: openAuthenticationDialog
// dispatches through runGmpAuthCommand → SendAuthCommand. The
// legacy Crush auth dialogs (NewAPIKeyInput / NewOAuthHyper /
// NewOAuthCopilot) and the non-gmp branch were deleted in
// carve-out Phase 1 lite — there is no path that opens them.
func TestOpenAuthenticationDialog_DispatchesGmpAuth(t *testing.T) {
	t.Parallel()

	outboundReader, outboundWriter := io.Pipe()
	inboundReader, inboundWriter := io.Pipe()
	client := ompclient.NewWithIO(outboundWriter, inboundReader)
	t.Cleanup(func() {
		_ = inboundWriter.Close()
		_ = client.Close()
		_ = outboundReader.Close()
	})

	frames := make(chan ompclient.Command, 1)
	go func() {
		scanner := bufio.NewScanner(outboundReader)
		if !scanner.Scan() {
			return
		}
		var frame ompclient.Command
		if json.Unmarshal(scanner.Bytes(), &frame) == nil {
			frames <- frame
		}
	}()

	ui := New(common.DefaultCommon(workspace.NewGmpWorkspace(client, "")), "", false)

	// Pick a provider that historically routed to NewAPIKeyInput
	// (openai is not "hyper" / not catwalk.InferenceProviderCopilot).
	prov := catwalk.Provider{ID: "openai", Name: "OpenAI"}
	cmd := ui.openAuthenticationDialog(prov, config.SelectedModel{}, config.SelectedModelTypeLarge)

	require.NotNil(t, cmd, "openAuthenticationDialog should produce a gmp auth dispatch cmd")
	result := make(chan tea.Msg, 1)
	go func() { result <- cmd() }()

	select {
	case frame := <-frames:
		require.Equal(t, auth.CommandLogin, frame.Type)
		require.Equal(t, "openai", frame.Provider)
		require.NotEmpty(t, frame.ID)
		require.NoError(t, json.NewEncoder(inboundWriter).Encode(map[string]any{
			"type":    "response",
			"id":      frame.ID,
			"command": auth.CommandLogin,
			"success": true,
		}))
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for auth.login RPC frame")
	}

	select {
	case msg := <-result:
		require.Nil(t, msg)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for auth.login RPC acknowledgement")
	}
	// GmpAuth dialog opens later, when the backend's first
	// extension_ui_request frame arrives — not synchronously here.
	require.False(t, ui.dialog.ContainsDialog(dialog.GmpAuthID), "GmpAuth dialog should be opened by the inbound frame, not the dispatch")
}

func TestPendingGmpModelSelectionStopsOnAuthTerminalFailure(t *testing.T) {
	t.Parallel()

	providers := csync.NewMap[string, config.ProviderConfig]()
	cfg := &config.Config{
		Providers: providers,
		Options:   &config.Options{TUI: &config.TUIOptions{}},
	}
	ui := New(common.DefaultCommon(&testWorkspace{cfg: cfg}), "", false)
	action := dialog.ActionSelectModel{
		Model:          config.SelectedModel{Provider: "openai", Model: "gpt-5"},
		ModelType:      config.SelectedModelTypeLarge,
		ReAuthenticate: true,
	}

	ui.handleGmpModelSelectionResult(gmpModelSelectionResultMsg{
		action:        action,
		loginProvider: "openai",
	})
	require.NotNil(t, ui.pendingGmpModelSelection)
	require.False(t, ui.pendingGmpModelSelection.action.ReAuthenticate)

	_, _ = ui.Update(auth.ShowResult{Success: false, Error: "cancelled"})
	require.Nil(t, ui.pendingGmpModelSelection)

	pending := action
	ui.pendingGmpModelSelection = &pendingGmpModelSelection{action: pending, provider: "openai"}
	_, _ = ui.Update(auth.Cancel{})
	require.Nil(t, ui.pendingGmpModelSelection)

	ui.pendingGmpModelSelection = &pendingGmpModelSelection{action: pending, provider: "openai"}
	_, _ = ui.Update(gmpPendingModelAuthResultMsg{})
	require.Nil(t, ui.pendingGmpModelSelection)

	ui.pendingGmpModelSelection = &pendingGmpModelSelection{action: pending, provider: "openai"}
	_, _ = ui.Update(auth.ShowResult{Success: true, Provider: "anthropic"})
	require.Nil(t, ui.pendingGmpModelSelection)

	cmd := ui.handleGmpModelSelectionResult(gmpModelSelectionResultMsg{
		action:         action,
		loginProvider:  "openai",
		retryAttempted: true,
	})
	require.NotNil(t, cmd)
	require.Nil(t, ui.pendingGmpModelSelection)
}

func TestGmpCatalogRole(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		modelType config.SelectedModelType
		want      string
		wantErr   bool
	}{
		{name: "large uses backend default", modelType: config.SelectedModelTypeLarge, want: "default"},
		{name: "small uses backend smol", modelType: config.SelectedModelTypeSmall, want: "smol"},
		{name: "unknown rejected", modelType: "other", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := gmpCatalogRole(tt.modelType)
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}

func TestGmpCatalogResultRejectsStaleEpoch(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		Providers: csync.NewMap[string, config.ProviderConfig](),
		Options:   &config.Options{TUI: &config.TUIOptions{}},
	}
	ui := New(common.DefaultCommon(&testWorkspace{cfg: cfg}), "", false)
	ui.modelCatalogRequestEpoch = 2

	_, _ = ui.Update(gmpModelCatalogResultMsg{epoch: 1})
	require.False(t, ui.dialog.ContainsDialog(dialog.ModelsID))
}

func TestOpenPermissionsDialog_DeniesSupersededToolApproval(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		Models:    map[config.SelectedModelType]config.SelectedModel{},
		Providers: csync.NewMap[string, config.ProviderConfig](),
		Options:   &config.Options{TUI: &config.TUIOptions{}},
	}
	ws := &toolApprovalReplyWorkspace{testWorkspace: testWorkspace{cfg: cfg}}
	ui := New(common.DefaultCommon(ws), "", false)

	require.Nil(t, ui.openPermissionsDialog(permission.PermissionRequest{ID: "approval-1", ToolName: "bash"}))
	require.Empty(t, ws.replies)

	cmd := ui.openPermissionsDialog(permission.PermissionRequest{ID: "approval-2", ToolName: "write"})
	require.NotNil(t, cmd)
	result := cmd()
	require.IsType(t, toolApprovalReplyResultMsg{}, result)
	_, _ = ui.Update(result)
	require.Len(t, ws.replies, 1)
	require.Equal(t, "approval-1", ws.replies[0].id)
	require.False(t, ws.replies[0].approved)
	require.NotNil(t, ui.pendingToolApproval)
	require.Equal(t, "approval-2", ui.pendingToolApproval.ID)
}

func TestToolApprovalSendFailureReopensPendingDialog(t *testing.T) {
	t.Parallel()
	cfg := &config.Config{Options: &config.Options{TUI: &config.TUIOptions{}}}
	ws := &toolApprovalReplyWorkspace{
		testWorkspace: testWorkspace{cfg: cfg},
		err:           errors.New("pipe closed"),
	}
	ui := New(common.DefaultCommon(ws), "", false)
	perm := permission.PermissionRequest{ID: "approval-1", ToolCallID: "tool-1", ToolName: "bash"}
	ui.pendingToolApproval = &perm

	result := sendToolApprovalReply(ws, perm, true)()
	_, cmd := ui.Update(result)

	require.NotNil(t, cmd)
	require.NotNil(t, ui.pendingToolApproval)
	require.Equal(t, "approval-1", ui.pendingToolApproval.ID)
	require.True(t, ui.dialog.ContainsDialog(dialog.PermissionsID))
}

type toolApprovalReply struct {
	id       string
	approved bool
}

type toolApprovalReplyWorkspace struct {
	testWorkspace
	replies []toolApprovalReply
	err     error
}

func (w *toolApprovalReplyWorkspace) HandleToolApprovalReply(perm permission.PermissionRequest, approved bool) error {
	w.replies = append(w.replies, toolApprovalReply{id: perm.ID, approved: approved})
	return w.err
}
