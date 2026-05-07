package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/notify"
	mcptools "github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/tools/mcp"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/auth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/history"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/lsp"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/oauth"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/permission"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
)

const (
	gmpProviderID       = "gmp"
	gmpModelID          = "gmp-backend"
	gmpToolSessionDelim = "$$"
)

var ErrUnsupported = errors.New("gmp backend: operation not supported in MVP")

// GmpWorkspace implements the Workspace interface by talking to an
// external `gmp --mode rpc` process over JSONL stdio.
type GmpWorkspace struct {
	client *ompclient.Client
	cwd    string
	cfg    *config.Config

	resolver config.VariableResolver

	mu                 sync.RWMutex
	session            session.Session
	messages           map[string]message.Message
	msgOrder           []string
	toolResultMessages map[string]string

	agentBusy          bool
	skipPermissions    bool
	currentAssistantID string
	msgCounter         atomic.Uint64

	model AgentModel

	program *tea.Program
	// events is a test-only seam: tests assign a buffered channel here and
	// drain it in nextMessageEvent. In production sendUI always uses program.
	events    chan tea.Msg
	closeOnce sync.Once
}

// NewGmpWorkspace creates a workspace backed by an omp RPC subprocess.
func NewGmpWorkspace(client *ompclient.Client, cwd string) *GmpWorkspace {
	cfg := newOmpConfig()
	w := &GmpWorkspace{
		client:             client,
		cwd:                cwd,
		cfg:                cfg,
		resolver:           config.IdentityResolver(),
		messages:           make(map[string]message.Message),
		toolResultMessages: make(map[string]string),
		model: AgentModel{
			CatwalkCfg: catwalk.Model{ID: gmpModelID, Name: "gmp backend"},
			ModelCfg:   cfg.Models[config.SelectedModelTypeLarge],
		},
	}
	// Best-effort initial state sync so the UI has a session ID immediately.
	if client != nil {
		w.syncState(context.Background())
	}
	return w
}

func (w *GmpWorkspace) nextID(prefix string) string {
	n := w.msgCounter.Add(1)
	return fmt.Sprintf("%s-%d", prefix, n)
}

func (w *GmpWorkspace) syncState(ctx context.Context) {
	if w.client == nil {
		return
	}
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "get_state"})
	if err != nil {
		slog.Debug("gmp workspace: failed to sync state", "error", err)
		return
	}
	var st struct {
		SessionID   string `json:"sessionId"`
		SessionName string `json:"sessionName"`
		Model       struct {
			Provider string `json:"provider"`
			ID       string `json:"id"`
		} `json:"model"`
	}
	if err := json.Unmarshal(resp.Data, &st); err != nil {
		return
	}
	w.mu.Lock()
	w.session.ID = st.SessionID
	if w.session.Title == "" {
		w.session.Title = st.SessionName
	}
	if st.Model.ID != "" {
		modelName := st.Model.ID
		w.model = AgentModel{
			CatwalkCfg: catwalk.Model{ID: st.Model.ID, Name: modelName},
			ModelCfg: config.SelectedModel{
				Provider: gmpProviderID,
				Model:    st.Model.ID,
			},
		}
	}
	w.mu.Unlock()
	w.syncMessages(ctx)
}

func (w *GmpWorkspace) syncMessages(ctx context.Context) {
	if w.client == nil {
		return
	}
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "get_messages"})
	if err != nil {
		slog.Debug("gmp workspace: failed to sync messages", "error", err)
		return
	}
	var payload struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(resp.Data, &payload); err != nil {
		return
	}
	msgs := make([]message.Message, 0, len(payload.Messages))
	for _, raw := range payload.Messages {
		msg, ok := w.parseAgentMessage(raw, "")
		if ok {
			msgs = append(msgs, msg)
		}
	}
	w.mu.Lock()
	w.messages = make(map[string]message.Message)
	w.msgOrder = nil
	w.toolResultMessages = make(map[string]string)
	w.currentAssistantID = ""
	for _, msg := range msgs {
		w.upsertMessageLocked(msg)
		if msg.Role == message.Assistant && !msg.IsFinished() {
			w.currentAssistantID = msg.ID
		}
	}
	w.mu.Unlock()
}

// -- Sessions --

func (w *GmpWorkspace) CreateSession(ctx context.Context, title string) (session.Session, error) {
	if w.client != nil {
		_, err := w.client.Call(ctx, ompclient.Command{Type: "new_session"})
		if err != nil {
			return session.Session{}, err
		}
		w.syncState(ctx)
	}

	w.mu.Lock()
	if w.session.ID == "" {
		w.ensureSessionLocked()
	}
	if title != "" {
		w.session.Title = title
	}
	w.session.UpdatedAt = time.Now().Unix()
	s := w.session
	w.messages = make(map[string]message.Message)
	w.msgOrder = nil
	w.toolResultMessages = make(map[string]string)
	w.currentAssistantID = ""
	w.mu.Unlock()
	w.sendUI(pubsub.Event[session.Session]{Type: pubsub.CreatedEvent, Payload: s})
	return s, nil
}

func (w *GmpWorkspace) GetSession(ctx context.Context, sessionID string) (session.Session, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.session.ID == "" {
		w.ensureSessionLocked()
	}
	return w.session, nil
}

func (w *GmpWorkspace) ListSessions(ctx context.Context) ([]session.Session, error) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.session.ID == "" {
		return nil, nil
	}
	return []session.Session{w.session}, nil
}

func (w *GmpWorkspace) SaveSession(ctx context.Context, sess session.Session) (session.Session, error) {
	w.mu.Lock()
	w.session = sess
	w.mu.Unlock()
	w.sendUI(pubsub.Event[session.Session]{Type: pubsub.UpdatedEvent, Payload: sess})
	return sess, nil
}

