package chat

import (
	"strings"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
	"github.com/stretchr/testify/require"
)

const sectionCacheWidth = 80

// cappedSectionWidth is the width the per-section caches are actually
// keyed by: RawRender caps the requested width before rendering, so a
// direct assistantSection.hit probe must use the capped value.
func cappedSectionWidth() int { return cappedMessageWidth(sectionCacheWidth) }

// newAssistantItem builds an unfinished assistant item carrying the given
// thinking and content text. An unfinished message keeps the section
// caches in the streaming regime the tests exercise.
func newAssistantItem(t *testing.T, thinking, content string) *AssistantMessageItem {
	t.Helper()
	sty := styles.CharmtonePantera()
	parts := []message.ContentPart{message.ReasoningContent{Thinking: thinking}}
	if content != "" {
		parts = append(parts, message.TextContent{Text: content})
	}
	msg := &message.Message{ID: "a-sec", Role: message.Assistant, Parts: parts}
	return NewAssistantMessageItem(&sty, msg).(*AssistantMessageItem)
}

// longThinking returns a thinking block with strictly more than
// maxExpandedThinkingTailLines RENDERED lines so the tail-window state is
// reachable. Lines are wrapped in a fenced code block so glamour
// preserves one rendered line per source line (a sequence of plain
// paragraph lines would be reflowed into far fewer lines and the
// tail-window guard would never fire). Each line is unique so the tail
// window is byte-identifiable.
func longThinking(extra int) string {
	total := maxExpandedThinkingTailLines + extra
	lines := make([]string, 0, total+2)
	lines = append(lines, "```")
	for i := range total {
		lines = append(lines, "reasoning step line number "+itoa(i))
	}
	lines = append(lines, "```")
	return strings.Join(lines, "\n")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestStreamingContentDoesNotBustThinkingCache locks in the G17 section
// split: appending to the content section must not invalidate the
// thinking section's cached render. We populate both caches with a first
// render, then mutate ONLY the content and render again, asserting the
// thinking section still reports a cache hit for its unchanged key and
// serves byte-identical output.
func TestStreamingContentDoesNotBustThinkingCache(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "I am thinking about the problem.", "first")

	// First render populates the per-section caches.
	_ = item.RawRender(sectionCacheWidth)
	require.True(t, item.thinkingSec.valid, "thinking section must be cached after first render")
	thinkKeyBefore := item.thinkingSec.srcHash
	thinkExtraBefore := item.thinkingSec.extra
	thinkOutBefore := item.thinkingSec.out

	// Mutate ONLY the content section (a streaming delta) and re-render.
	item.SetMessage(&message.Message{
		ID:   "a-sec",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.ReasoningContent{Thinking: "I am thinking about the problem."},
			message.TextContent{Text: "first second third"},
		},
	})

	// The thinking key must be a HIT for the unchanged thinking text.
	srcHash, extra := item.thinkingKey()
	require.True(t,
		item.thinkingSec.hit(cappedSectionWidth(), srcHash, extra),
		"thinking section must remain a cache hit after a content-only mutation",
	)

	_ = item.RawRender(sectionCacheWidth)

	require.Equal(t, thinkKeyBefore, item.thinkingSec.srcHash, "thinking srcHash must be unchanged by content streaming")
	require.Equal(t, thinkExtraBefore, item.thinkingSec.extra, "thinking extra must be unchanged by content streaming")
	require.Equal(t, thinkOutBefore, item.thinkingSec.out, "thinking section render must be byte-identical after content streaming")

	// And the content section must reflect the new text.
	require.Contains(t, item.contentSec.out, "second", "content section must re-render with the new delta")
}

// TestContentStreamingDoesNotBustErrorCacheNeighbors is the inverse
// direction: mutating thinking must not disturb the content section's
// cache key when the content text is unchanged.
func TestThinkingStreamingDoesNotBustContentCache(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "thinking one", "stable content body")
	_ = item.RawRender(sectionCacheWidth)
	require.True(t, item.contentSec.valid)
	contentOutBefore := item.contentSec.out

	item.SetMessage(&message.Message{
		ID:   "a-sec",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.ReasoningContent{Thinking: "thinking one two three"},
			message.TextContent{Text: "stable content body"},
		},
	})

	csrc, cextra := item.contentKey()
	require.True(t, item.contentSec.hit(cappedSectionWidth(), csrc, cextra),
		"content section must remain a cache hit when only thinking changed")

	_ = item.RawRender(sectionCacheWidth)
	require.Equal(t, contentOutBefore, item.contentSec.out,
		"content section render must be byte-identical when only thinking changed")
}

