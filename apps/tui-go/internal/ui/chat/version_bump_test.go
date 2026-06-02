package chat

import (
	"testing"
	"time"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/anim"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/attachments"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/list"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/stretchr/testify/require"
)

// versionedItem is the cross-cutting interface every chat item type
// must satisfy under G6: every documented mutator must bump the shared
// version counter so the list-level memo invalidates frozen entries.
type versionedItem interface {
	list.Item
	Version() uint64
}

// requireBump asserts that the supplied mutator advances the item's
// Version(). An absent bump is a regression: a finished item would
// keep serving stale frozen output to the list cache.
func requireBump(t *testing.T, name string, item versionedItem, mutate func()) {
	t.Helper()
	before := item.Version()
	mutate()
	after := item.Version()
	require.Greaterf(t, after, before, "%s must bump Version() (before=%d, after=%d)", name, before, after)
}

// requireNoBump asserts the mutator leaves Version() unchanged. An
// unexpected bump forces the memo to re-render an item whose output
// did not change, churning the cache.
func requireNoBump(t *testing.T, name string, item versionedItem, mutate func()) {
	t.Helper()
	before := item.Version()
	mutate()
	after := item.Version()
	require.Equalf(t, before, after, "%s must not bump Version() (before=%d, after=%d)", name, before, after)
}

func newAttachmentRenderer(sty *styles.Styles) *attachments.Renderer {
	return attachments.NewRenderer(
		sty.Attachments.Normal,
		sty.Attachments.Deleting,
		sty.Attachments.Image,
		sty.Attachments.Text,
	)
}

// TestAssistantMessageItem_MutatorsBumpVersion enumerates every
// documented mutator on AssistantMessageItem and asserts each one
// advances Version().
func TestAssistantMessageItem_MutatorsBumpVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	build := func(thinking, content string) *message.Message {
		parts := []message.ContentPart{
			message.ReasoningContent{Thinking: thinking},
		}
		if content != "" {
			parts = append(parts, message.TextContent{Text: content})
		}
		return &message.Message{ID: "a-mut", Role: message.Assistant, Parts: parts}
	}

	item := NewAssistantMessageItem(&sty, build("thinking", "content")).(*AssistantMessageItem)

	requireBump(t, "SetMessage", item, func() {
		item.SetMessage(build("thinking", "more content"))
	})
	requireBump(t, "SetFocused", item, func() {
		item.SetFocused(true)
	})
	requireBump(t, "SetHighlight", item, func() {
		item.SetHighlight(0, 0, 0, 5)
	})
	requireBump(t, "ToggleExpanded", item, func() {
		item.ToggleExpanded()
	})
}

// TestAssistantMessageItem_IdempotentSettersDoNotBump locks in the
// change-guarded bumps: re-applying the same focus / highlight must be
// a no-op so a finished item keeps its frozen cache entry across the
// per-frame render callbacks.
func TestAssistantMessageItem_IdempotentSettersDoNotBump(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	msg := &message.Message{
		ID:   "a-idem",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.TextContent{Text: "done"},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	}
	item := NewAssistantMessageItem(&sty, msg).(*AssistantMessageItem)

	// Establish a baseline focus/highlight, then re-apply the same.
	item.SetFocused(false)
	item.SetHighlight(-1, -1, -1, -1)

	requireNoBump(t, "SetFocused[unchanged]", item, func() {
		item.SetFocused(false)
	})
	requireNoBump(t, "SetHighlight[unchanged]", item, func() {
		item.SetHighlight(-1, -1, -1, -1)
	})
}

// TestUserMessageItem_MutatorsBumpVersion enumerates UserMessageItem
// mutators and locks in the always-Finished contract.
func TestUserMessageItem_MutatorsBumpVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	msg := &message.Message{
		ID:    "u-mut",
		Role:  message.User,
		Parts: []message.ContentPart{message.TextContent{Text: "Hello"}},
	}
	item := NewUserMessageItem(&sty, msg, newAttachmentRenderer(&sty)).(*UserMessageItem)

	require.True(t, item.Finished(), "user messages are never spinning")

	requireBump(t, "SetFocused", item, func() {
		item.SetFocused(true)
	})
	requireBump(t, "SetHighlight", item, func() {
		item.SetHighlight(0, 0, 0, 3)
	})
}

