package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

const (
	uiMailboxNormalCapacity   = 256
	uiMailboxTerminalCapacity = 1
	uiMailboxCapacity         = uiMailboxNormalCapacity + uiMailboxTerminalCapacity
)

// BackendExitReason distinguishes a failed backend from an intentional
// protective shutdown. The UI renders the reason instead of claiming every
// terminal state was a backend crash.
type BackendExitReason uint8

const (
	BackendExitUnexpected BackendExitReason = iota
	BackendExitUIOverload
)

// BackendExitedMsg is the terminal tea.Msg delivered through the normal
// program.Send / events path when the backend exits unexpectedly or the UI
// mailbox overload guard stops it. The model layer renders a legible state
// instead of leaving the transcript frozen.
type BackendExitedMsg struct {
	Reason BackendExitReason
}

// backendSessionState is the validated subset of the backend's authoritative
// RPC session snapshot that the workspace owns locally.
type backendSessionState struct {
	SessionID     string             `json:"sessionId"`
	SessionName   string             `json:"sessionName"`
	ThinkingLevel *string            `json:"thinkingLevel"`
	Model         *ModelCatalogModel `json:"model"`
}

// SyncInitialSnapshot restores the backend session before the UI starts.
// The caller owns one deadline for both calls, so startup cannot hang on a
// healthy first response followed by a wedged history response.
func (w *GmpWorkspace) SyncInitialSnapshot(ctx context.Context) error {
	// Side requests can arrive while get_state is in flight. Consume them
	// first so session_start never waits on a UI that does not exist yet.
	// Agent events remain unread until Subscribe, preserving snapshot-first
	// state application.
	w.startSideDrains()
	if err := w.syncState(ctx); err != nil {
		return err
	}
	return w.syncMessages(ctx)
}

func (w *GmpWorkspace) syncState(ctx context.Context) error {
	if err := w.acquireCatalogOp(ctx); err != nil {
		return err
	}
	defer w.releaseCatalogOp()
	return w.syncStateLocked(ctx)
}

// syncStateLocked serializes a get_state snapshot with model selection and
// catalog refreshes. The caller must hold catalogOps.
func (w *GmpWorkspace) syncStateLocked(ctx context.Context) error {
	if w.client == nil {
		return nil
	}
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "get_state"})
	if err != nil {
		return fmt.Errorf("get backend state: %w", err)
	}
	st, err := parseBackendSessionState(resp.Data)
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.applyBackendSessionStateLocked(st)
	w.mu.Unlock()
	return nil
}

// parseBackendSessionState validates a backend snapshot without changing local
// state. Callers commit it only after every field is known-good.
func parseBackendSessionState(data json.RawMessage) (backendSessionState, error) {
	if string(data) == "null" {
		return backendSessionState{}, errors.New("decode backend state: state must be an object")
	}
	var state backendSessionState
	if err := json.Unmarshal(data, &state); err != nil {
		return backendSessionState{}, fmt.Errorf("decode backend state: %w", err)
	}
	if state.Model != nil && modelCatalogKey(state.Model.Provider, state.Model.ID) == "" {
		return backendSessionState{}, errors.New("decode backend state: model has blank provider or id")
	}
	if state.ThinkingLevel != nil && !isThinkingLevel(*state.ThinkingLevel) {
		return backendSessionState{}, fmt.Errorf("decode backend state: unsupported thinking level %q", *state.ThinkingLevel)
	}
	return state, nil
}

// applyBackendSessionStateLocked commits a previously validated backend
// snapshot. The caller must hold w.mu.
func (w *GmpWorkspace) applyBackendSessionStateLocked(state backendSessionState) {
	w.session.ID = state.SessionID
	if w.session.Title == "" {
		w.session.Title = state.SessionName
	}
	w.applyActiveModelLocked(state.Model, state.ThinkingLevel)
}

func (w *GmpWorkspace) syncMessages(ctx context.Context) error {
	if w.client == nil {
		return nil
	}
	resp, err := w.client.Call(ctx, ompclient.Command{Type: "get_messages"})
	if err != nil {
		return fmt.Errorf("get backend messages: %w", err)
	}
	var payload struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(resp.Data, &payload); err != nil {
		return fmt.Errorf("decode backend messages: %w", err)
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
	return nil
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
	// order while sendUI remains independent of a blocked Bubble Tea loop.
	if program != nil {
		w.startUIDrain()
	}
	w.startSideDrains()
	w.startEventsDrain()
}

// startSideDrains starts the three required response paths once. It is
// separate from the agent-event drainer: startup needs these consumers before
// its first RPC call, while agent events must wait for the snapshot commit.
func (w *GmpWorkspace) startSideDrains() {
	if w.client == nil {
		return
	}
	w.sideDrainOnce.Do(func() {
		go w.drainExtensionUI()
		go w.drainHostToolCalls()
		go w.drainHostToolCancels()
	})
}

// startEventsDrain attaches exactly one consumer to the transport event
// stream. Subscribe may rebind the Bubble Tea program, but it must never split
// events between multiple goroutines.
func (w *GmpWorkspace) startEventsDrain() {
	if w.client == nil {
		return
	}
	w.eventsDrainOnce.Do(func() {
		go w.drainEvents()
	})
}

func (w *GmpWorkspace) drainEvents() {
	defer w.setAgentBusy(false)
	for ev := range w.client.Events() {
		drainStep("drainEvents", func() { w.handleAgentEvent(ev) })
	}

	// The events channel only closes when the transport exits. Intentional
	// Shutdown leaves BackendExited open, so a clean quit has no false banner.
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
		if !w.sendUI(msg) {
			w.sendCancelledExtensionUIResponse(req.ID, req.Method)
		}
		return
	}
	if msg := w.translateToolApprovalRequest(req); msg != nil {
		if !w.sendUI(msg) {
			w.sendCancelledExtensionUIResponse(req.ID, req.Method)
		}
		return
	}
	w.sendCancelledExtensionUIResponse(req.ID, req.Method)
}

