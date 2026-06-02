package chat

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

// During true streaming the tool card materializes from the model's partial
// args. The workspace reconciles tool calls from the backend `partial` snapshot,
// so the Input is valid JSON carrying whatever fields have streamed so far. A
// streamed-but-unfinished command must show up in the card, not a bare spinner.
func TestBashRenderStreamingPartialArgsShowsCommand(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	ctx := &BashToolRenderContext{}
	// Valid JSON, only the command field present so far (mid-stream snapshot).
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{
			Name:     "bash",
			Input:    `{"command":"git status"}`,
			Finished: false,
		},
		Status: ToolStatusRunning,
	}

	got := ctx.RenderTool(&sty, 80, opts)
	if !strings.Contains(got, "git status") {
		t.Errorf("streaming bash render hides the partial command:\n%s", got)
	}
}

// Unterminated/partial JSON must not panic the renderer; it degrades to the
// pending spinner because no command can be parsed yet.
func TestBashRenderUnterminatedJSONDoesNotPanic(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	ctx := &BashToolRenderContext{}
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{
			Name:     "bash",
			Input:    `{"command":"echo partia`, // truncated mid-stream JSON
			Finished: false,
		},
		Status: ToolStatusRunning,
	}

	// The contract is: no panic. (RenderTool would panic before returning.)
	got := ctx.RenderTool(&sty, 80, opts)
	if got == "" {
		t.Error("renderer returned empty output for partial JSON")
	}
}

// A generic (unknown) tool with partial-but-valid streamed args must render its
// header without panicking while still pending.
func TestGenericRenderStreamingPartialArgsDoesNotPanic(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	ctx := &GenericToolRenderContext{}
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{
			Name:     "some_mcp_tool",
			Input:    `{"query":"partial"}`,
			Finished: false,
		},
		Status: ToolStatusRunning,
	}

	got := ctx.RenderTool(&sty, 80, opts)
	if got == "" {
		t.Error("generic renderer returned empty output for pending streamed tool")
	}
}
