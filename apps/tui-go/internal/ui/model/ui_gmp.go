package model

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/dialog"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/util"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/workspace"
)

type toolApprovalReplyHandler interface {
	HandleToolApprovalReply(permission.PermissionRequest, bool)
}

func (m *UI) handleGmpSelectModel(gw *workspace.GmpWorkspace, msg dialog.ActionSelectModel) tea.Cmd {
	entry, ok := gw.ModelCatalogEntry(msg.Model.Provider, msg.Model.Model)
	if !ok {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := gw.RefreshModelCatalog(ctx); err != nil {
			return util.ReportError(err)
		}
		entry, ok = gw.ModelCatalogEntry(msg.Model.Provider, msg.Model.Model)
	}
	if ok && (!entry.Available || msg.ReAuthenticate) {
		if !entry.LoginAvailable {
			return util.ReportError(fmt.Errorf("model unavailable: %s/%s", msg.Model.Provider, msg.Model.Model))
		}
		pending := msg
		m.pendingGmpModelSelection = &pending
		m.dialog.CloseDialog(dialog.ModelsID)
		return m.runGmpAuthCommand(auth.CommandLogin, entry.Provider)
	}
	return m.applyGmpModelSelection(gw, msg)
}

func (m *UI) applyGmpModelSelection(gw *workspace.GmpWorkspace, msg dialog.ActionSelectModel) tea.Cmd {
	var cmds []tea.Cmd
	isOnboarding := m.state == uiOnboarding
	providerID := msg.Model.Provider

	if err := gw.UpdatePreferredModel(config.ScopeGlobal, msg.ModelType, msg.Model); err != nil {
		return util.ReportError(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := gw.RefreshModelCatalog(ctx); err != nil {
		cmds = append(cmds, util.ReportError(err))
	}
	cancel()

	if msg.ModelType == config.SelectedModelTypeLarge {
		m.applyProviderTheme(providerID)
	}

	m.dialog.CloseDialog(dialog.GmpAuthID)
	m.dialog.CloseDialog(dialog.ModelsID)

	if isOnboarding {
		m.setState(uiLanding, uiFocusEditor)
		m.com.Config().SetupAgents()
		if err := gw.InitCoderAgent(context.TODO()); err != nil {
			cmds = append(cmds, util.ReportError(err))
		}
	}

	modelMsg := fmt.Sprintf("%s model changed to %s", msg.ModelType, msg.Model.Model)
	cmds = append(cmds, util.ReportInfo(modelMsg))
	return tea.Batch(cmds...)
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
	pending := *m.pendingGmpModelSelection
	m.pendingGmpModelSelection = nil
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := gw.RefreshModelCatalog(ctx); err != nil {
		return util.ReportError(err)
	}
	return m.handleGmpSelectModel(gw, pending)
}

func (m *UI) openAuthenticationDialog(provider catwalk.Provider, _ config.SelectedModel, _ config.SelectedModelType) tea.Cmd {
	// apps/tui-go is gmp-only (ADR 0002). Auth always flows through
	// the RPC bridge: dispatch auth.login, the gmp backend drives the
	// flow back via extension_ui_request frames into the GmpAuth
	// dialog. The legacy Crush dialogs (NewAPIKeyInput / NewOAuthHyper
	// / NewOAuthCopilot) and the IsGmpMode == false branch were
	// removed in carve-out Phase 1 lite — they wrote to local
	// crush.json which is the wrong store for this fork.
	return m.runGmpAuthCommand(auth.CommandLogin, string(provider.ID))
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
	if gw, ok := m.com.Workspace.(toolApprovalReplyHandler); ok {
		if prev := m.pendingToolApproval; prev != nil && prev.ID != "" && prev.ID != perm.ID {
			gw.HandleToolApprovalReply(*prev, false)
		}
		if perm.ID != "" {
			superseded := perm
			m.pendingToolApproval = &superseded
		} else {
			m.pendingToolApproval = nil
		}
	}

	// Close any existing permissions dialog first.
	m.dialog.CloseDialog(dialog.PermissionsID)

	// Get diff mode from config.
	var opts []dialog.PermissionsOption
	if diffMode := m.com.Config().Options.TUI.DiffMode; diffMode != "" {
		opts = append(opts, dialog.WithDiffMode(diffMode == "split"))
	}

	permDialog := dialog.NewPermissions(m.com, perm, opts...)
	m.dialog.OpenDialog(permDialog)
	return nil
}