func (w *GmpWorkspace) DeleteSession(ctx context.Context, sessionID string) error {
	return ErrUnsupported
}

func (w *GmpWorkspace) CreateAgentToolSessionID(messageID, toolCallID string) string {
	return messageID + gmpToolSessionDelim + toolCallID
}

func (w *GmpWorkspace) ParseAgentToolSessionID(sessionID string) (string, string, bool) {
	i := strings.LastIndex(sessionID, gmpToolSessionDelim)
	if i < 0 {
		return "", "", false
	}
	return sessionID[:i], sessionID[i+len(gmpToolSessionDelim):], true
}

// -- Messages --

func (w *GmpWorkspace) ListMessages(ctx context.Context, sessionID string) ([]message.Message, error) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	out := make([]message.Message, 0, len(w.msgOrder))
	for _, id := range w.msgOrder {
		if m, ok := w.messages[id]; ok {
			out = append(out, m)
		}
	}
	return out, nil
}

func (w *GmpWorkspace) ListUserMessages(ctx context.Context, sessionID string) ([]message.Message, error) {
	msgs, err := w.ListMessages(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	var out []message.Message
	for _, m := range msgs {
		if m.Role == message.User {
			out = append(out, m)
		}
	}
	return out, nil
}

func (w *GmpWorkspace) ListAllUserMessages(ctx context.Context) ([]message.Message, error) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	var out []message.Message
	for _, id := range w.msgOrder {
		if m, ok := w.messages[id]; ok && m.Role == message.User {
			out = append(out, m)
		}
	}
	return out, nil
}

// -- Agent --

func (w *GmpWorkspace) AgentRun(ctx context.Context, sessionID, prompt string, attachments ...message.Attachment) error {
	now := time.Now().Unix()

	w.mu.Lock()
	if sessionID == "" {
		sessionID = w.ensureSessionLocked().ID
	}
	if w.session.ID == "" {
		w.session = session.Session{
			ID:        sessionID,
			Title:     "New Session",
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	user := message.Message{
		ID:        w.nextID("user"),
		SessionID: sessionID,
		Role:      message.User,
		CreatedAt: now,
		UpdatedAt: now,
		Parts:     []message.ContentPart{message.TextContent{Text: prompt}},
	}
	for _, attachment := range attachments {
		user.Parts = append(user.Parts, message.BinaryContent{
			Path:     attachment.FilePath,
			MIMEType: attachment.MimeType,
			Data:     attachment.Content,
		})
	}
	assistant := message.Message{
		ID:        w.nextID("assistant"),
		SessionID: sessionID,
		Role:      message.Assistant,
		Model:     w.model.ModelCfg.Model,
		Provider:  w.model.ModelCfg.Provider,
		CreatedAt: now,
		UpdatedAt: now,
	}
	w.currentAssistantID = assistant.ID
	w.agentBusy = true
	w.upsertMessageLocked(user)
	w.upsertMessageLocked(assistant)
	w.mu.Unlock()

	w.sendUI(pubsub.Event[message.Message]{Type: pubsub.CreatedEvent, Payload: user.Clone()})
	w.sendUI(pubsub.Event[message.Message]{Type: pubsub.CreatedEvent, Payload: assistant.Clone()})

	if w.client == nil {
		return nil
	}
	_, err := w.client.Call(ctx, ompclient.Command{
		Type:    "prompt",
		Message: message.PromptWithTextAttachments(prompt, attachments),
	})
	if err != nil {
		if msg := w.finishAssistant(message.FinishReasonError, err.Error(), ""); msg != nil {
			w.sendUI(msg)
		}
		w.setAgentBusy(false)
	}
	return err
}

func (w *GmpWorkspace) AgentCancel(sessionID string) {
	if w.client != nil {
		_, _ = w.client.Call(context.Background(), ompclient.Command{Type: "abort"})
	}
	if msg := w.finishAssistant(message.FinishReasonCanceled, "Request canceled", ""); msg != nil {
		w.sendUI(msg)
	}
	w.setAgentBusy(false)
}

func (w *GmpWorkspace) AgentIsBusy() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.agentBusy
}

func (w *GmpWorkspace) AgentIsSessionBusy(sessionID string) bool {
	return w.AgentIsBusy()
}

func (w *GmpWorkspace) AgentModel() AgentModel {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.model
}

func (w *GmpWorkspace) AgentIsReady() bool {
	return true
}

func (w *GmpWorkspace) AgentQueuedPrompts(sessionID string) int {
	return 0
}

func (w *GmpWorkspace) AgentQueuedPromptsList(sessionID string) []string {
	return nil
}

func (w *GmpWorkspace) AgentClearQueue(sessionID string) {}

func (w *GmpWorkspace) AgentSummarize(ctx context.Context, sessionID string) error {
	if w.client == nil {
		return ErrUnsupported
	}
	_, err := w.client.Call(ctx, ompclient.Command{Type: "compact"})
	return err
}

func (w *GmpWorkspace) UpdateAgentModel(ctx context.Context) error {
	if w.client == nil {
		return nil
	}
	_, err := w.client.Call(ctx, ompclient.Command{Type: "cycle_model"})
	return err
}

func (w *GmpWorkspace) InitCoderAgent(ctx context.Context) error {
	w.syncState(ctx)
	return nil
}

func (w *GmpWorkspace) GetDefaultSmallModel(providerID string) config.SelectedModel {
	return w.cfg.Models[config.SelectedModelTypeSmall]
}

// -- Permissions --

func (w *GmpWorkspace) PermissionGrant(perm permission.PermissionRequest)           {}
func (w *GmpWorkspace) PermissionGrantPersistent(perm permission.PermissionRequest) {}
func (w *GmpWorkspace) PermissionDeny(perm permission.PermissionRequest)            {}
func (w *GmpWorkspace) PermissionSkipRequests() bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.skipPermissions
}
func (w *GmpWorkspace) PermissionSetSkipRequests(skip bool) {
	w.mu.Lock()
	w.skipPermissions = skip
	w.mu.Unlock()
}

