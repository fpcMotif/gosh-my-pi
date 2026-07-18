package model

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/chat"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/dialog"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/util"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

type toolApprovalReplyHandler interface {
	HandleToolApprovalReply(permission.PermissionRequest, bool) error
}

type toolApprovalReplyResultMsg struct {
	permission permission.PermissionRequest
	approved   bool
	err        error
}

func sendToolApprovalReply(
	handler toolApprovalReplyHandler,
	perm permission.PermissionRequest,
	approved bool,
) tea.Cmd {
	return func() tea.Msg {
		return toolApprovalReplyResultMsg{
			permission: perm,
			approved:   approved,
			err:        handler.HandleToolApprovalReply(perm, approved),
		}
	}
}

// gmpModelSelectionResultMsg carries the outcome of the off-loop model
// selection round-trips back into Update.
type gmpModelSelectionResultMsg struct {
	action         dialog.ActionSelectModel
	loginProvider  string // non-empty: provider needs auth before the selection can apply
	retryAttempted bool
	applied        bool
	err            error
}

// pendingGmpModelSelection is a single login continuation. Reauth is cleared
// before storage; a post-login retry gets no second login attempt.
type pendingGmpModelSelection struct {
	action   dialog.ActionSelectModel
	provider string
}

func (m *UI) assistantModelDisplayInfo(msg *message.Message) chat.ModelDisplayInfo {
	display := chat.ModelDisplayInfo{
		ModelName:    msg.Model,
		ProviderName: msg.Provider,
	}
	gw, ok := m.com.Workspace.(*workspace.GmpWorkspace)
	if !ok {
		return display
	}
	for _, entry := range gw.ModelCatalog().Models {
		if entry.Provider != msg.Provider || entry.ID != msg.Model {
			continue
		}
		if entry.Name != "" {
			display.ModelName = entry.Name
		}
		if entry.ProviderName != "" {
			display.ProviderName = entry.ProviderName
		}
		break
	}
	return display
}

// gmpModelCatalogResultMsg carries the outcome of an off-loop catalog refresh.
// Update owns dialog state; the command only fetches a snapshot.
type gmpModelCatalogResultMsg struct {
	catalog      workspace.ModelCatalog
	isOnboarding bool
	epoch        uint64
	err          error
}

// gmpPendingModelAuthResultMsg reports a failed login dispatch. The pending
// selection must not survive a command that never reached the backend.
type gmpPendingModelAuthResultMsg struct {
	err error
}

// handleGmpSelectModel dispatches the catalog lookup / refresh / set_model
// round-trips to a tea.Cmd goroutine: they block on the backend, and running
// them inside Update freezes every keystroke (including Esc) whenever the
// backend is slow or wedged.
func (m *UI) handleGmpSelectModel(gw *workspace.GmpWorkspace, msg dialog.ActionSelectModel) tea.Cmd {
	m.dialog.CloseDialog(dialog.ModelsID)
	m.invalidateGmpModelCatalogRequest()
	return func() tea.Msg { return resolveGmpModelSelection(gw, msg) }
}

// resolveGmpModelSelection performs the blocking catalog / set_model work.
// Runs off the update loop; must not touch UI state.
func resolveGmpModelSelection(
	gw *workspace.GmpWorkspace,
	msg dialog.ActionSelectModel,
) gmpModelSelectionResultMsg {
	role, err := gmpCatalogRole(msg.ModelType)
	if err != nil {
		return gmpModelSelectionResultMsg{action: msg, err: err}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := gw.SelectModel(ctx, workspace.ModelSelection{
		Role:           role,
		Provider:       msg.Model.Provider,
		ModelID:        msg.Model.Model,
		Reauthenticate: msg.ReAuthenticate,
	})
	if err != nil {
		return gmpModelSelectionResultMsg{action: msg, err: err}
	}
	if result.LoginProvider != "" {
		return gmpModelSelectionResultMsg{action: msg, loginProvider: result.LoginProvider}
	}
	return gmpModelSelectionResultMsg{action: msg, applied: true}
}

func gmpCatalogRole(modelType config.SelectedModelType) (string, error) {
	switch modelType {
	case config.SelectedModelTypeLarge:
		return "default", nil
	case config.SelectedModelTypeSmall:
		return "smol", nil
	default:
		return "", fmt.Errorf("unsupported model role: %s", modelType)
	}
}

// nextGmpThinkingLevel chooses the next backend-owned thinking level without
// consulting the legacy local model cache.
func nextGmpThinkingLevel(gw *workspace.GmpWorkspace) string {
	if current := gw.ThinkingLevel(); current != "" && current != "off" {
		return "off"
	}
	model := gw.AgentModel().CatwalkCfg
	if model.DefaultReasoningEffort != "" {
		return model.DefaultReasoningEffort
	}
	if len(model.ReasoningLevels) > 0 {
		return model.ReasoningLevels[0]
	}
	return "medium"
}

// setGmpThinkingLevel keeps the RPC round-trip outside Bubble Tea Update.
func setGmpThinkingLevel(gw *workspace.GmpWorkspace, level, label string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := gw.SetThinkingLevel(ctx, level); err != nil {
			return util.ReportError(err)()
		}
		effective := gw.ThinkingLevel()
		if label == "Thinking mode" {
			status := "enabled"
			if effective == "" || effective == "off" {
				status = "disabled"
			}
			return util.NewInfoMsg(label + " " + status)
		}
		if effective == "" || effective == "off" {
			return util.NewInfoMsg(label + " disabled")
		}
		return util.NewInfoMsg(label + " set to " + effective)
	}
}

