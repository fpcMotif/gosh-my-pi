package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/csync"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/session"
)

const (
	// GmpProviderID is the canonical id of the virtual provider that
	// stands in for the gmp RPC bridge in Crush's provider map. Exported
	// so the model picker, auth dialog router, and `crush login`
	// command can recognise gmp-bridge entries without hard-coding the
	// string.
	GmpProviderID = "gmp"

	gmpProviderID       = GmpProviderID
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

	modelCatalog map[string]GmpModelCatalogEntry

	// program receives every UI-bound message via sendUI. In production this
	// is *tea.Program; tests can swap in a fake that satisfies programSender
	// to exercise the program.Send branch without spinning up a real TUI.
	program programSender
	// events is a test-only seam: tests assign a buffered channel here and
	// drain it in nextMessageEvent. In production sendUI always uses program.
	events chan tea.Msg
	// uiQueue serializes program-bound messages through a single drain
	// goroutine (started once in Subscribe) so streamed UI events keep their
	// submission order. A bare `go program.Send` per message races and lets an
	// earlier snapshot overwrite a later one.
	uiQueue     chan tea.Msg
	uiDrainOnce sync.Once
	closeOnce   sync.Once
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
		modelCatalog:       make(map[string]GmpModelCatalogEntry),
		uiQueue:            make(chan tea.Msg, 1024),
		model: AgentModel{
			CatwalkCfg: catwalk.Model{ID: gmpModelID, Name: "gmp backend"},
			ModelCfg:   cfg.Models[config.SelectedModelTypeLarge],
		},
	}
	// Best-effort initial state sync so the UI has a session ID immediately.
	if client != nil {
		w.syncState(context.Background())
		_ = w.RefreshModelCatalog(context.Background())
	}
	return w
}

func (w *GmpWorkspace) nextID(prefix string) string {
	n := w.msgCounter.Add(1)
	return fmt.Sprintf("%s-%d", prefix, n)
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
	w.syncState(ctx)
	return nil
}

func (w *GmpWorkspace) InitCoderAgent(ctx context.Context) error {
	w.syncState(ctx)
	return nil
}

func (w *GmpWorkspace) GetDefaultSmallModel(providerID string) config.SelectedModel {
	return w.cfg.Models[config.SelectedModelTypeSmall]
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

// IsGmpMode reports true: GmpWorkspace IS the gmp RPC bridge. Callers
// use this to short-circuit Crush legacy code paths that would write
// credentials into local stores instead of routing through gmp's
// AuthStorage over the auth.* RPC frames.
func (*GmpWorkspace) IsGmpMode() bool { return true }

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
		Role:     gmpRoleForModelType(modelType),
	})
	return err
}

func gmpRoleForModelType(modelType config.SelectedModelType) string {
	switch modelType {
	case config.SelectedModelTypeSmall:
		return "smol"
	default:
		return "default"
	}
}

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
		if w.client != nil {
			_ = w.client.Close()
		}
	})
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
