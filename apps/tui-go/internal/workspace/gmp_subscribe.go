package workspace

import (
	"cmp"
	"context"
	"encoding/json"
	"log/slog"

	tea "charm.land/bubbletea/v2"
	"charm.land/catwalk/pkg/catwalk"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/config"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
)

// BackendExitedMsg is the typed tea.Msg delivered through the normal
// program.Send / events path when the gmp RPC subprocess exits
// unexpectedly (peer EOF / crash) rather than via an intentional
// Shutdown/Close. The model layer renders a legible "backend connection
// lost" banner on it instead of leaving the transcript frozen. It carries
// no payload: the transport-local exit is the whole signal.
type BackendExitedMsg struct{}

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
		providerID := cmp.Or(st.Model.Provider, gmpProviderID)
		w.model = AgentModel{
			CatwalkCfg: catwalk.Model{ID: st.Model.ID, Name: modelName},
			ModelCfg: config.SelectedModel{
				Provider: providerID,
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

// -- Events --

func (w *GmpWorkspace) Subscribe(program *tea.Program) {
	w.mu.Lock()
	// Avoid storing a typed-nil *tea.Program inside the programSender
	// interface — that produces a non-nil interface wrapping a nil
	// pointer, which would slip past the `program != nil` guard in
	// sendUI and panic when the runtime calls Send on a nil receiver.
	if program == nil {
		w.program = nil
	} else {
		w.program = program
	}
	w.mu.Unlock()
	// Start the single UI-drain goroutine once. It calls program.Send in FIFO
	// order, preserving the order of streamed events that the per-message
	// `go program.Send` previously scrambled.
	if program != nil {
		w.uiDrainOnce.Do(func() { go w.drainUI() })
	}
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

	// The events channel only closes once the transport read loop ends. If
	// that was an unexpected exit (peer EOF / subprocess crash) rather than
	// an intentional Shutdown/Close, surface it to the UI as a typed message
	// so the model can enter a legible "backend connection lost" state
	// instead of freezing on the last transcript. Intentional shutdown
	// leaves BackendExited open, so no false banner appears on a clean quit.
	select {
	case <-w.client.BackendExited():
		w.sendUI(BackendExitedMsg{})
	default:
	}
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
	for req := range w.client.ExtensionUIRequests() {
		drainStep("drainExtensionUI", func() { w.dispatchExtensionUIRequest(req) })
	}
}

// drainStep runs one drain-loop iteration with a panic recover scoped to that
// single frame. The recover MUST be per-iteration, not per-goroutine: a
// goroutine-level recover (deferred in the drain func) unwinds the whole `for
// range` loop on the first panic, killing the drainer permanently. With no
// consumer the side-channel buffer then fills after 16 frames and the
// ompclient read loop wedges — stalling response and agent-event dispatch too,
// until each stranded request hits its multi-minute deadline. Scoping recover
// here keeps the drainer alive across a bad frame.
func drainStep(label string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("gmp workspace: drain step panic recovered", "drainer", label, "recover", r)
		}
	}()
	fn()
}

// dispatchExtensionUIRequest handles one inbound extension_ui_request frame.
// Extracted from drainExtensionUI for unit testability — the loop body is
// the only state-mutating part of the drainer.
func (w *GmpWorkspace) dispatchExtensionUIRequest(req *ompclient.ExtensionUIReq) {
	if req == nil || req.ID == "" {
		return
	}
	if msg := w.translateAuthRequest(req); msg != nil {
		w.sendUI(msg)
		return
	}
	if msg := w.translateToolApprovalRequest(req); msg != nil {
		w.sendUI(msg)
		return
	}
	w.sendCancelledExtensionUIResponse(req.ID, req.Method)
}

func (w *GmpWorkspace) sendCancelledExtensionUIResponse(id string, method string) {
	resp := buildCancelledExtensionUIResponse(id)
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: extension_ui_response send failed",
			"id", id, "method", method, "error", err)
	} else {
		slog.Debug("gmp workspace: auto-cancelled extension_ui_request",
			"id", id, "method", method)
	}
}