func (w *GmpWorkspace) sendCancelledExtensionUIResponse(id string, method string) {
	resp := buildCancelledExtensionUIResponse(id)
	if w.client == nil {
		return
	}
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

func (w *GmpWorkspace) sendUI(msg tea.Msg) bool {
	if msg == nil {
		return false
	}
	w.mu.RLock()
	if w.uiClosed {
		w.mu.RUnlock()
		return false
	}
	program := w.program
	events := w.events
	if program != nil {
		w.mu.RUnlock()
		return w.enqueueUI(msg)
	}
	if events == nil {
		w.mu.RUnlock()
		return false
	}
	select {
	case events <- msg:
		w.mu.RUnlock()
		return true
	default:
		w.mu.RUnlock()
		return false
	}
}

// enqueueUI adds one message to the mailbox. A pending nonterminal message
// update replaces the prior full snapshot for that message. Every other
// message is a FIFO barrier: later updates cannot replace snapshots from
// before that edge. The normal queue holds at most 256 slots. The 257th slot
// is reserved for one terminal overload message, then all later offers drop.
func (w *GmpWorkspace) enqueueUI(msg tea.Msg) bool {
	var client *ompclient.Client
	overloaded := false

	w.mu.Lock()
	if w.uiClosed || w.uiOverloaded {
		w.mu.Unlock()
		return false
	}
	if id, ok := pendingMessageUpdateID(msg); ok {
		if slot := w.uiMessageUpdates[id]; slot != nil {
			slot.msg = msg
			w.mu.Unlock()
			return true
		}
	}
	if len(w.uiMailbox) >= uiMailboxNormalCapacity {
		// The terminal slot makes the failure visible without dropping an
		// earlier edge. Latch under the same lock so concurrent producers
		// cannot append another terminal message or overrun the cap.
		w.uiOverloaded = true
		clear(w.uiMessageUpdates)
		w.uiMailbox = append(w.uiMailbox, &uiMailboxSlot{
			msg: BackendExitedMsg{Reason: BackendExitUIOverload},
		})
		client = w.client
		overloaded = true
	} else if id, ok := pendingMessageUpdateID(msg); ok {
		slot := &uiMailboxSlot{msg: msg}
		w.uiMailbox = append(w.uiMailbox, slot)
		w.uiMessageUpdates[id] = slot
	} else {
		clear(w.uiMessageUpdates)
		w.uiMailbox = append(w.uiMailbox, &uiMailboxSlot{msg: msg})
	}
	w.mu.Unlock()

	select {
	case w.uiWake <- struct{}{}:
	default:
	}
	if overloaded {
		// Client.Close waits for the reader. The terminal slot is already
		// latched, so one bounded closer preserves nonblocking producers.
		go w.closeClient(client)
	}
	return !overloaded
}

func (w *GmpWorkspace) startUIDrain() {
	w.mu.RLock()
	closed := w.uiClosed
	w.mu.RUnlock()
	if closed {
		return
	}
	w.uiDrainOnce.Do(func() { go w.drainUI() })
}

func pendingMessageUpdateID(msg tea.Msg) (string, bool) {
	event, ok := msg.(pubsub.Event[message.Message])
	if !ok || event.Type != pubsub.UpdatedEvent || event.Payload.ID == "" || event.Payload.IsFinished() {
		return "", false
	}
	return event.Payload.ID, true
}

func (w *GmpWorkspace) nextUIMessage() (tea.Msg, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.uiMailbox) == 0 {
		return nil, false
	}
	slot := w.uiMailbox[0]
	if len(w.uiMailbox) == 1 {
		w.uiMailbox = nil
	} else {
		w.uiMailbox[0] = nil
		w.uiMailbox = w.uiMailbox[1:]
	}
	if id, ok := pendingMessageUpdateID(slot.msg); ok && w.uiMessageUpdates[id] == slot {
		delete(w.uiMessageUpdates, id)
	}
	return slot.msg, true
}

// drainUI is the sole caller of Program.Send. It reads w.program for each
// message, so re-Subscribe uses the latest program and a nil gap drops safely.
func (w *GmpWorkspace) drainUI() {
	defer close(w.uiDrained)
	for {
		select {
		case <-w.uiDone:
			return
		case <-w.uiWake:
		}
		for {
			select {
			case <-w.uiDone:
				return
			default:
			}
			msg, ok := w.nextUIMessage()
			if !ok {
				break
			}
			w.mu.RLock()
			program := w.program
			closed := w.uiClosed
			w.mu.RUnlock()
			if !closed && program != nil {
				program.Send(msg)
			}
		}
	}
}
