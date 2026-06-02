package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ompclient"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/pubsub"
)

// Cross-language golden wire fixtures (gap G23).
//
// These fixtures are the EXACT wire JSON a real omp --mode rpc backend emits.
// The TypeScript encoder is pinned against the same files in
// packages/coding-agent/src/modes/rpc/wire/golden-fixtures.test.ts; this suite
// decodes them through the REAL Go bridge path and asserts the resulting Crush
// message/struct shapes. A field rename on either side breaks one of the two
// suites, catching wire drift the independent per-side suites miss.
//
// See ../../../../packages/coding-agent/src/modes/rpc/wire/__fixtures__/wire-v1/README.md.

// wireFixturesDir is the single shared fixtures directory, relative to this Go
// package (apps/tui-go/internal/workspace). go test runs with the package dir
// as the working directory, so the relative path resolves deterministically.
const wireFixturesDir = "../../../../packages/coding-agent/src/modes/rpc/wire/__fixtures__/wire-v1"

func loadWireFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(wireFixturesDir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func toolResultPart(t *testing.T, msg tea.Msg) message.ToolResult {
	t.Helper()
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handler returned %T, want pubsub.Event[message.Message]", msg)
	}
	if len(ev.Payload.Parts) == 0 {
		t.Fatal("result message has no parts")
	}
	tr, ok := ev.Payload.Parts[0].(message.ToolResult)
	if !ok {
		t.Fatalf("part 0 is %T, want message.ToolResult", ev.Payload.Parts[0])
	}
	return tr
}

// TestWireGoldenReadyFrame: the ready handshake decodes into ompclient.ReadyFrame
// with the schema the Go client expects (ExpectedSchema).
func TestWireGoldenReadyFrame(t *testing.T) {
	raw := loadWireFixture(t, "ready.json")
	var frame ompclient.ReadyFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("decode ready frame: %v", err)
	}
	if frame.Type != "ready" {
		t.Errorf("ready Type = %q, want %q", frame.Type, "ready")
	}
	if frame.Schema != ompclient.ExpectedSchema {
		t.Errorf("ready Schema = %q, want ExpectedSchema %q", frame.Schema, ompclient.ExpectedSchema)
	}
}

// TestWireGoldenAgentEndErrorKind: the agent_end usage_limit fixture decodes to
// the usage-limit description through the real describeAgentErrorKind seam.
func TestWireGoldenAgentEndErrorKind(t *testing.T) {
	raw := loadWireFixture(t, "agent_end.error_kind.json")
	desc, ok := describeAgentErrorKind(raw)
	if !ok {
		t.Fatal("describeAgentErrorKind ok=false, want a usage-limit description")
	}
	if !strings.Contains(desc, "Usage limit") {
		t.Errorf("description %q does not name the usage limit", desc)
	}
	// 30000ms must humanize into the retry window the card shows.
	if !strings.Contains(desc, "30s") {
		t.Errorf("description %q does not carry the 30s retry window", desc)
	}
}

// TestWireGoldenAgentEndNoErrorKind: the plain agent_end fixture has no
// errorKind, so the bridge falls through to a clean end-turn (no error desc).
func TestWireGoldenAgentEndNoErrorKind(t *testing.T) {
	raw := loadWireFixture(t, "agent_end.json")
	if _, ok := describeAgentErrorKind(raw); ok {
		t.Error("describeAgentErrorKind ok=true on a fixture with no errorKind, want false")
	}

	// And it decodes into messages through the real handler.
	w := newTestGmpWorkspace()
	events := w.handleAgentEnd(raw)
	if len(events) != 2 {
		t.Fatalf("handleAgentEnd produced %d events, want 2 (user + assistant)", len(events))
	}
}

// TestWireGoldenMessageEndErrorKind: the message_end context_overflow fixture
// enriches the assistant card's finish with the overflow reason.
func TestWireGoldenMessageEndErrorKind(t *testing.T) {
	raw := loadWireFixture(t, "message_end.error_kind.json")
	w := newTestGmpWorkspace()
	w.currentAssistantID = "asst-golden"

	msg := w.handleMessageEnd(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleMessageEnd returned %T, want pubsub.Event[message.Message]", msg)
	}
	fin, ok := finishPart(ev.Payload)
	if !ok {
		t.Fatal("assistant message has no Finish after message_end with errorKind")
	}
	if fin.Reason != message.FinishReasonError {
		t.Errorf("Finish.Reason = %q, want %q", fin.Reason, message.FinishReasonError)
	}
	if !strings.Contains(fin.Message, "Context window full") {
		t.Errorf("Finish.Message = %q, want context-overflow text", fin.Message)
	}
}

// TestWireGoldenMessageStart: the message_start assistant fixture decodes into
// a created assistant message.
func TestWireGoldenMessageStart(t *testing.T) {
	raw := loadWireFixture(t, "message_start.json")
	w := newTestGmpWorkspace()

	msg := w.handleMessageStart(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleMessageStart returned %T, want pubsub.Event[message.Message]", msg)
	}
	if ev.Payload.Role != message.Assistant {
		t.Errorf("message_start role = %q, want assistant", ev.Payload.Role)
	}
}

// TestWireGoldenMessageUpdateTextDelta: the text_delta fixture appends its delta
// to the streaming assistant message.
func TestWireGoldenMessageUpdateTextDelta(t *testing.T) {
	raw := loadWireFixture(t, "message_update.text_delta.json")
	w := newTestGmpWorkspace()

	msg := w.handleMessageUpdate(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleMessageUpdate returned %T, want pubsub.Event[message.Message]", msg)
	}
	if ev.Type != pubsub.UpdatedEvent {
		t.Errorf("event type = %v, want UpdatedEvent", ev.Type)
	}
	if got := ev.Payload.Content().Text; got != "Hello" {
		t.Errorf("streamed assistant text = %q, want %q", got, "Hello")
	}
}