// TestAssistantInfoItem_VersionedAndFinished sanity-checks the
// AssistantInfoItem wiring: Version() starts at zero and Finished()
// returns true.
func TestAssistantInfoItem_VersionedAndFinished(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	msg := &message.Message{
		ID:    "info",
		Role:  message.Assistant,
		Parts: []message.ContentPart{message.Finish{Reason: message.FinishReasonEndTurn}},
	}
	item := NewAssistantInfoItem(&sty, msg, nil, time.Time{}).(*AssistantInfoItem)

	require.True(t, item.Finished(), "AssistantInfoItem must be Finished()")
	require.Equal(t, uint64(0), item.Version())
}

// TestBaseToolMessageItem_MutatorsBumpVersion enumerates the base tool
// item mutators. Specific tool types layer on top of this base.
func TestBaseToolMessageItem_MutatorsBumpVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	tc := message.ToolCall{ID: "tc1", Name: "bash", Input: "{}", Finished: false}
	item := NewToolMessageItem(&sty, "msg", tc, nil, false)
	v := item.(versionedItem)

	requireBump(t, "SetFocused", v, func() {
		if f, ok := item.(list.Focusable); ok {
			f.SetFocused(true)
		}
	})
	requireBump(t, "SetHighlight", v, func() {
		if h, ok := item.(list.Highlightable); ok {
			h.SetHighlight(0, 0, 0, 3)
		}
	})
	requireBump(t, "SetToolCall", v, func() {
		tc2 := tc
		tc2.Input = `{"command":"echo"}`
		item.SetToolCall(tc2)
	})
	requireBump(t, "SetResult", v, func() {
		item.SetResult(&message.ToolResult{ToolCallID: "tc1", Content: "ok"})
	})
	requireBump(t, "SetStatus", v, func() {
		item.SetStatus(ToolStatusError)
	})
	requireBump(t, "ToggleExpanded", v, func() {
		if e, ok := item.(Expandable); ok {
			e.ToggleExpanded()
		}
	})
	requireBump(t, "SetCompact", v, func() {
		if c, ok := item.(Compactable); ok {
			c.SetCompact(true)
		}
	})
}

// TestAssistantMessageItem_AnimateBumpsVersion covers the spinner
// regression: while spinning, every anim.StepMsg fed through Animate
// must bump Version() so the next draw re-renders the advanced frame.
// A finished item must not bump.
func TestAssistantMessageItem_AnimateBumpsVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	streaming := &message.Message{
		ID:    "spin",
		Role:  message.Assistant,
		Parts: []message.ContentPart{message.ReasoningContent{Thinking: "thinking..."}},
	}
	item := NewAssistantMessageItem(&sty, streaming).(*AssistantMessageItem)
	require.False(t, item.Finished(), "streaming assistant message must not be Finished()")

	requireBump(t, "Animate[spinning]", item, func() {
		item.Animate(anim.StepMsg{ID: streaming.ID})
	})

	finished := &message.Message{
		ID:   "spin",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.TextContent{Text: "done"},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	}
	item.SetMessage(finished)
	require.True(t, item.Finished(), "item must report Finished() once the message finishes")

	requireNoBump(t, "Animate[finished]", item, func() {
		item.Animate(anim.StepMsg{ID: finished.ID})
	})
}