// buildCancelledExtensionUIResponse assembles a Cancelled=true response frame
// for the given inbound id. Pure for testability.
func buildCancelledExtensionUIResponse(id string) ompclient.ExtensionUIResp {
	return ompclient.ExtensionUIResp{
		Type:      "extension_ui_response",
		ID:        id,
		Cancelled: true,
	}
}

// drainHostToolCalls rejects every incoming host tool invocation with an
// error result. The Go TUI never registers host tools via set_host_tools, so
// host-side tools are an intentional, documented gmp-mode limitation (gap G29):
// a host_tool_call frame is unexpected. We always reply — failing the call
// explicitly rather than letting the backend hang on a missing response — so
// the read loop can never deadlock on an unregistered host tool.
func (w *GmpWorkspace) drainHostToolCalls() {
	for req := range w.client.HostToolCalls() {
		drainStep("drainHostToolCalls", func() { w.rejectHostToolCall(req) })
	}
}

// rejectHostToolCall replies to one inbound host_tool_call with an error
// result. Extracted so drainStep can scope panic recovery to a single frame.
func (w *GmpWorkspace) rejectHostToolCall(req *ompclient.HostToolCallReq) {
	if req == nil || req.ID == "" {
		return
	}
	// Result MUST serialize to an AgentToolResult ({content:[...]}) — the TS
	// guard (isAgentToolResult) requires result.content to be an array and
	// silently drops a bare string, which would strand the backend's
	// pending host-tool promise and deadlock the call. Send a content block.
	resp := ompclient.HostToolResult{
		Type: "host_tool_result",
		ID:   req.ID,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "host tools are not supported by gmp-tui-go (the Go frontend registers none)"},
			},
		},
		IsError: true,
	}
	if err := w.client.Send(resp); err != nil {
		slog.Debug("gmp workspace: host_tool_result send failed",
			"id", req.ID, "tool", req.ToolName, "error", err)
	}
}

// drainHostToolCancels acknowledges cancellation requests for prior
// host tool calls. We never tracked the original calls, so the
// cancellation is structurally a no-op — but we must still consume it
// to prevent the read-loop deadlock.
func (w *GmpWorkspace) drainHostToolCancels() {
	for req := range w.client.HostToolCancels() {
		drainStep("drainHostToolCancels", func() {
			if req == nil {
				return
			}
			slog.Debug("gmp workspace: host tool cancellation ignored",
				"id", req.ID, "targetId", req.TargetID)
		})
	}
}

func (w *GmpWorkspace) sendUI(msg tea.Msg) {
	if msg == nil {
		return
	}
	w.mu.RLock()
	program := w.program
	events := w.events
	uiQueue := w.uiQueue
	w.mu.RUnlock()
	if program != nil {
		// Hand the message to the single drain goroutine so program.Send is
		// called in submission order. Enqueue is non-blocking; on a full queue
		// we spill to a goroutine rather than block, because sendUI is
		// sometimes invoked from inside the Bubble Tea Update goroutine (e.g.
		// CreateSession during a SendMessage handler) and blocking there would
		// deadlock against program.Send draining that same loop. Spill only
		// triggers under sustained overload and self-heals: v1 frames carry
		// full snapshots, so a later frame restores any transiently-reordered
		// state.
		select {
		case uiQueue <- msg:
		default:
			go func() { uiQueue <- msg }()
		}
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

// drainUI delivers queued program-bound messages in FIFO order. Running as a
// single goroutine is what guarantees ordering; it reads w.program per message
// so a re-Subscribe with a new program is honored and a nil program (between
// subscribes) drops cleanly.
func (w *GmpWorkspace) drainUI() {
	for msg := range w.uiQueue {
		w.mu.RLock()
		program := w.program
		w.mu.RUnlock()
		if program != nil {
			program.Send(msg)
		}
	}
}
