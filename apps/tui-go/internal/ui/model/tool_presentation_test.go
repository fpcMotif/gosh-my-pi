package model

import (
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/chat"
	"github.com/stretchr/testify/require"
)

func TestUpdateSessionMessageAppliesLateToolCallPresentation(t *testing.T) {
	t.Parallel()
	u := newTestUI()
	toolCall := message.ToolCall{
		ID:    "call-1",
		Name:  "future_tool",
		Input: `{"path":"a.go"}`,
	}
	item := chat.NewToolMessageItem(u.com.Styles, "assistant-1", toolCall, nil, false)
	u.chat.SetMessages(item)
	presentation := &message.ToolPresentation{
		Type:   message.ToolPresentationTypeStatus,
		Status: &message.ToolPresentationStatus{Title: "Late presentation"},
	}
	toolCall.Presentation = presentation

	u.updateSessionMessage(message.Message{
		ID:    "assistant-1",
		Role:  message.Assistant,
		Parts: []message.ContentPart{toolCall},
	})

	require.Same(t, presentation, item.ToolCall().Presentation)
}