// handleGmpModelSelectionResult applies the UI-side effects of a finished
// model selection: theme, dialogs, onboarding transition, status message.
func (m *UI) handleGmpModelSelectionResult(msg gmpModelSelectionResultMsg) tea.Cmd {
	if msg.err != nil {
		return util.ReportError(msg.err)
	}
	if msg.loginProvider != "" {
		if msg.retryAttempted {
			return util.ReportError(fmt.Errorf("model unavailable after login: %s/%s", msg.action.Model.Provider, msg.action.Model.Model))
		}
		pending := msg.action
		pending.ReAuthenticate = false
		m.pendingGmpModelSelection = &pendingGmpModelSelection{
			action:   pending,
			provider: msg.loginProvider,
		}
		return m.runGmpAuthForPendingModel(msg.loginProvider)
	}
	if !msg.applied {
		return nil
	}
	var cmds []tea.Cmd
	isOnboarding := m.state == uiOnboarding
	if msg.action.ModelType == config.SelectedModelTypeLarge {
		m.applyProviderTheme(msg.action.Model.Provider)
	}
	m.dialog.CloseDialog(dialog.GmpAuthID)
	m.dialog.CloseDialog(dialog.ModelsID)
	if isOnboarding {
		m.setState(uiLanding, uiFocusEditor)
		m.com.Config().SetupAgents()
		if gw, ok := m.com.Workspace.(*workspace.GmpWorkspace); ok {
			cmds = append(cmds, func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := gw.InitCoderAgent(ctx); err != nil {
					return util.InfoMsg{Type: util.InfoTypeError, Msg: err.Error()}
				}
				return nil
			})
		}
	}
	modelMsg := fmt.Sprintf("%s model changed to %s", msg.action.ModelType, msg.action.Model.Model)
	cmds = append(cmds, util.ReportInfo(modelMsg))
	return tea.Batch(cmds...)
}

func (m *UI) refreshGmpModelCatalog(isOnboarding bool) tea.Cmd {
	gw, ok := m.com.Workspace.(*workspace.GmpWorkspace)
	if !ok {
		return util.ReportError(fmt.Errorf("model catalog requires the gmp backend"))
	}
	m.modelCatalogRequestEpoch++
	epoch := m.modelCatalogRequestEpoch
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		catalog, err := gw.RefreshModelCatalog(ctx)
		return gmpModelCatalogResultMsg{catalog: catalog, isOnboarding: isOnboarding, epoch: epoch, err: err}
	}
}

func (m *UI) invalidateGmpModelCatalogRequest() {
	m.modelCatalogRequestEpoch++
}

func (m *UI) retryPendingGmpModelSelection() tea.Cmd {
	if m.pendingGmpModelSelection == nil {
		return nil
	}
	gw, ok := m.com.Workspace.(*workspace.GmpWorkspace)
	if !ok {
		m.pendingGmpModelSelection = nil
		return nil
	}
	pending := m.pendingGmpModelSelection.action
	m.pendingGmpModelSelection = nil
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := gw.RefreshModelCatalog(ctx); err != nil {
			return gmpModelSelectionResultMsg{action: pending, err: err}
		}
		result := resolveGmpModelSelection(gw, pending)
		result.retryAttempted = true
		return result
	}
}

