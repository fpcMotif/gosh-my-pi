package workspace

import "testing"

// A `developer` role message is a real OMP-RPC message variant; it must render
// its content, not the literal "[developer message]" placeholder (gap G13).
func TestParseAgentMessageDeveloperRole(t *testing.T) {
	w := newTestGmpWorkspace()
	msg, ok := w.parseAgentMessage([]byte(`{"role":"developer","content":"do the thing","timestamp":0}`), "")
	if !ok {
		t.Fatal("parseAgentMessage returned ok=false for a developer message")
	}
	if got := msg.Content().Text; got != "do the thing" {
		t.Errorf("developer message text = %q, want %q (not a placeholder)", got, "do the thing")
	}
}
