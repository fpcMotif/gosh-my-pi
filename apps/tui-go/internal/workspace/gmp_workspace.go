package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
)

const gmpToolSessionDelim = "$$"

var ErrUnsupported = errors.New("gmp backend: operation not supported in MVP")
var ErrSessionCreationCancelled = errors.New("gmp backend: session creation cancelled")

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
	// thinkingLevel is the backend-owned session setting. Keep it separate
	// from model metadata: the same model can run at any valid level.
	thinkingLevel string

	modelCatalog ModelCatalog
	// catalogOps serializes catalog transactions without holding mu across
	// RPC. Waiting respects the caller deadline.
	catalogOps chan struct{}

	// program receives every UI-bound message via sendUI. In production this
	// is *tea.Program; tests can swap in a fake that satisfies programSender
	// to exercise the program.Send branch without spinning up a real TUI.
	program programSender
	// events is a test-only seam: tests assign a buffered channel here and
	// drain it in nextMessageEvent. In production sendUI always uses program.
	events chan tea.Msg
	// uiMailbox holds program-bound UI messages. It coalesces pending full
	// message snapshots without crossing lifecycle edges. uiWake starts one
	// drain pass; producers never wait for Program.Send.
	uiMailbox        []*uiMailboxSlot
	uiMessageUpdates map[string]*uiMailboxSlot
	uiWake           chan struct{}
	uiDone           chan struct{}
	uiDrained        chan struct{}
	uiClosed         bool
	uiOverloaded     bool
	uiDrainOnce      sync.Once
	sideDrainOnce    sync.Once
	eventsDrainOnce  sync.Once
	closeOnce        sync.Once
	clientCloseOnce  sync.Once
}

type uiMailboxSlot struct {
	msg tea.Msg
}

// programSender is the subset of *tea.Program that GmpWorkspace.sendUI uses.
// Defined as an interface so tests can substitute a fake that does not
// require a real terminal program loop.
type programSender interface {
	Send(msg tea.Msg)
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
		modelCatalog:       ModelCatalog{},
		catalogOps:         make(chan struct{}, 1),
		uiMessageUpdates:   make(map[string]*uiMailboxSlot),
		uiWake:             make(chan struct{}, 1),
		uiDone:             make(chan struct{}),
		uiDrained:          make(chan struct{}),
		model:              AgentModel{},
	}
	return w
}

func (w *GmpWorkspace) nextID(prefix string) string {
	n := w.msgCounter.Add(1)
	return fmt.Sprintf("%s-%d", prefix, n)
}

// -- Sessions --

func (w *GmpWorkspace) CreateSession(ctx context.Context, title string) (session.Session, error) {
	var backendState *backendSessionState
	if w.client != nil {
		if err := w.acquireCatalogOp(ctx); err != nil {
			return session.Session{}, err
		}
		defer w.releaseCatalogOp()
		resp, err := w.client.Call(ctx, ompclient.Command{Type: "new_session"})
		if err != nil {
			return session.Session{}, err
		}
		state, err := parseNewSessionReceipt(resp.Data)
		if err != nil {
			return session.Session{}, err
		}
		if state == nil {
			if err := w.syncStateLocked(ctx); err != nil {
				return session.Session{}, err
			}
		} else {
			backendState = state
		}
	}

	w.mu.Lock()
	if backendState != nil {
		w.applyBackendSessionStateLocked(*backendState)
	}
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

// parseNewSessionReceipt accepts both the modern authoritative receipt and
// the legacy cancelled-only response. A modern state must identify the new
// session before callers are allowed to mutate local state.
func parseNewSessionReceipt(data []byte) (*backendSessionState, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, fmt.Errorf("decode new_session response: %w", err)
	}
	cancelledData, ok := fields["cancelled"]
	if !ok {
		return nil, errors.New("decode new_session response: missing cancelled")
	}
	var cancelled bool
	if err := json.Unmarshal(cancelledData, &cancelled); err != nil {
		return nil, fmt.Errorf("decode new_session response: invalid cancelled: %w", err)
	}
	if cancelled {
		return nil, ErrSessionCreationCancelled
	}
	stateData, ok := fields["state"]
	if !ok {
		return nil, nil
	}
	if string(stateData) == "null" {
		return nil, errors.New("decode new_session response: state must be an object")
	}
	state, err := parseBackendSessionState(stateData)
	if err != nil {
		return nil, fmt.Errorf("decode new_session response state: %w", err)
	}
	if strings.TrimSpace(state.SessionID) == "" {
		return nil, errors.New("decode new_session response: state has blank sessionId")
	}
	return &state, nil
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
		// Correlate the echoed user message back to the optimistic one created
		// above so reconciliation is by id, not fragile content matching.
		ClientMessageID: user.ID,
	})
	if err != nil {
		if msg := w.finishAssistant(message.FinishReasonError, err.Error(), ""); msg != nil {
			w.sendUI(msg)
		}
		w.setAgentBusy(false)
	}
	return err
}

func (w *GmpWorkspace) AgentCancel(ctx context.Context, sessionID string) error {
	if w.client != nil {
		if _, err := w.client.Call(ctx, ompclient.Command{Type: "abort"}); err != nil {
			return err
		}
	}
	if msg := w.finishAssistant(message.FinishReasonCanceled, "Request canceled", ""); msg != nil {
		w.sendUI(msg)
	}
	w.setAgentBusy(false)
	return nil
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
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.model.ModelCfg.Provider != "" && w.model.ModelCfg.Model != ""
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
	return w.syncState(ctx)
}

func (w *GmpWorkspace) InitCoderAgent(ctx context.Context) error {
	return w.syncState(ctx)
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

func (w *GmpWorkspace) SetCompactMode(scope config.Scope, enabled bool) error {
	w.cfg.Options.TUI.CompactMode = enabled
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

func (w *GmpWorkspace) Shutdown() {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.uiClosed = true
		w.uiMailbox = nil
		clear(w.uiMessageUpdates)
		close(w.uiDone)
		client := w.client
		w.mu.Unlock()
		w.closeClient(client)
	})
}

// closeClient closes the RPC transport at most once. Callers capture client
// while holding w.mu, then invoke this method after releasing it: Close waits
// for the reader and may synchronously re-enter workspace shutdown paths.
func (w *GmpWorkspace) closeClient(client *ompclient.Client) {
	if client == nil {
		return
	}
	w.clientCloseOnce.Do(func() { _ = client.Close() })
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
		Models:       make(map[config.SelectedModelType]config.SelectedModel),
		RecentModels: make(map[config.SelectedModelType][]config.SelectedModel),
		Providers:    csync.NewMap[string, config.ProviderConfig](),
		Options: &config.Options{
			ContextPaths:  []string{},
			DataDirectory: ".omp",
			Progress:      &progress,
			TUI:           &config.TUIOptions{},
			// gmp owns the provider/credential store via its own
			// AuthStorage. Suppress the catwalk catalog so the model
			// picker and the legacy APIKey/OAuth dialogs cannot offer
			// providers gmp has not registered, which would otherwise
			// route credentials into Crush's local config and diverge
			// from gmp's SQLite-backed credential store.
			DisableDefaultProviders:   true,
			DisableProviderAutoUpdate: true,
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

// Compile-time check.
var _ Workspace = (*GmpWorkspace)(nil)
