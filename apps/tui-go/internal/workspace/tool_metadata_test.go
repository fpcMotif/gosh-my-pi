package workspace

import (
	"encoding/json"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

// The Crush tool renderers dispatch on toolCall.Name (internal/ui/chat/tools.go)
// and draw diffs/file views by unmarshalling ToolResult.Metadata. omp emits
// `apply_patch`/`read` and never populates Metadata, so cards rendered as plain
// text. These contracts pin the wire -> Crush translation (gap G2).

func TestMapWireToolName(t *testing.T) {
	cases := map[string]string{
		"apply_patch": "edit",
		"read":        "view",
		"bash":        "bash",
		"write":       "write",
		"grep":        "grep",
	}
	for in, want := range cases {
		if got := mapWireToolName(in); got != want {
			t.Errorf("mapWireToolName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestToWireToolResultMetadataEditDiff(t *testing.T) {
	// omp apply_patch result: details.diff in the numbered
	// "<prefix><lineNum>|<content>" format (edit/diff.ts formatNumberedDiffLine).
	result := json.RawMessage(`{
		"content": [{"type":"text","text":"Updated /tmp/x.txt"}],
		"details": {
			"diff": " 1|first line\n-2|old line two\n-3|old line three\n+2|new line two\n+3|new line three\n 4|fourth line",
			"op": "update"
		}
	}`)
	got := toWireToolResultMetadata("apply_patch", result)
	if got == "" {
		t.Fatal("expected non-empty metadata for an apply_patch diff")
	}
	var meta struct {
		Additions  int    `json:"additions"`
		Removals   int    `json:"removals"`
		OldContent string `json:"old_content"`
		NewContent string `json:"new_content"`
	}
	if err := json.Unmarshal([]byte(got), &meta); err != nil {
		t.Fatalf("metadata is not valid JSON: %v (%s)", err, got)
	}
	if meta.Additions != 2 || meta.Removals != 2 {
		t.Errorf("additions/removals = %d/%d, want 2/2", meta.Additions, meta.Removals)
	}
	wantOld := "first line\nold line two\nold line three\nfourth line"
	wantNew := "first line\nnew line two\nnew line three\nfourth line"
	if meta.OldContent != wantOld {
		t.Errorf("old_content = %q, want %q", meta.OldContent, wantOld)
	}
	if meta.NewContent != wantNew {
		t.Errorf("new_content = %q, want %q", meta.NewContent, wantNew)
	}
}

func TestToWireToolResultMetadataViewUsesDisplayContent(t *testing.T) {
	result := json.RawMessage(`{
		"content": [{"type":"text","text":"1|hello"}],
		"details": {"displayContent": {"text": "hello\nworld", "startLine": 1}}
	}`)
	got := toWireToolResultMetadata("read", result)
	var meta struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(got), &meta); err != nil {
		t.Fatalf("view metadata invalid: %v (%s)", err, got)
	}
	if meta.Content != "hello\nworld" {
		t.Errorf("view content = %q, want clean displayContent", meta.Content)
	}
}

func TestToWireToolResultMetadataEmptyForPlainTools(t *testing.T) {
	// bash/write render via ToolResult.Content / call-args fallback; nothing to add.
	if got := toWireToolResultMetadata("bash", json.RawMessage(`{"content":[{"type":"text","text":"hi"}]}`)); got != "" {
		t.Errorf("bash metadata = %q, want empty", got)
	}
	if got := toWireToolResultMetadata("edit", json.RawMessage(`{"content":[]}`)); got != "" {
		t.Errorf("edit with no diff = %q, want empty", got)
	}
}

// Wiring: a tool_execution_end frame must produce a ToolResult whose Name is
// remapped to the renderer key and whose Metadata carries the translated diff.
func TestHandleToolExecutionEndPopulatesEditMetadata(t *testing.T) {
	w := newTestGmpWorkspace()
	raw := []byte(`{"toolCallId":"call-1","toolName":"apply_patch","isError":false,` +
		`"result":{"content":[{"type":"text","text":"Updated"}],"details":{"diff":"-1|a\n+1|b"}}}`)

	msg := w.handleToolExecutionEnd(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleToolExecutionEnd returned %T, want pubsub.Event[message.Message]", msg)
	}
	if len(ev.Payload.Parts) == 0 {
		t.Fatal("result message has no parts")
	}
	tr, ok := ev.Payload.Parts[0].(message.ToolResult)
	if !ok {
		t.Fatalf("part 0 is %T, want message.ToolResult", ev.Payload.Parts[0])
	}
	if tr.Name != "edit" {
		t.Errorf("ToolResult.Name = %q, want remapped %q", tr.Name, "edit")
	}
	if tr.Metadata == "" {
		t.Error("ToolResult.Metadata empty; the edit diff was not translated")
	}
}
