package workspace

import (
	"encoding/json"
	"strings"
)

// mapWireToolName maps omp backend tool names onto the Crush renderer names the
// chat UI dispatches on (see internal/ui/chat/tools.go, which switches on
// toolCall.Name). omp emits `apply_patch` and `read`; the renderers key on
// `edit` and `view`. Names that already match (bash, write, grep, ...) pass
// through unchanged.
func mapWireToolName(name string) string {
	switch name {
	case "apply_patch":
		return "edit"
	case "read":
		return "view"
	default:
		return name
	}
}

// editResultMetadata mirrors tools.EditResponseMetadata's JSON tags. The Edit
// renderer (internal/ui/chat/file.go) unmarshals ToolResult.Metadata into that
// struct and re-diffs old_content vs new_content at the live terminal width.
type editResultMetadata struct {
	Additions  int    `json:"additions"`
	Removals   int    `json:"removals"`
	OldContent string `json:"old_content,omitempty"`
	NewContent string `json:"new_content,omitempty"`
}

// viewResultMetadata mirrors tools.ViewResponseMetadata. The View renderer reads
// meta.Content; we only synthesize it when the wire carries the clean
// displayContent (otherwise the renderer falls back to ToolResult.Content).
type viewResultMetadata struct {
	Content string `json:"content"`
}

// toWireToolResultMetadata synthesizes the JSON the Crush tool renderers expect
// in message.ToolResult.Metadata from an OMP-RPC WireToolResultV1
// ({content, details, presentation}). It returns "" when there is nothing to
// add, in which case the renderer falls back to ToolResult.Content / call args.
// toolName is the ORIGINAL wire name (apply_patch / read), not the remapped
// renderer name.
func toWireToolResultMetadata(toolName string, result json.RawMessage) string {
	switch toolName {
	case "apply_patch", "edit":
		return editMetadataFromWire(result)
	case "read", "view":
		return viewMetadataFromWire(result)
	default:
		// bash output and write content already render via ToolResult.Content
		// and call args; the richer fields (cwd, timings) are not on the wire.
		return ""
	}
}

// editMetadataFromWire reconstructs old/new file content from omp's numbered
// diff. omp does not ship old/new content or a presentation on the result frame
// (editToolPresenter has no presentResult); the only uniform, mode-agnostic
// source across replace/apply_patch is details.diff, where each row is
// "<prefix><lineNum>|<content>" with prefix '+' (added), '-' (removed), or
// ' ' (context shared by both sides). The reconstructed window is the diff hunk,
// not the whole file — which is exactly what the renderer shows.
func editMetadataFromWire(result json.RawMessage) string {
	var r struct {
		Details struct {
			Diff string `json:"diff"`
		} `json:"details"`
	}
	if err := json.Unmarshal(result, &r); err != nil || r.Details.Diff == "" {
		return ""
	}

	meta := editResultMetadata{}
	var oldLines, newLines []string
	for line := range strings.SplitSeq(r.Details.Diff, "\n") {
		if line == "" {
			continue
		}
		content := stripDiffLineNumber(line[1:])
		switch line[0] {
		case '+':
			newLines = append(newLines, content)
			meta.Additions++
		case '-':
			oldLines = append(oldLines, content)
			meta.Removals++
		case ' ':
			if content == "..." {
				continue // synthetic elided-context marker
			}
			oldLines = append(oldLines, content)
			newLines = append(newLines, content)
		default:
			oldLines = append(oldLines, line)
			newLines = append(newLines, line)
		}
	}
	meta.OldContent = strings.Join(oldLines, "\n")
	meta.NewContent = strings.Join(newLines, "\n")

	encoded, err := json.Marshal(meta)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// stripDiffLineNumber removes the leading "<lineNum>|" from an omp numbered diff
// row body (the part after the prefix char), returning just the line content.
func stripDiffLineNumber(s string) string {
	if _, content, found := strings.Cut(s, "|"); found {
		return content
	}
	return s
}

// viewMetadataFromWire upgrades a read result to the clean displayContent text
// (without hashline anchors) when present. When absent, returns "" so the View
// renderer uses ToolResult.Content.
func viewMetadataFromWire(result json.RawMessage) string {
	var r struct {
		Details struct {
			DisplayContent struct {
				Text string `json:"text"`
			} `json:"displayContent"`
		} `json:"details"`
	}
	if err := json.Unmarshal(result, &r); err != nil || r.Details.DisplayContent.Text == "" {
		return ""
	}
	encoded, err := json.Marshal(viewResultMetadata{Content: r.Details.DisplayContent.Text})
	if err != nil {
		return ""
	}
	return string(encoded)
}