// TestBaseToolMessageItem_AnimateBumpsVersion is the spinner
// regression test for non-agent tools: spinning + matching ID bumps;
// foreign IDs and finished tools never bump.
func TestBaseToolMessageItem_AnimateBumpsVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	tc := message.ToolCall{ID: "tc-spin", Name: "bash", Input: "{}", Finished: false}
	item := NewToolMessageItem(&sty, "msg", tc, nil, false)
	v := item.(versionedItem)
	a, ok := item.(Animatable)
	require.True(t, ok, "base tool message item must implement Animatable")

	requireBump(t, "Animate[spinning,own ID]", v, func() {
		a.Animate(anim.StepMsg{ID: tc.ID})
	})
	requireNoBump(t, "Animate[spinning,foreign ID]", v, func() {
		a.Animate(anim.StepMsg{ID: "some-other-tool"})
	})

	tcFinished := tc
	tcFinished.Finished = true
	item.SetToolCall(tcFinished)
	item.SetResult(&message.ToolResult{ToolCallID: tc.ID, Content: "ok"})
	require.True(t, item.Finished(), "tool must report Finished() once the result lands")

	requireNoBump(t, "Animate[finished,own ID]", v, func() {
		a.Animate(anim.StepMsg{ID: tc.ID})
	})
}

// TestBaseToolMessageItem_FinishedTransition covers the freeze rule for
// tools: a still-running tool reports false; a finished tool with a
// result, and a canceled tool, both report true.
func TestBaseToolMessageItem_FinishedTransition(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	tc := message.ToolCall{ID: "tc-fin", Name: "bash", Input: "{}", Finished: false}
	item := NewToolMessageItem(&sty, "msg", tc, nil, false)
	require.False(t, item.Finished(), "running tool must not be Finished()")

	tcFinished := tc
	tcFinished.Finished = true
	item.SetToolCall(tcFinished)
	item.SetResult(&message.ToolResult{ToolCallID: "tc-fin", Content: "ok"})
	require.True(t, item.Finished(), "finished tool with result must be Finished()")

	tcCanceled := message.ToolCall{ID: "tc-cancel", Name: "bash", Input: "{}", Finished: false}
	canceled := NewToolMessageItem(&sty, "msg", tcCanceled, nil, true)
	require.True(t, canceled.Finished(), "canceled tool must be Finished()")
}

// TestAgentToolMessageItem_NestedAndAnimateBumpVersion covers the
// agent parent's nested-mutator and Animate bumps: the list only
// checks the parent's version, so nested changes / nested spinner
// ticks must bump the parent.
func TestAgentToolMessageItem_NestedAndAnimateBumpVersion(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	parentTC := message.ToolCall{ID: "agent-parent", Name: "agent", Input: `{}`, Finished: false}
	parent := NewAgentToolMessageItem(&sty, parentTC, nil, false)

	childTC := message.ToolCall{ID: "agent-child", Name: "bash", Input: `{}`, Finished: false}
	child := NewToolMessageItem(&sty, "msg", childTC, nil, false)

	requireBump(t, "AddNestedTool", parent, func() {
		parent.AddNestedTool(child)
	})

	// SetNestedTools always bumps, even with a pointer-equal slice
	// (in-place child mutation invalidates the parent's render).
	same := parent.NestedTools()
	requireBump(t, "SetNestedTools[pointer-equal]", parent, func() {
		parent.SetNestedTools(same)
	})

	// Spinning + parent's own ID bumps.
	requireBump(t, "Animate[parent ID]", parent, func() {
		parent.Animate(anim.StepMsg{ID: parentTC.ID})
	})
	// Spinning + nested child ID bumps the parent.
	requireBump(t, "Animate[nested ID]", parent, func() {
		parent.Animate(anim.StepMsg{ID: childTC.ID})
	})
	// Unrelated ID does not bump.
	requireNoBump(t, "Animate[foreign ID]", parent, func() {
		parent.Animate(anim.StepMsg{ID: "unrelated"})
	})

	// Once the parent has a result, neither branch bumps.
	parent.SetResult(&message.ToolResult{ToolCallID: parentTC.ID, Content: "done"})
	requireNoBump(t, "Animate[finished,parent ID]", parent, func() {
		parent.Animate(anim.StepMsg{ID: parentTC.ID})
	})
	requireNoBump(t, "Animate[finished,nested ID]", parent, func() {
		parent.Animate(anim.StepMsg{ID: childTC.ID})
	})
}
