package workspace

import (
	"encoding/json"
	"log/slog"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
)

func decodeToolPresentation(raw json.RawMessage) *message.ToolPresentation {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}

	var probe struct {
		Type message.ToolPresentationType `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil || probe.Type == "" {
		logMalformedToolPresentation(raw)
		return nil
	}
	switch probe.Type {
	case message.ToolPresentationTypeStatus,
		message.ToolPresentationTypeBlock,
		message.ToolPresentationTypeCode:
		var presentation message.ToolPresentation
		if err := json.Unmarshal(raw, &presentation); err != nil || !presentation.Usable() {
			logMalformedToolPresentation(raw)
			return nil
		}
		return &presentation
	default:
		// Keep the discriminator so consumers can distinguish an unsupported
		// additive variant from an absent presentation.
		return &message.ToolPresentation{Type: probe.Type}
	}
}

func toolResultPresentation(raw json.RawMessage) *message.ToolPresentation {
	var result struct {
		Presentation json.RawMessage `json:"presentation"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil
	}
	return decodeToolPresentation(result.Presentation)
}

func toolResultMetadata(
	toolName string,
	result json.RawMessage,
	presentation *message.ToolPresentation,
) string {
	if presentation.Usable() {
		return ""
	}
	return toWireToolResultMetadata(toolName, result)
}

func logMalformedToolPresentation(raw json.RawMessage) {
	slog.Warn("Gmp workspace: malformed tool presentation", "presentation", truncateForLog(raw))
}
