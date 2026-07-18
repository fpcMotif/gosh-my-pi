package chat

import (
	"testing"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/stretchr/testify/require"
)

func TestAssistantInfoItemRendersResolvedModelDisplayInfo(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	msg := &message.Message{
		ID:       "assistant-info",
		Role:     message.Assistant,
		Model:    "claude-sonnet-4",
		Provider: "anthropic",
		Parts: []message.ContentPart{
			message.Finish{Reason: message.FinishReasonEndTurn, Time: 2},
		},
	}
	item := NewAssistantInfoItem(&sty, msg, ModelDisplayInfo{
		ModelName:    "Claude Sonnet 4",
		ProviderName: "Anthropic",
	}, time.Unix(1, 0))

	rendered := item.RawRender(100)
	require.Contains(t, rendered, "Claude Sonnet 4")
	require.Contains(t, rendered, "via Anthropic")
}

func TestAssistantInfoItemRendersModelIDFallbacks(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	msg := &message.Message{
		ID:       "assistant-info-fallback",
		Role:     message.Assistant,
		Model:    "gpt-5.3-codex",
		Provider: "openai-codex",
		Parts: []message.ContentPart{
			message.Finish{Reason: message.FinishReasonEndTurn, Time: 2},
		},
	}
	item := NewAssistantInfoItem(&sty, msg, ModelDisplayInfo{
		ModelName:    msg.Model,
		ProviderName: msg.Provider,
	}, time.Unix(1, 0))

	rendered := item.RawRender(100)
	require.Contains(t, rendered, "gpt-5.3-codex")
	require.Contains(t, rendered, "via openai-codex")
	require.NotContains(t, rendered, "Unknown Model")
}