// -- FileTracker --

func (w *GmpWorkspace) FileTrackerRecordRead(ctx context.Context, sessionID, path string) {}
func (w *GmpWorkspace) FileTrackerLastReadTime(ctx context.Context, sessionID, path string) time.Time {
	return time.Time{}
}
func (w *GmpWorkspace) FileTrackerListReadFiles(ctx context.Context, sessionID string) ([]string, error) {
	return nil, nil
}

// -- History --

func (w *GmpWorkspace) ListSessionHistory(ctx context.Context, sessionID string) ([]history.File, error) {
	return nil, nil
}

// -- LSP --

func (w *GmpWorkspace) LSPStart(ctx context.Context, path string) {}
func (w *GmpWorkspace) LSPStopAll(ctx context.Context)            {}
func (w *GmpWorkspace) LSPGetStates() map[string]LSPClientInfo    { return nil }
func (w *GmpWorkspace) LSPGetDiagnosticCounts(name string) lsp.DiagnosticCounts {
	return lsp.DiagnosticCounts{}
}

// -- Config (read-only) --

func (w *GmpWorkspace) Config() *config.Config {
	return w.cfg
}

func (w *GmpWorkspace) WorkingDir() string {
	return w.cwd
}

func (w *GmpWorkspace) Resolver() config.VariableResolver {
	return w.resolver
}

// -- Config mutations --

func (w *GmpWorkspace) UpdatePreferredModel(scope config.Scope, modelType config.SelectedModelType, model config.SelectedModel) error {
	w.mu.Lock()
	w.cfg.Models[modelType] = model
	w.model = AgentModel{
		CatwalkCfg: catwalk.Model{ID: model.Model, Name: model.Model},
		ModelCfg:   model,
	}
	w.mu.Unlock()
	if w.client == nil {
		return nil
	}
	_, err := w.client.Call(context.Background(), ompclient.Command{
		Type:     "set_model",
		Provider: model.Provider,
		ModelID:  model.Model,
	})
	return err
}

func (w *GmpWorkspace) SetCompactMode(scope config.Scope, enabled bool) error {
	w.cfg.Options.TUI.CompactMode = enabled
	return nil
}
func (w *GmpWorkspace) SetProviderAPIKey(scope config.Scope, providerID string, apiKey any) error {
	return nil
}
func (w *GmpWorkspace) SetConfigField(scope config.Scope, key string, value any) error {
	switch key {
	case "options.disable_notifications":
		if disabled, ok := value.(bool); ok {
			w.cfg.Options.DisableNotifications = disabled
		}
	case "options.tui.transparent":
		if transparent, ok := value.(bool); ok {
			w.cfg.Options.TUI.Transparent = &transparent
		}
	}
	return nil
}
func (w *GmpWorkspace) RemoveConfigField(scope config.Scope, key string) error { return nil }
func (w *GmpWorkspace) ImportCopilot() (*oauth.Token, bool)                    { return nil, false }
func (w *GmpWorkspace) RefreshOAuthToken(ctx context.Context, scope config.Scope, providerID string) error {
	return nil
}

// -- Project lifecycle --

func (w *GmpWorkspace) ProjectNeedsInitialization() (bool, error) { return false, nil }
func (w *GmpWorkspace) MarkProjectInitialized() error             { return nil }
func (w *GmpWorkspace) InitializePrompt() (string, error)         { return "", nil }

// -- MCP operations --

func (w *GmpWorkspace) MCPGetStates() map[string]mcptools.ClientInfo         { return nil }
func (w *GmpWorkspace) MCPRefreshPrompts(ctx context.Context, name string)   {}
func (w *GmpWorkspace) MCPRefreshResources(ctx context.Context, name string) {}
func (w *GmpWorkspace) RefreshMCPTools(ctx context.Context, name string)     {}
func (w *GmpWorkspace) ReadMCPResource(ctx context.Context, name, uri string) ([]MCPResourceContents, error) {
	return nil, ErrUnsupported
}
func (w *GmpWorkspace) GetMCPPrompt(clientID, promptID string, args map[string]string) (string, error) {
	return "", ErrUnsupported
}
func (w *GmpWorkspace) EnableDockerMCP(ctx context.Context) error { return ErrUnsupported }
func (w *GmpWorkspace) DisableDockerMCP() error                   { return nil }

// -- Events --

func (w *GmpWorkspace) Subscribe(program *tea.Program) {
	w.mu.Lock()
	w.program = program
	w.mu.Unlock()
	if w.client == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("GmpWorkspace.Subscribe panic", "recover", r)
			program.Quit()
		}
	}()

	// Drain the side-channels so the ompclient read-loop never blocks on a
	// channel send. Without these consumers, the 17th unhandled
	// extension_ui_request (or host_tool_call) would fill the 16-slot buffer
	// and freeze the entire RPC stream — including command responses — until
	// context-deadline. See D2 in the bridge review.
	//
	// The MVP responds with Cancelled: true to all UI prompts and with an
	// error to any host tool call. Plumbing prompts into the Crush
	// permission UI is a follow-up.
	go w.drainExtensionUI()
	go w.drainHostToolCalls()
	go w.drainHostToolCancels()

	for ev := range w.client.Events() {
		w.handleAgentEvent(ev)
	}
	w.setAgentBusy(false)
}

