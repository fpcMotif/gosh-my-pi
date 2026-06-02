package workspace

import (
	"testing"
	"time"
)

// Host-side tools are an intentional gmp-mode limitation (G29): the Go frontend
// registers none, so an inbound host_tool_call must always get an isError reply
// and never wedge the read loop waiting for a response that won't come.
func TestDrainHostToolCallsRejectsWithoutDeadlock(t *testing.T) {
	w, pc := gmpWorkspaceWithClient(t)
	defer pc.close()

	go w.drainHostToolCalls()

	if err := pc.writeInbound(map[string]any{
		"type":       "host_tool_call",
		"id":         "ht-1",
		"toolCallId": "tc-1",
		"toolName":   "some_host_tool",
		"arguments":  map[string]any{},
	}); err != nil {
		t.Fatalf("writeInbound: %v", err)
	}

	frame := pc.waitForFrame(t, 2*time.Second)
	if frame["type"] != "host_tool_result" {
		t.Fatalf("reply type = %v, want host_tool_result", frame["type"])
	}
	if frame["id"] != "ht-1" {
		t.Errorf("reply id = %v, want ht-1 (correlation preserved)", frame["id"])
	}
	if frame["isError"] != true {
		t.Errorf("reply isError = %v, want true", frame["isError"])
	}
}