// TestWireGoldenMessageUpdateToolcallEnd: the toolcall_end fixture is a valid
// message_update; it carries no text/thinking/error sub-event, so it projects
// the (toolCall-only) assistant message rather than appending stream text.
func TestWireGoldenMessageUpdateToolcallEnd(t *testing.T) {
	raw := loadWireFixture(t, "message_update.toolcall_end.json")
	w := newTestGmpWorkspace()

	msg := w.handleMessageUpdate(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleMessageUpdate returned %T, want pubsub.Event[message.Message]", msg)
	}
	if ev.Payload.Role != message.Assistant {
		t.Errorf("toolcall_end update role = %q, want assistant", ev.Payload.Role)
	}
}

// TestWireGoldenToolExecutionStart: the bash start fixture creates an unfinished
// bash tool call on the assistant message.
func TestWireGoldenToolExecutionStart(t *testing.T) {
	raw := loadWireFixture(t, "tool_execution_start.json")
	w := newTestGmpWorkspace()

	msg := w.handleToolExecutionStart(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleToolExecutionStart returned %T, want pubsub.Event[message.Message]", msg)
	}
	calls := ev.Payload.ToolCalls()
	if len(calls) != 1 {
		t.Fatalf("tool calls = %d, want 1", len(calls))
	}
	if calls[0].Name != "bash" {
		t.Errorf("tool call name = %q, want bash (no remap)", calls[0].Name)
	}
	if calls[0].Finished {
		t.Error("tool call is finished on start, want unfinished")
	}
	if !strings.Contains(calls[0].Input, "ls -la") {
		t.Errorf("tool call input = %q, want it to carry the command args", calls[0].Input)
	}
}

// TestWireGoldenToolExecutionUpdate: the read update fixture creates a tool
// result whose name is remapped to the renderer key (view) and whose metadata
// carries the clean displayContent.
func TestWireGoldenToolExecutionUpdate(t *testing.T) {
	raw := loadWireFixture(t, "tool_execution_update.json")
	w := newTestGmpWorkspace()

	tr := toolResultPart(t, w.handleToolExecutionUpdate(raw))
	if tr.Name != "view" {
		t.Errorf("ToolResult.Name = %q, want remapped %q", tr.Name, "view")
	}
	var meta struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(tr.Metadata), &meta); err != nil {
		t.Fatalf("view metadata invalid: %v (%s)", err, tr.Metadata)
	}
	if meta.Content != "const value = 1;" {
		t.Errorf("view metadata content = %q, want the clean displayContent", meta.Content)
	}
}

// TestWireGoldenToolExecutionEndEditDiff: the apply_patch end fixture remaps to
// the edit renderer and reconstructs old/new content from details.diff.
func TestWireGoldenToolExecutionEndEditDiff(t *testing.T) {
	raw := loadWireFixture(t, "tool_execution_end.edit_diff.json")
	w := newTestGmpWorkspace()

	tr := toolResultPart(t, w.handleToolExecutionEnd(raw))
	if tr.Name != "edit" {
		t.Errorf("ToolResult.Name = %q, want remapped %q", tr.Name, "edit")
	}
	var meta struct {
		Additions  int    `json:"additions"`
		Removals   int    `json:"removals"`
		OldContent string `json:"old_content"`
		NewContent string `json:"new_content"`
	}
	if err := json.Unmarshal([]byte(tr.Metadata), &meta); err != nil {
		t.Fatalf("edit metadata invalid: %v (%s)", err, tr.Metadata)
	}
	if meta.Additions != 1 || meta.Removals != 1 {
		t.Errorf("additions/removals = %d/%d, want 1/1", meta.Additions, meta.Removals)
	}
	wantOld := "first line\nold line\nthird line"
	wantNew := "first line\nnew line\nthird line"
	if meta.OldContent != wantOld {
		t.Errorf("old_content = %q, want %q", meta.OldContent, wantOld)
	}
	if meta.NewContent != wantNew {
		t.Errorf("new_content = %q, want %q", meta.NewContent, wantNew)
	}
}

// TestWireGoldenTurnEnd: the turn_end fixture decodes the assistant message and
// its bash tool result through the real handler.
func TestWireGoldenTurnEnd(t *testing.T) {
	raw := loadWireFixture(t, "turn_end.json")
	w := newTestGmpWorkspace()

	msg := w.handleTurnEnd(raw)
	ev, ok := msg.(pubsub.Event[message.Message])
	if !ok {
		t.Fatalf("handleTurnEnd returned %T, want pubsub.Event[message.Message]", msg)
	}
	// First emitted message is the assistant turn message.
	if ev.Payload.Role != message.Assistant {
		t.Errorf("turn_end first message role = %q, want assistant", ev.Payload.Role)
	}
}

// TestWireGoldenOrderingSequence: the JSONL ordering fixture is the expected
// ordered prompt cycle. Decode each line's type discriminator (the dispatch
// key the ompclient read loop routes on) and assert the sequence.
func TestWireGoldenOrderingSequence(t *testing.T) {
	raw := loadWireFixture(t, "ordering.sequence.jsonl")
	var got []string
	for line := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			t.Fatalf("ordering line is not valid JSON: %v (%s)", err, line)
		}
		got = append(got, probe.Type)
	}
	want := []string{
		"agent_start",
		"turn_start",
		"message_start",
		"message_update",
		"tool_execution_start",
		"tool_execution_end",
		"turn_end",
		"agent_end",
	}
	if len(got) != len(want) {
		t.Fatalf("ordering has %d frames, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ordering[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}