// drainExtensionUI consumes incoming UI prompts from the agent. For
// auth-flow methods (auth.*), it forwards the request as a Bubble
// Tea message so the model can open the existing OAuth / API-key
// dialogs (apps/tui-go/internal/ui/dialog/oauth.go and
// api_key_input.go); the dialog later sends back auth.Submit /
// Confirm / Cancel which the workspace translates to an
// extension_ui_response. For every other method it falls back to
// the legacy "auto-cancel" behavior — gmp's RpcExtensionUIContext
// already treats cancellation as the safe default.
func (w *GmpWorkspace) drainExtensionUI() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("GmpWorkspace.drainExtensionUI panic", "recover", r)
		}
	}()
	for req := range w.client.ExtensionUIRequests() {
		if req == nil || req.ID == "" {
			continue
		}
		if msg := w.translateAuthRequest(req); msg != nil {
			w.sendUI(msg)
			continue
		}
		w.sendCancelledExtensionUIResponse(req.ID, req.Method)
	}
}

// translateAuthRequest returns a Bubble Tea message for an inbound
// auth.* extension_ui_request, or nil if the method is not an auth
// flow method.
func (w *GmpWorkspace) translateAuthRequest(req *ompclient.ExtensionUIReq) tea.Msg {
	if !strings.HasPrefix(req.Method, "auth.") {
		return nil
	}
	switch req.Method {
	case "auth.show_login_url":
		var p struct {
			Provider     string `json:"provider"`
			URL          string `json:"url"`
			Instructions string `json:"instructions"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.show_login_url", "id", req.ID, "error", err)
			return nil
		}
		return auth.ShowLoginURL{ID: req.ID, Provider: p.Provider, URL: p.URL, Instructions: p.Instructions}
	case "auth.show_progress":
		var p struct {
			Provider string `json:"provider"`
			Message  string `json:"message"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.show_progress", "id", req.ID, "error", err)
			return nil
		}
		return auth.ShowProgress{ID: req.ID, Provider: p.Provider, Message: p.Message}
	case "auth.prompt_code":
		var p struct {
			Provider    string `json:"provider"`
			Placeholder string `json:"placeholder"`
			AllowEmpty  bool   `json:"allowEmpty"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.prompt_code", "id", req.ID, "error", err)
			return nil
		}
		return auth.PromptCode{ID: req.ID, Provider: p.Provider, Placeholder: p.Placeholder, AllowEmpty: p.AllowEmpty}
	case "auth.prompt_manual_redirect":
		var p struct {
			Provider     string `json:"provider"`
			Instructions string `json:"instructions"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.prompt_manual_redirect", "id", req.ID, "error", err)
			return nil
		}
		return auth.PromptManualRedirect{ID: req.ID, Provider: p.Provider, Instructions: p.Instructions}
	case "auth.show_result":
		var p struct {
			Provider string `json:"provider"`
			Success  bool   `json:"success"`
			Error    string `json:"error"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.show_result", "id", req.ID, "error", err)
			return nil
		}
		return auth.ShowResult{ID: req.ID, Provider: p.Provider, Success: p.Success, Error: p.Error}
	case "auth.pick_provider":
		var p struct {
			Options   []string `json:"options"`
			DefaultID string   `json:"defaultId"`
		}
		if err := json.Unmarshal(req.Raw, &p); err != nil {
			slog.Warn("gmp workspace: failed to parse auth.pick_provider", "id", req.ID, "error", err)
			return nil
		}
		return auth.PickProvider{ID: req.ID, Options: p.Options, DefaultID: p.DefaultID}
	default:
		slog.Debug("gmp workspace: unknown auth.* method, falling back to cancel", "method", req.Method, "id", req.ID)
		return nil
	}
}

func (w *GmpWorkspace) sendCancelledExtensionUIResponse(id string, method string) {
	resp := ompclient.ExtensionUIResp{
		Type:      "extension_ui_response",
		ID:        id,
		Cancelled: true,
	}
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: extension_ui_response send failed",
			"id", id, "method", method, "error", err)
	} else {
		slog.Debug("gmp workspace: auto-cancelled extension_ui_request",
			"id", id, "method", method)
	}
}

// HandleAuthReply translates a Bubble Tea reply (auth.Submit /
// Confirm / Cancel) into the matching extension_ui_response on the
// wire. The model layer calls this when the user dismisses an auth
// dialog.
func (w *GmpWorkspace) HandleAuthReply(msg tea.Msg) {
	var resp ompclient.ExtensionUIResp
	switch m := msg.(type) {
	case auth.Submit:
		resp = ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Value: m.Value}
	case auth.Confirm:
		confirmed := true
		resp = ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Confirmed: &confirmed}
	case auth.Cancel:
		resp = ompclient.ExtensionUIResp{Type: "extension_ui_response", ID: m.ID, Cancelled: true}
	default:
		return
	}
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: auth reply send failed", "id", resp.ID, "error", err)
	}
}

// drainHostToolCalls rejects every incoming host tool invocation with
// an error result. The Go TUI does not currently register host tools
// via set_host_tools, so a host_tool_call frame here is unexpected; we
// fail it explicitly rather than let omp hang on a missing response.
func (w *GmpWorkspace) drainHostToolCalls() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("GmpWorkspace.drainHostToolCalls panic", "recover", r)
		}
	}()
	for req := range w.client.HostToolCalls() {
		if req == nil || req.ID == "" {
			continue
		}
		resp := ompclient.HostToolResult{
			Type:    "host_tool_result",
			ID:      req.ID,
			Result:  "host tool not registered by gmp-tui-go",
			IsError: true,
		}
		if err := w.client.Send(resp); err != nil {
			slog.Debug("gmp workspace: host_tool_result send failed",
				"id", req.ID, "tool", req.ToolName, "error", err)
		}
	}
}

// drainHostToolCancels acknowledges cancellation requests for prior
// host tool calls. We never tracked the original calls, so the
// cancellation is structurally a no-op — but we must still consume it
// to prevent the read-loop deadlock.
func (w *GmpWorkspace) drainHostToolCancels() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("GmpWorkspace.drainHostToolCancels panic", "recover", r)
		}
	}()
	for req := range w.client.HostToolCancels() {
		if req == nil {
			continue
		}
		slog.Debug("gmp workspace: host tool cancellation ignored",
			"id", req.ID, "targetId", req.TargetID)
	}
}

func (w *GmpWorkspace) Shutdown() {
	w.closeOnce.Do(func() {
		if w.client != nil {
			_ = w.client.Close()
		}
	})
}

func (w *GmpWorkspace) handleAgentEvent(ev *ompclient.AgentEvent) {
	if ev == nil {
		return
	}
	if msg := w.translateEvent(ev); msg != nil {
		w.sendUI(msg)
	}
}

// translateEvent converts an omp RPC agent event into a tea.Msg.
func (w *GmpWorkspace) translateEvent(ev *ompclient.AgentEvent) tea.Msg {
	switch ev.Kind {
	case "agent_start":
		w.setAgentBusy(true)
		return nil
	case "agent_end":
		w.setAgentBusy(false)
		finalEvents := w.handleAgentEnd(ev.Payload)
		for _, msg := range finalEvents {
			w.sendUI(msg)
		}
		if !containsAssistantMessageEvent(finalEvents) {
			if msg := w.finishAssistant(message.FinishReasonEndTurn, "", ""); msg != nil {
				w.sendUI(msg)
			}
		}
		return pubsub.Event[notify.Notification]{
			Type: pubsub.CreatedEvent,
			Payload: notify.Notification{
				SessionID:    w.sessionID(),
				SessionTitle: w.sessionTitle(),
				Type:         notify.TypeAgentFinished,
			},
		}
	case "turn_start":
		w.setAgentBusy(true)
		return nil
	case "turn_end":
		return w.handleTurnEnd(ev.Payload)
	case "message_start":
		return w.handleMessageStart(ev.Payload)
	case "message_update":
		return w.handleMessageUpdate(ev.Payload)
	case "message_end":
		return w.handleMessageEnd(ev.Payload)
	case "tool_execution_start":
		return w.handleToolExecutionStart(ev.Payload)
	case "tool_execution_update":
		return w.handleToolExecutionUpdate(ev.Payload)
	case "tool_execution_end":
		return w.handleToolExecutionEnd(ev.Payload)
	default:
		return nil
	}
}

func (w *GmpWorkspace) handleMessageStart(raw []byte) tea.Msg {
	msg, ok := w.parseAgentMessage(raw, "message")
	if !ok {
		return nil
	}
	eventType := pubsub.CreatedEvent
	w.mu.Lock()
	if msg.Role == message.User {
		if id, ok := w.matchingUserIDLocked(msg.Content().Text); ok {
			msg.ID = id
			eventType = pubsub.UpdatedEvent
		}
	}
	if msg.Role == message.Assistant && w.currentAssistantID != "" {
		msg.ID = w.currentAssistantID
		eventType = pubsub.UpdatedEvent
	}
	if _, exists := w.messages[msg.ID]; exists {
		eventType = pubsub.UpdatedEvent
	}
	w.upsertMessageLocked(msg)
	if msg.Role == message.Assistant && w.currentAssistantID == "" {
		w.currentAssistantID = msg.ID
	}
	w.mu.Unlock()
	return pubsub.Event[message.Message]{Type: eventType, Payload: msg.Clone()}
}

func (w *GmpWorkspace) handleMessageUpdate(raw []byte) tea.Msg {
	var delta struct {
		AssistantMessageEvent struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Error *struct {
				ErrorMessage string `json:"errorMessage"`
			} `json:"error"`
		} `json:"assistantMessageEvent"`
	}
	if err := json.Unmarshal(raw, &delta); err == nil && delta.AssistantMessageEvent.Type != "" {
		ev := delta.AssistantMessageEvent
		switch ev.Type {
		case "text_delta":
			if ev.Delta == "" {
				return nil
			}
			return w.updateAssistant(func(msg *message.Message) {
				msg.AppendContent(ev.Delta)
			})
		case "thinking_delta":
			if ev.Delta == "" {
				return nil
			}
			return w.updateAssistant(func(msg *message.Message) {
				msg.AppendReasoningContent(ev.Delta)
			})
		case "error":
			text := "Request failed"
			if ev.Error != nil && ev.Error.ErrorMessage != "" {
				text = ev.Error.ErrorMessage
			}
			w.setAgentBusy(false)
			return w.finishAssistant(message.FinishReasonError, text, "")
		}
	}

	msg, ok := w.parseAgentMessage(raw, "message")
	if !ok {
		return nil
	}
	w.mu.Lock()
	if msg.Role == message.User {
		if id, ok := w.matchingUserIDLocked(msg.Content().Text); ok {
			msg.ID = id
		}
	}
	if msg.Role == message.Assistant && w.currentAssistantID != "" {
		msg.ID = w.currentAssistantID
	}
	if msg.ID != "" {
		w.upsertMessageLocked(msg)
	}
	w.mu.Unlock()
	if msg.ID == "" {
		return nil
	}
	return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msg.Clone()}
}

func (w *GmpWorkspace) handleMessageEnd(raw []byte) tea.Msg {
	msg, ok := w.parseAgentMessage(raw, "message")
	if !ok {
		return nil
	}
	w.mu.Lock()
	if msg.Role == message.User {
		if id, ok := w.matchingUserIDLocked(msg.Content().Text); ok {
			msg.ID = id
		}
	}
	if msg.Role == message.Assistant && w.currentAssistantID != "" {
		msg.ID = w.currentAssistantID
	}
	if msg.ID != "" {
		w.upsertMessageLocked(msg)
		if msg.Role == message.Assistant {
			w.currentAssistantID = ""
		}
	}
	w.mu.Unlock()
	if msg.ID == "" {
		return nil
	}
	return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msg.Clone()}
}

func (w *GmpWorkspace) handleTurnEnd(raw []byte) tea.Msg {
	var payload struct {
		Message     json.RawMessage   `json:"message"`
		ToolResults []json.RawMessage `json:"toolResults"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}

	var msgs []message.Message
	if msg, ok := w.parseAgentMessage(payload.Message, ""); ok {
		msgs = append(msgs, msg)
	}
	for _, tr := range payload.ToolResults {
		if msg, ok := w.parseAgentMessage(tr, ""); ok {
			msgs = append(msgs, msg)
		}
	}

	w.mu.Lock()
	for _, msg := range msgs {
		if msg.ID == "" {
			msg.ID = w.nextID("turn")
		}
		if _, exists := w.messages[msg.ID]; !exists {
			w.msgOrder = append(w.msgOrder, msg.ID)
		}
		w.messages[msg.ID] = msg
	}
	w.mu.Unlock()

	if len(msgs) > 0 {
		return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msgs[0]}
	}
	return nil
}

