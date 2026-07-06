package chat

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

// A tool the user denied via the approval gate (G11) is a routine choice, not a
// failure, so it must render an amber WARN tag, not a red ERROR tag (gap G19).
func TestToolErrorContentWarnsOnUserDenial(t *testing.T) {
	t.Parallel()
	sty := styles.CharmtonePantera()

	for _, content := range []string{"Denied by user.", "User denied permission"} {
		denied := &message.ToolResult{Content: content, IsError: true}
		out := toolErrorContent(&sty, denied, 80)
		if !strings.Contains(out, "WARN") {
			t.Errorf("denied tool (%q) should render a WARN tag, got: %q", content, out)
		}
		if strings.Contains(out, "ERROR") {
			t.Errorf("denied tool (%q) should not render an ERROR tag, got: %q", content, out)
		}
	}

	realErr := &message.ToolResult{Content: "file not found", IsError: true}
	out := toolErrorContent(&sty, realErr, 80)
	if !strings.Contains(out, "ERROR") {
		t.Errorf("a real error should still render an ERROR tag, got: %q", out)
	}
}
