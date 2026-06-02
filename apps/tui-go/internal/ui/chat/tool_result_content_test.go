package chat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

func TestHumanizedToolName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "snake case", input: "mcp_github_get", want: "Mcp Github Get"},
		{name: "kebab case", input: "web-fetch", want: "Web Fetch"},
		{name: "mixed", input: "job_output-tool", want: "Job Output Tool"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := humanizedToolName(tt.input); got != tt.want {
				t.Fatalf("humanizedToolName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLooksLikeMarkdown(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{name: "header", content: "# Title", want: true},
		{name: "code fence", content: "```go\nfmt.Println(\"x\")\n```", want: true},
		{name: "plain", content: "hello world", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := looksLikeMarkdown(tt.content); got != tt.want {
				t.Fatalf("looksLikeMarkdown() = %v, want %v", got, tt.want)
			}
		})
	}
}

// An image tool result must actually render its image card (the "Loaded Image"
// indicator with MIME type + size), not vanish — even when there is no text
// content, which is the common case for reading an image file (gap G14). This
// pins the renderer contract: every image-capable tool renderer consumes
// Result.Data + Result.MIMEType. The Generic fallback previously dropped
// image-only results because it returned early on empty Content.
func TestToolRenderersShowImageResult(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

	renderers := map[string]ToolRenderer{
		"generic": &GenericToolRenderContext{},
		"view":    &ViewToolRenderContext{},
	}
	for name, rc := range renderers {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			opts := &ToolRenderOpts{
				ToolCall: message.ToolCall{Name: "read", Input: `{"file_path":"/tmp/a.png"}`, Finished: true},
				Result:   &message.ToolResult{Data: pngB64, MIMEType: "image/png", Content: ""},
				Status:   ToolStatusSuccess,
			}
			out := rc.RenderTool(&sty, 80, opts)
			if !strings.Contains(out, "Loaded Image") {
				t.Fatalf("%s renderer dropped the image-only result, got: %q", name, out)
			}
			if !strings.Contains(out, "image/png") {
				t.Fatalf("%s renderer omitted the MIME type, got: %q", name, out)
			}
		})
	}
}

func TestRenderToolResultTextContent(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	styPtr := &sty
	widths := toolResultContentWidths{Body: 80, Diff: 82}

	t.Run("json branch", func(t *testing.T) {
		t.Parallel()
		content := `{"a":1}`
		var result json.RawMessage
		if err := json.Unmarshal([]byte(content), &result); err != nil {
			t.Fatalf("json.Unmarshal() error = %v", err)
		}
		prettyResult, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			t.Fatalf("json.MarshalIndent() error = %v", err)
		}
		expected := styPtr.Tool.Body.Render(toolOutputCodeContent(styPtr, "result.json", string(prettyResult), 0, widths.Body, false))
		got := renderToolResultTextContent(styPtr, content, widths, false)
		if got != expected {
			t.Fatal("renderToolResultTextContent() did not choose JSON rendering")
		}
	})

	t.Run("diff branch before markdown", func(t *testing.T) {
		t.Parallel()
		content := `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# Old
+# New
`
		expected := toolOutputDiffContentFromUnified(styPtr, content, widths.Diff, false)
		got := renderToolResultTextContent(styPtr, content, widths, false)
		if got != expected {
			t.Fatal("renderToolResultTextContent() did not choose diff rendering")
		}
	})

	t.Run("markdown branch", func(t *testing.T) {
		t.Parallel()
		content := "# Title\n\nBody"
		expected := styPtr.Tool.Body.Render(toolOutputCodeContent(styPtr, "result.md", content, 0, widths.Body, false))
		got := renderToolResultTextContent(styPtr, content, widths, false)
		if got != expected {
			t.Fatal("renderToolResultTextContent() did not choose markdown rendering")
		}
	})

	t.Run("plain branch", func(t *testing.T) {
		t.Parallel()
		content := "plain text"
		expected := styPtr.Tool.Body.Render(toolOutputPlainContent(styPtr, content, widths.Body, false))
		got := renderToolResultTextContent(styPtr, content, widths, false)
		if got != expected {
			t.Fatal("renderToolResultTextContent() did not choose plain rendering")
		}
	})
}
