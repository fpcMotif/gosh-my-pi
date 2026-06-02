package workspace

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/agent/notify"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

// maxDiagnosticLogBytes caps how much of a diagnostic frame payload is logged.
// Diagnostic frames (_raw / extension_error) can embed arbitrarily large tool
// output, so the full body must never reach the log verbatim.
const maxDiagnosticLogBytes = 512

// truncateForLog renders a frame payload for a log line, capping its length so
// a runaway frame can't flood the log. Truncation is annotated with the
// original byte length so the elision is visible.
func truncateForLog(payload []byte) string {
	if len(payload) <= maxDiagnosticLogBytes {
		return string(payload)
	}
	return string(payload[:maxDiagnosticLogBytes]) + fmt.Sprintf("…(+%d bytes truncated)", len(payload)-maxDiagnosticLogBytes)
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
			reason, text := message.FinishReasonEndTurn, ""
			if desc, ok := describeAgentErrorKind(ev.Payload); ok {
				reason, text = message.FinishReasonError, desc
			}
			if msg := w.finishAssistant(reason, text, ""); msg != nil {
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
	case "_raw", "extension_error":
		// Diagnostic frames from the transport: malformed/unparseable frames
		// (_raw) and extension-hook errors surfaced by the backend
		// (extension_error, G22). They are not part of the agent event stream,
		// but dropping them silently leaves a frozen-looking transcript with no
		// observable cause — log so the failure is diagnosable. Truncate the
		// payload: a runaway frame (e.g. a multi-MB scraped page surfaced in a
		// tool error) would otherwise flood the log file.
		slog.Warn("gmp workspace: diagnostic frame", "kind", ev.Kind, "payload", truncateForLog(ev.Payload))
		return nil
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
		if id, ok := w.reconcileUserIDLocked(msg); ok {
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
			Type         string          `json:"type"`
			Delta        string          `json:"delta"`
			ContentIndex int             `json:"contentIndex"`
			Partial      json.RawMessage `json:"partial"`
			ToolCall     json.RawMessage `json:"toolCall"`
			Error        *struct {
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
		case "toolcall_start", "toolcall_delta":
			// Reconcile the in-progress tool call from the `partial` snapshot
			// rather than accumulating `delta`. `partial.content[contentIndex]`
			// is the backend's fully-parsed accumulated tool call (id, name,
			// arguments), so this is immune to dropped or duplicated deltas and
			// always yields valid JSON args. AddToolCall is keyed by id, so the
			// same toolCallId arriving later via tool_execution_start updates
			// the same card instead of creating a duplicate.
			tc, ok := toolCallFromPartial(ev.Partial, ev.ContentIndex)
			if !ok {
				return nil
			}
			return w.updateAssistant(func(msg *message.Message) {
				msg.AddToolCall(tc)
			})
		case "toolcall_end":
			tc, ok := toolCallFromWireBlock(ev.ToolCall)
			if !ok {
				tc, ok = toolCallFromPartial(ev.Partial, ev.ContentIndex)
			}
			if !ok {
				return nil
			}
			tc.Finished = true
			return w.updateAssistant(func(msg *message.Message) {
				msg.AddToolCall(tc)
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
		if id, ok := w.reconcileUserIDLocked(msg); ok {
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
		if id, ok := w.reconcileUserIDLocked(msg); ok {
			msg.ID = id
		}
	}
	if msg.Role == message.Assistant && w.currentAssistantID != "" {
		msg.ID = w.currentAssistantID
	}
	applyWireErrorKind(&msg, raw)
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
			if id, ok := w.reconcileUserIDLocked(msg); ok {
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
		applyWireErrorKind(&msg, raw)
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
			Name:  mapWireToolName(p.ToolName),
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
	metadata := toWireToolResultMetadata(p.ToolName, p.PartialResult)
	sessionID := w.sessionID()
	w.mu.Lock()
	msg, ok := w.messages[id]
	if ok && len(msg.Parts) > 0 {
		if tr, ok := msg.Parts[0].(message.ToolResult); ok {
			tr.Content = content
			tr.Metadata = metadata
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
					Name:       mapWireToolName(p.ToolName),
					Content:    content,
					Metadata:   metadata,
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
				Name:       mapWireToolName(p.ToolName),
				Content:    stringifyToolResult(p.Result),
				Metadata:   toWireToolResultMetadata(p.ToolName, p.Result),
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

// reconcileUserIDLocked resolves the local id for an inbound user message.
// When the backend echoed our correlation id (msg.ID is already a known local
// message), that id is authoritative and no content matching is performed —
// this is robust even when two user messages share identical text. Older
// backends that do not echo the id fall back to content matching.
func (w *GmpWorkspace) reconcileUserIDLocked(msg message.Message) (string, bool) {
	if _, known := w.messages[msg.ID]; known {
		return msg.ID, true
	}
	return w.matchingUserIDLocked(msg.Content().Text)
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
