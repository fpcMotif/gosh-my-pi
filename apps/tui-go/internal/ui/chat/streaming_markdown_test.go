package chat

import (
	"strings"
	"testing"

	"charm.land/glamour/v2"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

// newTestRenderer builds a fresh glamour renderer for the given
// width. We deliberately do NOT share renderers between calls in
// the equivalence tests so any hidden state in
// [glamour.TermRenderer] cannot leak from a "cached" rendering
// path into a "fresh" rendering path.
func newTestRenderer(t *testing.T, width int) *glamour.TermRenderer {
	t.Helper()
	sty := styles.CharmtonePantera()
	r, err := glamour.NewTermRenderer(
		glamour.WithStyles(sty.Markdown),
		glamour.WithWordWrap(width),
	)
	if err != nil {
		t.Fatalf("glamour.NewTermRenderer: %v", err)
	}
	return r
}

// freshRender renders content as a single document with a fresh
// glamour renderer and applies the same trailing-newline trim that
// streamingMarkdown.Render does. Use this for visible-equivalence
// comparisons against the streaming path.
func freshRender(t *testing.T, content string, width int) string {
	t.Helper()
	r := newTestRenderer(t, width)
	out, err := r.Render(content)
	if err != nil {
		t.Fatalf("renderer.Render: %v", err)
	}
	return strings.TrimSuffix(out, "\n")
}

// stripANSI removes all ANSI CSI escape sequences from s so two
// renders with different colour state can be compared on their
// visible glyphs alone.
func stripANSI(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) {
				c := s[j]
				if c >= 0x40 && c <= 0x7e {
					j++
					break
				}
				j++
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// normalizeRender canonicalises a rendered glamour string for
// visual-equivalence comparison: strip ANSI, drop per-line trailing
// whitespace, drop leading/trailing blank lines, and collapse
// consecutive blank lines to a single blank line.
//
// Glamour pads rendered lines with trailing spaces and adds top/
// bottom block margins that differ subtly between "render the whole
// document at once" and "render two halves and concatenate them."
// Those byte-level differences are acceptable as long as the
// visible content matches; this helper makes that comparison
// explicit.
func normalizeRender(s string) string {
	clean := stripANSI(s)
	lines := strings.Split(clean, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	out := make([]string, 0, len(lines))
	prevBlank := false
	for _, l := range lines {
		blank := l == ""
		if blank && prevBlank {
			continue
		}
		out = append(out, l)
		prevBlank = blank
	}
	for len(out) > 0 && out[0] == "" {
		out = out[1:]
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

// nonBlankLines returns the non-blank visible lines of s with
// per-line trailing whitespace trimmed. Used to compare two
// rendered fragments for content equivalence when paragraph-margin
// behaviour legitimately differs between a single fresh render and
// a streaming split render.
func nonBlankLines(s string) []string {
	clean := stripANSI(s)
	out := make([]string, 0)
	for l := range strings.SplitSeq(clean, "\n") {
		l = strings.TrimRight(l, " \t")
		if strings.TrimSpace(l) == "" {
			continue
		}
		out = append(out, l)
	}
	return out
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// progressivePrefixes splits doc into n monotonically growing byte
// prefixes, ending with the full document. n>=1.
func progressivePrefixes(doc string, n int) []string {
	if n < 1 {
		n = 1
	}
	out := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		size := len(doc) * i / n
		if i == n {
			size = len(doc)
		}
		out = append(out, doc[:size])
	}
	return out
}

func multiParagraphDoc() string {
	// ~60-line multi-paragraph markdown body: headings, paragraphs,
	// a closed fenced code block, a list, and a table. Exercises
	// several boundary-detection paths.
	parts := []string{"# Streaming markdown stress document", ""}
	for p := 1; p <= 8; p++ {
		parts = append(parts,
			"## Section "+string(rune('0'+p)),
			"",
			"This is paragraph one of the section. It carries enough words to wrap.",
			"",
			"This is paragraph two of the section with **bold** and `code` spans.",
			"",
		)
	}
	parts = append(parts,
		"Here is some explanatory prose before the code block.",
		"",
		"```go",
		"func hello() {",
		"    fmt.Println(\"hi\")",
		"}",
		"```",
		"",
		"- list item one",
		"- list item two",
		"- list item three",
		"",
		"| col a | col b |",
		"| ----- | ----- |",
		"| 1     | 2     |",
		"| 3     | 4     |",
		"",
		"And a closing paragraph after everything.",
	)
	return strings.Join(parts, "\n")
}

// TestStreamingMarkdown_FinalEqualsFullRender is the core
// correctness contract: streaming a multi-paragraph body in N
// chunks through the stable-prefix cache must yield a final output
// visually equivalent to a single full glamour render of the
// complete content. The cache is an optimization, not a behaviour
// change.
func TestStreamingMarkdown_FinalEqualsFullRender(t *testing.T) {
	t.Parallel()

	const width = 80
	doc := multiParagraphDoc()

	for _, steps := range []int{1, 5, 17, 40} {
		renderer := newTestRenderer(t, width)
		var sm streamingMarkdown

		var lastOut string
		for _, p := range progressivePrefixes(doc, steps) {
			lastOut = sm.Render(p, width, renderer)
		}

		fresh := freshRender(t, doc, width)
		if normalizeRender(fresh) != normalizeRender(lastOut) {
			t.Fatalf("steps=%d: final streaming output != full render\n--- fresh ---\n%s\n--- streamed ---\n%s",
				steps, normalizeRender(fresh), normalizeRender(lastOut))
		}
	}
}

// TestStreamingMarkdown_BoundaryNotInsideOpenFence asserts boundary
// detection refuses to cut the stable prefix inside an unclosed
// fenced code block. We feed content with an open ``` fence in the
// tail; the cached stable prefix must stop before the fence opener.
func TestStreamingMarkdown_BoundaryNotInsideOpenFence(t *testing.T) {
	t.Parallel()

	const width = 80
	doc := strings.Join([]string{
		"Intro paragraph one.",
		"",
		"Intro paragraph two.",
		"",
		"```go",
		"func incomplete() {",
		"\tx := 1",
		"",
		"\ty := 2",
	}, "\n")

	fenceOffset := strings.Index(doc, "```go")
	if fenceOffset <= 0 {
		t.Fatal("test setup: fence opener not found")
	}

	renderer := newTestRenderer(t, width)
	var sm streamingMarkdown

	for i, p := range progressivePrefixes(doc, 20) {
		if p == "" {
			continue
		}
		out := sm.Render(p, width, renderer)
		if out == "" {
			t.Fatalf("step %d: empty render", i)
		}
		// The stable prefix must never advance into the open fence.
		if len(sm.stablePrefix) > fenceOffset {
			t.Fatalf("step %d: stable prefix advanced into open fence: len=%d, fence at %d\nprefix=%q",
				i, len(sm.stablePrefix), fenceOffset, sm.stablePrefix)
		}
		// The stable prefix must never itself contain an unclosed
		// fence (odd number of fence lines).
		if strings.Count(sm.stablePrefix, "```")%2 != 0 {
			t.Fatalf("step %d: stable prefix contains an unclosed fence:\n%q", i, sm.stablePrefix)
		}
	}
}

// TestStreamingMarkdown_NoSafeBoundaryByteEqualsFullRender covers
// the "one giant table built character by character" case. With no
// blank lines anywhere there is never a safe boundary, so every
// flush must fall back to a full render and byte-equal a fresh full
// render of the same prefix (no concatenation happens).
func TestStreamingMarkdown_NoSafeBoundaryByteEqualsFullRender(t *testing.T) {
	t.Parallel()

	const width = 80
	doc := strings.Join([]string{
		"| col a | col b | col c |",
		"| ----- | ----- | ----- |",
		"| 1     | 2     | 3     |",
		"| 4     | 5     | 6     |",
		"| 7     | 8     | 9     |",
		"| 10    | 11    | 12    |",
	}, "\n")

	if got := findSafeMarkdownBoundary(doc); got != -1 {
		t.Fatalf("sanity: expected no safe boundary, got %d", got)
	}

	r := newTestRenderer(t, width)
	var sm streamingMarkdown

	for i, p := range progressivePrefixes(doc, 8) {
		if p == "" {
			continue
		}
		out := sm.Render(p, width, r)
		fresh := freshRender(t, p, width)
		if out != fresh {
			t.Fatalf("step %d: streaming output must byte-equal a fresh render when no boundary exists\nlen=%d", i, len(p))
		}
	}
	if sm.stablePrefix != "" {
		t.Fatalf("stable prefix must remain empty when no safe boundary exists, got %q", sm.stablePrefix)
	}
}

// TestStreamingMarkdown_AppendKeepsPrefixRenderByteIdentical asserts
// the prefix-stability contract: once a stable prefix has been
// finalized (cache hit), appending more content must keep the
// previously-finalized stablePrefixRender byte-identical. The
// optimization only re-glamours the tail.
func TestStreamingMarkdown_AppendKeepsPrefixRenderByteIdentical(t *testing.T) {
	t.Parallel()

	const width = 80
	r := newTestRenderer(t, width)
	var sm streamingMarkdown

	// Two paragraphs followed by a blank line establish a safe
	// boundary after the first paragraph.
	base := "First paragraph that is finalized.\n\nSecond paragraph still streaming"
	_ = sm.Render(base, width, r)
	if sm.stablePrefix == "" {
		t.Fatal("expected a stable prefix after a two-paragraph render")
	}
	finalizedPrefix := sm.stablePrefix
	finalizedRender := sm.stablePrefixRender
	if finalizedRender == "" {
		t.Fatal("expected a non-empty stable prefix render")
	}

	// Append more characters to the tail (a pure prefix-extension).
	for _, tail := range []string{" with more.", " and even more words.", "\n\nThird paragraph begins."} {
		_ = sm.Render(base+tail, width, r)
		base += tail
		if !strings.HasPrefix(sm.stablePrefix, finalizedPrefix) {
			t.Fatalf("stable prefix shrank below the finalized prefix: %q", sm.stablePrefix)
		}
		// The render of the originally-finalized prefix region must
		// remain byte-identical (cache hit), i.e. the finalized
		// render is still a prefix of the current cached render.
		if !strings.HasPrefix(sm.stablePrefixRender, finalizedRender) {
			t.Fatalf("finalized prefix render was re-glamoured (not byte-identical)\nwant prefix: %q\ngot: %q",
				finalizedRender, sm.stablePrefixRender)
		}
	}
}

// TestStreamingMarkdown_NonPrefixChangeInvalidates verifies a
// non-prefix content change (user retried the turn) resets the
// cache and the result matches a fresh full render of the new
// content.
func TestStreamingMarkdown_NonPrefixChangeInvalidates(t *testing.T) {
	t.Parallel()

	const width = 80
	r := newTestRenderer(t, width)
	var sm streamingMarkdown

	doc := "Para one.\n\nPara two.\n\nPara three."
	for _, p := range progressivePrefixes(doc, 6) {
		_ = sm.Render(p, width, r)
	}
	if sm.stablePrefix == "" {
		t.Fatal("expected a populated stable prefix after streaming")
	}

	other := "Completely different opening paragraph.\n\nAnd a second one entirely."
	out := sm.Render(other, width, r)
	if !strings.HasPrefix(other, sm.stablePrefix) {
		t.Fatalf("stable prefix must be reset to a prefix of the new content, got %q", sm.stablePrefix)
	}

	fresh := freshRender(t, other, width)
	if normalizeRender(fresh) != normalizeRender(out) {
		t.Fatalf("render after non-prefix change must match a fresh render\n--- fresh ---\n%s\n--- got ---\n%s",
			normalizeRender(fresh), normalizeRender(out))
	}
}

// TestStreamingMarkdown_WidthChangeInvalidates asserts a width
// change resets the cached width and re-renders against the new
// width.
func TestStreamingMarkdown_WidthChangeInvalidates(t *testing.T) {
	t.Parallel()

	doc := "Para one.\n\nPara two.\n\nPara three."
	r80 := newTestRenderer(t, 80)
	r40 := newTestRenderer(t, 40)
	var sm streamingMarkdown

	out80 := sm.Render(doc, 80, r80)
	if sm.width != 80 {
		t.Fatalf("width must be cached after first render, got %d", sm.width)
	}

	out40 := sm.Render(doc, 40, r40)
	if sm.width != 40 {
		t.Fatalf("width change must update cached width, got %d", sm.width)
	}
	if out80 == out40 {
		t.Fatal("different widths must produce different rendered output")
	}
	if len(sm.stablePrefix) > len(doc) {
		t.Fatalf("stable prefix must remain a prefix of the current content, len=%d", len(sm.stablePrefix))
	}
}

// finishedAssistantMessage builds a finished assistant message
// carrying the given text body for integration tests.
func finishedAssistantMessage(id, text string) *message.Message {
	return &message.Message{
		ID:   id,
		Role: message.Assistant,
		Parts: []message.ContentPart{
			message.TextContent{Text: text},
			message.Finish{Reason: message.FinishReasonEndTurn},
		},
	}
}

// TestAssistantStreamingContent_ResetOnClearCache guards the
// integration contract that clearCache (invoked on a style/theme
// change via ClearItemCaches) resets the streaming-markdown cache.
// Without this a style change would leave the OLD style's ANSI
// sequences embedded in the stable-prefix render.
func TestAssistantStreamingContent_ResetOnClearCache(t *testing.T) {
	t.Parallel()

	sty := styles.CharmtonePantera()
	doc := "Para one.\n\nPara two.\n\nPara three."
	msg := finishedAssistantMessage("stream-clear", doc)
	item := NewAssistantMessageItem(&sty, msg).(*AssistantMessageItem)

	const width = 80
	_ = item.RawRender(width)
	doc2 := doc + "\n\nFour."
	item.SetMessage(finishedAssistantMessage("stream-clear", doc2))
	_ = item.RawRender(width)

	item.clearCache()

	if item.streamingContent.stablePrefix != "" {
		t.Fatalf("clearCache must reset stable prefix, got %q", item.streamingContent.stablePrefix)
	}
	if item.streamingContent.stablePrefixRender != "" {
		t.Fatalf("clearCache must reset stable prefix render, got %q", item.streamingContent.stablePrefixRender)
	}
	if item.streamingContent.width != 0 {
		t.Fatalf("clearCache must reset cached width, got %d", item.streamingContent.width)
	}
}

// TestAssistantRenderMarkdown_MatchesFullRender asserts the wired-in
// path (RawRender -> renderMarkdown -> streamingContent) produces a
// body visually equivalent to a single full glamour render of the
// final content. This is the integration-level form of the core
// correctness contract.
func TestAssistantRenderMarkdown_MatchesFullRender(t *testing.T) {
	t.Parallel()

	const width = 80
	sty := styles.CharmtonePantera()
	doc := multiParagraphDoc()

	item := NewAssistantMessageItem(&sty, finishedAssistantMessage("render-eq", "")).(*AssistantMessageItem)

	// Stream the body in progressive prefixes through the wired path.
	for _, p := range progressivePrefixes(doc, 12) {
		item.SetMessage(finishedAssistantMessage("render-eq", p))
		_ = item.RawRender(width)
	}

	got := item.renderMarkdown(doc, width)
	fresh := freshRender(t, doc, width)
	if !equalStringSlices(nonBlankLines(fresh), nonBlankLines(got)) {
		t.Fatalf("wired streaming render must contain the same non-blank lines as a full render\n--- fresh ---\n%s\n--- got ---\n%s",
			strings.Join(nonBlankLines(fresh), "\n"), strings.Join(nonBlankLines(got), "\n"))
	}
}