func (m *UI) openAuthenticationDialog(provider catwalk.Provider, _ config.SelectedModel, _ config.SelectedModelType) tea.Cmd {
	// apps/tui-go is gmp-only (ADR 0002). Auth always flows through
	// the RPC bridge: dispatch auth.login, the gmp backend drives the
	// flow back via extension_ui_request frames into the GmpAuth
	// dialog. The legacy Crush dialogs (NewAPIKeyInput / NewOAuthHyper
	// / NewOAuthCopilot) and the removed local-config branch were
	// removed in carve-out Phase 1 lite — they wrote to local
	// crush.json which is the wrong store for this fork.
	return m.runGmpAuthCommand(auth.CommandLogin, string(provider.ID))
}

func (m *UI) runGmpAuthForPendingModel(provider string) tea.Cmd {
	gw, ok := m.com.Workspace.(*workspace.GmpWorkspace)
	if !ok {
		return func() tea.Msg {
			return gmpPendingModelAuthResultMsg{err: fmt.Errorf("auth.login requires the gmp backend")}
		}
	}
	return func() tea.Msg {
		if err := gw.SendAuthCommand(auth.CommandLogin, provider); err != nil {
			return gmpPendingModelAuthResultMsg{err: err}
		}
		return nil
	}
}

// runGmpAuthCommand sends an auth.login / auth.logout RPC command to the
// gmp backend if the active workspace is a GmpWorkspace; otherwise reports
// the limitation. The actual UI flow (dialogs) is driven by inbound
// extension_ui_request frames, not this command.
//
// Provider may be empty for auth.login — the backend emits a correlated
// auth.pick_provider extension_ui_request and the GmpAuth dialog drives
// the picker. See ADR 0002. auth.logout still requires an explicit
// provider id.
func (m *UI) runGmpAuthCommand(method string, provider string) tea.Cmd {
	gw, ok := m.com.Workspace.(*workspace.GmpWorkspace)
	if !ok {
		return util.ReportInfo(method + " requires the gmp backend (apps/tui-go in gmp mode)")
	}
	if provider == "" && method != auth.CommandLogin {
		return util.ReportInfo("usage: " + method + " <provider> (e.g. /logout openai-codex)")
	}
	return func() tea.Msg {
		if err := gw.SendAuthCommand(method, provider); err != nil {
			return util.InfoMsg{Type: util.InfoTypeError, Msg: method + " failed: " + err.Error()}
		}
		return nil
	}
}

// openOrUpdateGmpAuthDialog ensures a GmpAuth dialog is open and forwards
// the inbound auth.* message to it. Reused for every auth.* frame so the
// same dialog instance walks through ShowURL → PromptCode →
// ShowResult during a single login.
func (m *UI) openOrUpdateGmpAuthDialog(msg tea.Msg) tea.Cmd {
	dlg := m.dialog.Dialog(dialog.GmpAuthID)
	if dlg == nil {
		dlg = dialog.NewGmpAuth(m.com)
		m.dialog.OpenDialog(dlg)
	}
	action := dlg.HandleMsg(msg)
	if cmdAction, ok := action.(dialog.ActionCmd); ok {
		return cmdAction.Cmd
	}
	return nil
}

// openPermissionsDialog opens the permissions dialog for a permission request.
func (m *UI) openPermissionsDialog(perm permission.PermissionRequest) tea.Cmd {
	// In gmp bridge mode a still-open permission dialog corresponds to an
	// unanswered extension_ui_request on the wire. Opening a newer dialog
	// supersedes it, so deny the superseded request first — otherwise no
	// extension_ui_response is ever sent for it and the backend tool sits
	// pending until its multi-minute approval deadline.
	var reply tea.Cmd
	if gw, ok := m.com.Workspace.(toolApprovalReplyHandler); ok {
		if prev := m.pendingToolApproval; prev != nil && prev.ID != "" && prev.ID != perm.ID {
			reply = sendToolApprovalReply(gw, *prev, false)
		}
		if perm.ID != "" {
			superseded := perm
			m.pendingToolApproval = &superseded
		} else {
			m.pendingToolApproval = nil
		}
	}

	m.dialog.CloseDialog(dialog.PermissionsID)
	m.openPermissionDialog(perm)
	return reply
}

func (m *UI) openPermissionDialog(perm permission.PermissionRequest) {
	var opts []dialog.PermissionsOption
	if diffMode := m.com.Config().Options.TUI.DiffMode; diffMode != "" {
		opts = append(opts, dialog.WithDiffMode(diffMode == "split"))
	}

	permDialog := dialog.NewPermissions(m.com, perm, opts...)
	m.dialog.OpenDialog(permDialog)
}