func (w *GmpWorkspace) handleAgentEnd(raw []byte) []tea.Msg {
	var payload struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}

	msgs := make([]message.Message, 0, len(payload.Messages))
	for _, rm := range payload.Messages {
		msg, ok := w.parseAgentMessage(rm, "")
		if !ok {
			continue
		}
		msgs = append(msgs, msg)
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	events := make([]tea.Msg, 0, len(msgs))
	for _, msg := range msgs {
		eventType := pubsub.CreatedEvent
		if msg.Role == message.User {
			if id, ok := w.matchingUserIDLocked(msg.Content().Text); ok {
				msg.ID = id
			}
		}
		if msg.Role == message.Assistant {
			if w.currentAssistantID != "" {
				msg.ID = w.currentAssistantID
			} else if id, ok := w.matchingAssistantIDLocked(msg.Content().Text); ok {
				msg.ID = id
			}
		}
		if _, exists := w.messages[msg.ID]; exists {
			eventType = pubsub.UpdatedEvent
		}
		w.upsertMessageLocked(msg)
		if msg.Role == message.Assistant {
			w.currentAssistantID = ""
		}
		events = append(events, pubsub.Event[message.Message]{Type: eventType, Payload: msg.Clone()})
	}
	return events
}

func (w *GmpWorkspace) handleToolExecutionStart(raw []byte) tea.Msg {
	var p struct {
		ToolCallID string          `json:"toolCallId"`
		ToolName   string          `json:"toolName"`
		Args       json.RawMessage `json:"args"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ToolCallID == "" {
		return nil
	}
	args := p.Args
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	return w.updateAssistant(func(msg *message.Message) {
		msg.AddToolCall(message.ToolCall{
			ID:    p.ToolCallID,
			Name:  p.ToolName,
			Input: string(args),
		})
	})
}

func (w *GmpWorkspace) handleToolExecutionUpdate(raw []byte) tea.Msg {
	var p struct {
		ToolCallID    string          `json:"toolCallId"`
		ToolName      string          `json:"toolName"`
		PartialResult json.RawMessage `json:"partialResult"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	id := p.ToolCallID + "-result"
	now := time.Now().Unix()
	content := stringifyToolResult(p.PartialResult)
	sessionID := w.sessionID()
	w.mu.Lock()
	msg, ok := w.messages[id]
	if ok && len(msg.Parts) > 0 {
		if tr, ok := msg.Parts[0].(message.ToolResult); ok {
			tr.Content = content
			msg.Parts[0] = tr
			msg.UpdatedAt = now
			w.messages[id] = msg
		}
	}
	if !ok {
		msg = message.Message{
			ID:        id,
			Role:      message.Tool,
			SessionID: sessionID,
			Parts: []message.ContentPart{
				message.ToolResult{
					ToolCallID: p.ToolCallID,
					Name:       p.ToolName,
					Content:    content,
				},
			},
			CreatedAt: now,
			UpdatedAt: now,
		}
		w.upsertMessageLocked(msg)
		w.toolResultMessages[p.ToolCallID] = msg.ID
	}
	w.mu.Unlock()
	if ok {
		return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msg.Clone()}
	}
	return pubsub.Event[message.Message]{Type: pubsub.CreatedEvent, Payload: msg.Clone()}
}