// TestThinkingThreeStateTailWindowThenFull locks the G17 three-state
// machine: a thinking block longer than maxExpandedThinkingTailLines
// renders collapsed first, enters the TAIL WINDOW on the first expand
// (showing the tail-window affordance and the LAST line but not the
// FIRST), and the FULL block on the second expand.
func TestThinkingThreeStateTailWindowThenFull(t *testing.T) {
	t.Parallel()

	think := longThinking(50) // 250 code lines > 200 cap
	item := newAssistantItem(t, think, "")
	firstLine := "reasoning step line number " + itoa(0)
	lastLine := "reasoning step line number " + itoa(maxExpandedThinkingTailLines+50-1)

	// Collapsed: shows the collapse affordance, not the full block.
	collapsed := item.RawRender(sectionCacheWidth)
	require.Contains(t, collapsed, "lines hidden) [click or space to expand]",
		"collapsed thinking must show the collapse hint")

	// First expand -> tail window.
	require.True(t, item.ToggleExpanded(), "first expand must report an expanded state")
	require.Equal(t, thinkingTailWindow, item.thinkingViewMode,
		"a >cap block must enter the tail-window on first expand")
	tail := item.RawRender(sectionCacheWidth)
	require.Contains(t, tail, "earlier lines hidden [click or space for full view]",
		"tail-window must advertise the earlier-lines affordance")
	require.Contains(t, tail, lastLine, "tail-window must include the LAST reasoning line")
	require.NotContains(t, tail, firstLine,
		"tail-window must NOT include the FIRST reasoning line (it is windowed out)")

	// Second expand -> full.
	require.True(t, item.ToggleExpanded(), "second expand must still report expanded")
	require.Equal(t, thinkingFullExpanded, item.thinkingViewMode,
		"second expand must promote to full view")
	full := item.RawRender(sectionCacheWidth)
	require.Contains(t, full, firstLine, "full view must include the FIRST reasoning line")
	require.Contains(t, full, lastLine, "full view must include the LAST reasoning line")
	require.NotContains(t, full, "earlier lines hidden",
		"full view must not show the tail-window affordance")

	// Third expand -> collapsed (cycle closes).
	require.False(t, item.ToggleExpanded(), "third expand must collapse the cycle")
	require.Equal(t, thinkingCollapsed, item.thinkingViewMode)
}

// TestThinkingShortBlockSkipsTailWindow verifies that a thinking block
// within the cap skips the tail-window step so short blocks remain a
// two-click toggle: collapsed -> full -> collapsed.
func TestThinkingShortBlockSkipsTailWindow(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "short reasoning\nonly two lines", "")
	require.True(t, item.ToggleExpanded())
	require.Equal(t, thinkingFullExpanded, item.thinkingViewMode,
		"a within-cap block must skip the tail-window step")
	require.False(t, item.ToggleExpanded())
	require.Equal(t, thinkingCollapsed, item.thinkingViewMode)
}

// TestPrefixCacheReuseOnUnchangedFocus locks in the G17 prefix cache:
// rendering twice without changing focus must reuse the cached prefixed
// output (same key, byte-identical), and a focus flip must produce a
// different key while round-tripping back to byte-identical output.
func TestPrefixCacheReuseOnUnchangedFocus(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "thinking text", "finished body")
	// Make the item terminal so the prefix cache is used (it is bypassed
	// while spinning).
	item.SetMessage(&message.Message{
		ID:   "a-sec",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.ReasoningContent{Thinking: "thinking text"},
			message.TextContent{Text: "finished body"},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	})

	const w = sectionCacheWidth
	blurred1 := item.Render(w)
	keyBlur := item.prefixedKey
	require.NotEmpty(t, item.prefixedRendered, "prefix cache must be populated after first Render")

	// Second identical Render must be a cache hit: same key, same bytes.
	blurred2 := item.Render(w)
	require.Equal(t, keyBlur, item.prefixedKey, "unchanged focus must reuse the same prefix-cache key")
	require.Equal(t, blurred1, blurred2, "unchanged Render must return byte-identical cached output")
	cached, ok := item.getCachedPrefixedRender(w, keyBlur)
	require.True(t, ok, "the blurred prefix render must be served from cache")
	require.Equal(t, blurred1, cached)

	// Flip focus -> different key, different prefix bytes.
	item.SetFocused(true)
	focused := item.Render(w)
	require.NotEqual(t, keyBlur, item.prefixedKey, "focus flip must change the prefix-cache key")
	require.NotEqual(t, blurred1, focused, "focused render must differ from blurred render")

	// Flip back -> byte-identical to the original blurred render.
	item.SetFocused(false)
	blurred3 := item.Render(w)
	require.Equal(t, keyBlur, item.prefixedKey, "returning to blurred must restore the original key")
	require.Equal(t, blurred1, blurred3, "round-tripping focus must restore byte-identical blurred output")
}

// TestPrefixCacheBustsOnContentDelta confirms the prefix cache misses
// when a section's source text changes, so streaming visibly updates the
// rendered output even though the focus bit is unchanged.
func TestPrefixCacheBustsOnContentDelta(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "thinking text", "body v1")
	item.SetMessage(&message.Message{
		ID:   "a-sec",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.ReasoningContent{Thinking: "thinking text"},
			message.TextContent{Text: "body v1"},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	})
	first := item.Render(sectionCacheWidth)
	keyFirst := item.prefixedKey

	item.SetMessage(&message.Message{
		ID:   "a-sec",
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.ReasoningContent{Thinking: "thinking text"},
			message.TextContent{Text: "body v2 longer"},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	})
	second := item.Render(sectionCacheWidth)
	require.NotEqual(t, keyFirst, item.prefixedKey,
		"a content delta must change the prefix-cache fingerprint")
	require.NotEqual(t, first, second, "a content delta must produce different rendered bytes")
}

// TestClearCacheResetsSectionCaches confirms the theme-change path drops
// the per-section caches and the prefix cache (G6 ClearItemCaches wiring).
func TestClearCacheResetsSectionCaches(t *testing.T) {
	t.Parallel()

	item := newAssistantItem(t, "thinking", "content")
	_ = item.Render(sectionCacheWidth)
	require.True(t, item.thinkingSec.valid)
	require.True(t, item.contentSec.valid)
	require.NotEmpty(t, item.prefixedRendered)

	item.clearCache()

	require.False(t, item.thinkingSec.valid, "thinking section cache must reset on clearCache")
	require.False(t, item.contentSec.valid, "content section cache must reset on clearCache")
	require.False(t, item.errorSec.valid, "error section cache must reset on clearCache")
	require.Empty(t, item.prefixedRendered, "prefix cache must reset on clearCache")
}
