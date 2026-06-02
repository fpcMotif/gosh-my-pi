package workspace

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
)

// toolCallFromPartial extracts the tool call at contentIndex from a streaming
// `partial` WireAssistantMessageV1 snapshot. It returns false when the index is
// out of range or the block at that index is not a tool call (e.g. interleaved
// text/thinking blocks), so callers ignore non-tool-call sub-events safely.
func toolCallFromPartial(partial json.RawMessage, contentIndex int) (message.ToolCall, bool) {
	if len(partial) == 0 || contentIndex < 0 {
		return message.ToolCall{}, false
	}
	var p struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(partial, &p); err != nil {
		return message.ToolCall{}, false
	}
	if contentIndex >= len(p.Content) {
		return message.ToolCall{}, false
	}
	return toolCallFromWireBlock(p.Content[contentIndex])
}

// toolCallFromWireBlock parses a single WireToolCallV1 content block
// ({type:"toolCall", id, name, arguments}) into a message.ToolCall. The wire
// `arguments` is an already-parsed JSON object, so re-marshaling always yields
// valid JSON for the renderers. The tool name is mapped to the renderer name to
// match handleToolExecutionStart, keeping a single card across both paths.
func toolCallFromWireBlock(block json.RawMessage) (message.ToolCall, bool) {
	if len(block) == 0 {
		return message.ToolCall{}, false
	}
	var tc struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(block, &tc); err != nil || tc.Type != "toolCall" || tc.ID == "" {
		return message.ToolCall{}, false
	}
	input := string(tc.Arguments)
	if input == "" {
		input = "{}"
	}
	return message.ToolCall{
		ID:    tc.ID,
		Name:  mapWireToolName(tc.Name),
		Input: input,
	}, true
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
		// ID is the host correlation id the backend echoes for user/developer
		// messages (WireUserMessageV1.id). When present it is the very id this
		// frontend assigned and sent as clientMessageId, so reconciliation is a
		// direct id hit rather than content matching.
		ID string `json:"id"`
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
		msg.ID = correlatedID(probe.ID, w.nextID("user"))
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
	case "custom", "hookMessage", "developer":
		msg.Parts = w.parseTextWrappedContent(body)
		msg.ID = correlatedID(probe.ID, w.nextID("custom"))
	default:
		msg.Parts = []message.ContentPart{message.TextContent{Text: fmt.Sprintf("[%s message]", probe.Role)}}
		msg.ID = w.nextID("unknown")
	}

	return msg, true
}

// correlatedID returns the backend-echoed correlation id when present,
// otherwise the freshly-generated fallback. A non-empty wire id is the id this
// frontend originally assigned and sent as clientMessageId, so using it
// directly turns reconciliation into a map hit instead of content matching.
func correlatedID(wireID, fallback string) string {
	if wireID != "" {
		return wireID
	}
	return fallback
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
		case "redactedThinking":
			// Redacted reasoning is opaque-by-design (the wire carries only an
			// opaque `data` blob). Render a placeholder so the content count
			// matches the wire and the block is not silently dropped.
			parts = append(parts, message.ReasoningContent{Thinking: "[redacted]", StartedAt: time.Now().Unix()})
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
	data, mimeType := extractImageContent(p.Content)
	return []message.ContentPart{
		message.ToolResult{
			ToolCallID: p.ToolCallID,
			Name:       mapWireToolName(p.ToolName),
			Content:    extractTextString(p.Content),
			Data:       data,
			MIMEType:   mimeType,
			Metadata:   toWireToolResultMetadata(p.ToolName, raw),
			IsError:    p.IsError,
		},
	}
}

// extractImageContent returns the first image block's base64 data and MIME type
// from an RPC content value ([]{type:"image",data,mimeType}). The renderers
// (internal/ui/chat) consume Data as a base64 string and compute the size from
// it, so it is passed through undecoded.
func extractImageContent(content any) (data, mimeType string) {
	blocks, ok := content.([]any)
	if !ok {
		return "", ""
	}
	for _, item := range blocks {
		m, ok := item.(map[string]any)
		if !ok || m["type"] != "image" {
			continue
		}
		d, _ := m["data"].(string)
		if d == "" {
			continue
		}
		mt, _ := m["mimeType"].(string)
		return d, mt
	}
	return "", ""
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