func (w *GmpWorkspace) handleToolExecutionEnd(raw []byte) tea.Msg {
	var p struct {
		ToolCallID string          `json:"toolCallId"`
		ToolName   string          `json:"toolName"`
		Result     json.RawMessage `json:"result"`
		IsError    bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ToolCallID == "" {
		return nil
	}
	if msg := w.updateAssistant(func(msg *message.Message) {
		msg.FinishToolCall(p.ToolCallID)
	}); msg != nil {
		w.sendUI(msg)
	}

	id := p.ToolCallID + "-result"
	now := time.Now().Unix()
	result := message.Message{
		ID:        id,
		Role:      message.Tool,
		SessionID: w.sessionID(),
		Parts: []message.ContentPart{
			message.ToolResult{
				ToolCallID: p.ToolCallID,
				Name:       p.ToolName,
				Content:    stringifyToolResult(p.Result),
				IsError:    p.IsError,
			},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
	w.mu.Lock()
	w.upsertMessageLocked(result)
	w.toolResultMessages[p.ToolCallID] = result.ID
	w.mu.Unlock()
	return pubsub.Event[message.Message]{Type: pubsub.CreatedEvent, Payload: result.Clone()}
}

// parseAgentMessage converts a raw JSON agent message into a message.Message.
// If fieldName is non-empty, raw is treated as a wrapper object and the
// message body is read from that key; otherwise raw is the body.
func (w *GmpWorkspace) parseAgentMessage(raw []byte, fieldName string) (message.Message, bool) {
	var body json.RawMessage
	if fieldName != "" {
		var wrapper map[string]json.RawMessage
		if err := json.Unmarshal(raw, &wrapper); err != nil {
			return message.Message{}, false
		}
		var ok bool
		body, ok = wrapper[fieldName]
		if !ok {
			return message.Message{}, false
		}
	} else {
		body = raw
	}

	var probe struct {
		Role      string `json:"role"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return message.Message{}, false
	}

	msg := message.Message{
		Role:      message.MessageRole(probe.Role),
		SessionID: w.sessionID(),
		CreatedAt: probe.Timestamp / 1000, // RPC uses ms, crush uses s
		UpdatedAt: time.Now().Unix(),
	}

	switch probe.Role {
	case "user":
		msg.Parts = w.parseTextWrappedContent(body)
		msg.ID = w.nextID("user")
	case "assistant":
		msg.Parts = w.parseAssistantContent(body)
		msg.ID = w.nextID("assistant")
	case "toolResult":
		msg.Role = message.Tool
		msg.Parts = w.parseToolResultContent(body)
		msg.ID = w.nextID("tool")
	case "bashExecution", "pythonExecution":
		msg.Parts = w.parseExecutionContent(body)
		msg.ID = w.nextID("exec")
	case "custom", "hookMessage":
		msg.Parts = w.parseTextWrappedContent(body)
		msg.ID = w.nextID("custom")
	default:
		msg.Parts = []message.ContentPart{message.TextContent{Text: fmt.Sprintf("[%s message]", probe.Role)}}
		msg.ID = w.nextID("unknown")
	}

	return msg, true
}

func (w *GmpWorkspace) parseTextWrappedContent(raw []byte) []message.ContentPart {
	var p struct {
		Content any `json:"content"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	text := extractTextString(p.Content)
	if text == "" {
		return nil
	}
	return []message.ContentPart{message.TextContent{Text: text}}
}

// extractTextString flattens an RPC content value (string | []{type:"text",text}) into a string.
func extractTextString(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var texts []string
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "text" {
				if t, ok := m["text"].(string); ok {
					texts = append(texts, t)
				}
			}
		}
		return strings.Join(texts, "")
	}
	return ""
}

func (w *GmpWorkspace) parseAssistantContent(raw []byte) []message.ContentPart {
	var p struct {
		Content      []json.RawMessage `json:"content"`
		StopReason   string            `json:"stopReason"`
		ErrorMessage string            `json:"errorMessage"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}

	var parts []message.ContentPart
	for _, block := range p.Content {
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(block, &probe); err != nil {
			continue
		}
		switch probe.Type {
		case "text":
			var t struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(block, &t); err == nil && t.Text != "" {
				parts = append(parts, message.TextContent{Text: t.Text})
			}
		case "thinking":
			var t struct {
				Thinking string `json:"thinking"`
			}
			if err := json.Unmarshal(block, &t); err == nil && t.Thinking != "" {
				parts = append(parts, message.ReasoningContent{Thinking: t.Thinking, StartedAt: time.Now().Unix()})
			}
		case "toolCall":
			var tc struct {
				ID        string          `json:"id"`
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(block, &tc); err == nil {
				input := string(tc.Arguments)
				if input == "" {
					input = "{}"
				}
				parts = append(parts, message.ToolCall{
					ID:    tc.ID,
					Name:  tc.Name,
					Input: input,
				})
			}
		}
	}

	if p.StopReason != "" {
		reason := message.FinishReasonUnknown
		switch p.StopReason {
		case "stop":
			reason = message.FinishReasonEndTurn
		case "length":
			reason = message.FinishReasonMaxTokens
		case "toolUse":
			reason = message.FinishReasonToolUse
		case "aborted":
			reason = message.FinishReasonCanceled
		case "error":
			reason = message.FinishReasonError
		}
		parts = append(parts, message.Finish{
			Reason:  reason,
			Time:    time.Now().Unix(),
			Message: p.ErrorMessage,
		})
	}

	return parts
}

func (w *GmpWorkspace) parseToolResultContent(raw []byte) []message.ContentPart {
	var p struct {
		ToolCallID string `json:"toolCallId"`
		ToolName   string `json:"toolName"`
		Content    any    `json:"content"`
		IsError    bool   `json:"isError"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	return []message.ContentPart{
		message.ToolResult{
			ToolCallID: p.ToolCallID,
			Name:       p.ToolName,
			Content:    extractTextString(p.Content),
			IsError:    p.IsError,
		},
	}
}

func (w *GmpWorkspace) parseExecutionContent(raw []byte) []message.ContentPart {
	var p struct {
		Command  string `json:"command"`
		Code     string `json:"code"`
		Output   string `json:"output"`
		ExitCode *int   `json:"exitCode"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	label := p.Command
	if label == "" {
		label = p.Code
	}
	text := fmt.Sprintf("%s\n\n%s", label, p.Output)
	if p.ExitCode != nil {
		text += fmt.Sprintf("\n(exit code: %d)", *p.ExitCode)
	}
	return []message.ContentPart{message.TextContent{Text: text}}
}

// -- helpers --

func (w *GmpWorkspace) setAgentBusy(busy bool) {
	w.mu.Lock()
	w.agentBusy = busy
	w.mu.Unlock()
}

func (w *GmpWorkspace) sessionID() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.session.ID
}

func (w *GmpWorkspace) sessionTitle() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.session.Title
}

func newOmpConfig() *config.Config {
	progress := true
	cfg := &config.Config{
		Models: map[config.SelectedModelType]config.SelectedModel{
			config.SelectedModelTypeLarge: {Provider: gmpProviderID, Model: gmpModelID},
			config.SelectedModelTypeSmall: {Provider: gmpProviderID, Model: gmpModelID},
		},
		RecentModels: make(map[config.SelectedModelType][]config.SelectedModel),
		Providers: csync.NewMapFrom(map[string]config.ProviderConfig{
			gmpProviderID: {
				ID:   gmpProviderID,
				Name: "gmp",
				Type: catwalk.TypeOpenAI,
				Models: []catwalk.Model{
					{ID: gmpModelID, Name: "gmp backend"},
				},
			},
		}),
		Options: &config.Options{
			ContextPaths:  []string{},
			DataDirectory: ".omp",
			Progress:      &progress,
			TUI:           &config.TUIOptions{},
		},
		Permissions: &config.Permissions{},
	}
	cfg.SetupAgents()
	return cfg
}

func (w *GmpWorkspace) ensureSessionLocked() session.Session {
	if w.session.ID == "" {
		now := time.Now().Unix()
		w.session = session.Session{
			ID:        w.nextID("session"),
			Title:     "New Session",
			CreatedAt: now,
			UpdatedAt: now,
		}
	}
	return w.session
}

func (w *GmpWorkspace) upsertMessageLocked(msg message.Message) {
	if w.messages == nil {
		w.messages = make(map[string]message.Message)
	}
	if _, exists := w.messages[msg.ID]; !exists {
		w.msgOrder = append(w.msgOrder, msg.ID)
	}
	w.messages[msg.ID] = msg
	if msg.SessionID == w.session.ID {
		w.session.MessageCount = int64(len(w.msgOrder))
		w.session.UpdatedAt = time.Now().Unix()
	}
}

func (w *GmpWorkspace) matchingUserIDLocked(text string) (string, bool) {
	for i := len(w.msgOrder) - 1; i >= 0; i-- {
		msg, ok := w.messages[w.msgOrder[i]]
		if ok && msg.Role == message.User && msg.Content().Text == text {
			return msg.ID, true
		}
	}
	return "", false
}

func (w *GmpWorkspace) matchingAssistantIDLocked(text string) (string, bool) {
	for i := len(w.msgOrder) - 1; i >= 0; i-- {
		msg, ok := w.messages[w.msgOrder[i]]
		if ok && msg.Role == message.Assistant && msg.Content().Text == text {
			return msg.ID, true
		}
	}
	return "", false
}

func containsAssistantMessageEvent(events []tea.Msg) bool {
	for _, msg := range events {
		event, ok := msg.(pubsub.Event[message.Message])
		if ok && event.Payload.Role == message.Assistant {
			return true
		}
	}
	return false
}

func (w *GmpWorkspace) ensureAssistantLocked() message.Message {
	if w.currentAssistantID != "" {
		if msg, ok := w.messages[w.currentAssistantID]; ok {
			return msg
		}
	}
	now := time.Now().Unix()
	sessionID := w.ensureSessionLocked().ID
	msg := message.Message{
		ID:        w.nextID("assistant"),
		SessionID: sessionID,
		Role:      message.Assistant,
		Model:     w.model.ModelCfg.Model,
		Provider:  w.model.ModelCfg.Provider,
		CreatedAt: now,
		UpdatedAt: now,
	}
	w.currentAssistantID = msg.ID
	w.upsertMessageLocked(msg)
	return msg
}

func (w *GmpWorkspace) updateAssistant(update func(*message.Message)) tea.Msg {
	w.mu.Lock()
	msg := w.ensureAssistantLocked()
	update(&msg)
	msg.UpdatedAt = time.Now().Unix()
	w.upsertMessageLocked(msg)
	w.mu.Unlock()
	return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msg.Clone()}
}

func (w *GmpWorkspace) finishAssistant(reason message.FinishReason, text string, details string) tea.Msg {
	w.mu.Lock()
	if w.currentAssistantID == "" {
		w.mu.Unlock()
		return nil
	}
	msg, ok := w.messages[w.currentAssistantID]
	if !ok {
		w.currentAssistantID = ""
		w.mu.Unlock()
		return nil
	}
	if text != "" && msg.Content().Text == "" {
		msg.AppendContent(text)
	}
	msg.FinishThinking()
	msg.AddFinish(reason, text, details)
	msg.UpdatedAt = time.Now().Unix()
	w.upsertMessageLocked(msg)
	w.currentAssistantID = ""
	w.mu.Unlock()
	return pubsub.Event[message.Message]{Type: pubsub.UpdatedEvent, Payload: msg.Clone()}
}

func (w *GmpWorkspace) sendUI(msg tea.Msg) {
	if msg == nil {
		return
	}
	w.mu.RLock()
	program := w.program
	events := w.events
	w.mu.RUnlock()
	if program != nil {
		// Dispatch to a goroutine so we never block the caller. sendUI
		// is sometimes invoked from inside the Bubble Tea Update
		// goroutine (e.g. CreateSession during a SendMessage handler).
		// Calling program.Send synchronously from there deadlocks: Send
		// posts to the program's message channel which is drained by
		// the same Update goroutine that's currently waiting for us.
		go program.Send(msg)
		return
	}
	if events == nil {
		return
	}
	select {
	case events <- msg:
	default:
	}
}

func stringifyToolResult(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err == nil {
		if content, ok := obj["content"]; ok {
			if text := extractTextString(content); text != "" {
				return text
			}
		}
		for _, key := range []string{"content", "text", "message", "error", "output"} {
			if value, ok := obj[key].(string); ok && value != "" {
				return value
			}
		}
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	pretty, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return string(raw)
	}
	return string(pretty)
}

// Compile-time check.
var _ Workspace = (*GmpWorkspace)(nil)
