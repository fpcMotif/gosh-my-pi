package chat

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

// While a bash command is executing the resolved command is already present in
// the call args (tool_execution_start), but the card showed only a bare spinner
// until the result arrived (gap G4). The command must be visible while running.
func TestBashRenderShowsCommandWhilePending(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	ctx := &BashToolRenderContext{}
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{
			Name:     "bash",
			Input:    `{"command":"echo hello-world","description":"greet"}`,
			Finished: false, // still running
		},
		Status: ToolStatusRunning,
	}

	got := ctx.RenderTool(&sty, 80, opts)

	if !strings.Contains(got, "echo hello-world") {
		t.Errorf("running bash render hides the command:\n%s", got)
	}
	if bare := pendingTool(&sty, "Bash", opts.Anim, opts.Compact); got == bare {
		t.Error("running bash render is the bare spinner, want a command preview")
	}
}

// With no parseable args yet, the bare spinner is still the right fallback.
func TestBashRenderBareSpinnerWithoutArgs(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()
	ctx := &BashToolRenderContext{}
	opts := &ToolRenderOpts{
		ToolCall: message.ToolCall{Name: "bash", Input: "", Finished: false},
		Status:   ToolStatusRunning,
	}

	got := ctx.RenderTool(&sty, 80, opts)
	if bare := pendingTool(&sty, "Bash", opts.Anim, opts.Compact); got != bare {
		t.Errorf("without args, want the bare spinner, got:\n%s", got)
	}
}
