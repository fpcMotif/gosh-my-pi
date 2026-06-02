package chat

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/anim"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/common"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/list"
	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/ui/styles"
)

// assistantMessageTruncateFormat is the text shown when an assistant message is
// truncated in the collapsed state.
const assistantMessageTruncateFormat = "… (%d lines hidden) [click or space to expand]"

// assistantMessageTailWindowFormat is shown above a tail-windowed thinking
// block to advertise that earlier lines exist and that the user can
// promote the view to a full expansion. The promotion reuses the
// existing ToggleExpanded path (click / space); G17 deliberately does
// not add a new keybinding.
const assistantMessageTailWindowFormat = "… %d earlier lines hidden [click or space for full view]"

// maxCollapsedThinkingHeight defines the maximum height of the thinking
const maxCollapsedThinkingHeight = 10

// maxExpandedThinkingTailLines is the G17 tail-window cap. When the user
// expands a thinking block whose post-glamour line count exceeds this
// threshold, only the last N lines are shown with an affordance line
// indicating how many earlier lines are hidden. Clicking / pressing
// space again promotes the view to a full expansion. The slice is taken
// AFTER glamour render (not before) so fenced code blocks, lists, and
// tables are not torn at arbitrary boundaries.
const maxExpandedThinkingTailLines = 200

// thinkingViewMode is the G17 three-state view machine for the thinking
// block. ToggleExpanded cycles
// collapsed → tail-window → full-expanded → collapsed, skipping the
// tail-window step when the rendered thinking fits within the cap so
// short blocks still toggle in two clicks.
type thinkingViewMode uint8

const (
	thinkingCollapsed thinkingViewMode = iota
	thinkingTailWindow
	thinkingFullExpanded
)

// assistantSection is a per-section render cache for AssistantMessageItem.
// Each section (thinking, content, error) carries its own keys so that
// streaming one section does not invalidate a different — often more
// expensive — section's cached render. srcHash is an FNV-64 of the
// section's source text; extra captures any other state that changes the
// rendered output (e.g. the thinking view mode, the thinking footer
// inputs). valid disambiguates a real cache hit from the zero value when
// both source text and extras hash to zero. aux carries per-section side
// data the caller needs to recover on a hit (e.g. the thinking box
// height for click detection).
type assistantSection struct {
	width   int
	srcHash uint64
	extra   uint64
	out     string
	h       int
	aux     int
	valid   bool
}

// hit reports whether the cache entry matches the requested key.
func (s *assistantSection) hit(width int, srcHash, extra uint64) bool {
	return s.valid && s.width == width && s.srcHash == srcHash && s.extra == extra
}

// store records the rendered output under the given key.
func (s *assistantSection) store(width int, srcHash, extra uint64, out string, aux int) {
	s.width = width
	s.srcHash = srcHash
	s.extra = extra
	s.out = out
	s.h = lipgloss.Height(out)
	s.aux = aux
	s.valid = true
}

// reset drops the cached output.
func (s *assistantSection) reset() {
	*s = assistantSection{}
}

// fnv64 hashes a single string with FNV-64.
func fnv64(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// fnvFields hashes a list of byte fields with length-prefix framing so
// that no concatenation collision can occur between distinct field
// tuples (a NUL inside one field cannot impersonate a boundary between
// two fields). Each field is preceded by its length encoded as 8 bytes
// little-endian.
func fnvFields(fields ...[]byte) uint64 {
	h := fnv.New64a()
	var lenBuf [8]byte
	for _, f := range fields {
		binary.LittleEndian.PutUint64(lenBuf[:], uint64(len(f)))
		_, _ = h.Write(lenBuf[:])
		_, _ = h.Write(f)
	}
	return h.Sum64()
}

// AssistantMessageItem represents an assistant message in the chat UI.
//
// This item includes thinking, and the content but does not include the tool calls.
type AssistantMessageItem struct {
	*list.Versioned
	*highlightableMessageItem
	*cachedMessageItem
	*focusableMessageItem

	message           *message.Message
	sty               *styles.Styles
	anim              *anim.Anim
	thinkingViewMode  thinkingViewMode
	thinkingBoxHeight int // Tracks the rendered thinking box height for click detection.

	// Per-section render caches. Splitting these out means content
	// streaming does not invalidate the (often expensive) thinking
	// render, and vice versa (gap G17).
	thinkingSec assistantSection
	contentSec  assistantSection
	errorSec    assistantSection

	// streamingContent caches a stable-prefix glamour render so each
	// streaming flush only re-renders the growing tail rather than the
	// whole accumulated body (gap G5). It invalidates itself on width
	// change and on non-prefix content edits; clearCache resets it on
	// style/theme change.
	streamingContent streamingMarkdown
}

var _ Expandable = (*AssistantMessageItem)(nil)

// NewAssistantMessageItem creates a new AssistantMessageItem.
func NewAssistantMessageItem(sty *styles.Styles, message *message.Message) MessageItem {
	v := list.NewVersioned()
	a := &AssistantMessageItem{
		Versioned:                v,
		highlightableMessageItem: defaultHighlighter(sty, v),
		cachedMessageItem:        &cachedMessageItem{},
		focusableMessageItem:     newFocusableMessageItem(v),
		message:                  message,
		sty:                      sty,
	}

	a.anim = anim.New(anim.Settings{
		ID:          a.ID(),
		Size:        15,
		GradColorA:  sty.WorkingGradFromColor,
		GradColorB:  sty.WorkingGradToColor,
		LabelColor:  sty.WorkingLabelColor,
		CycleColors: true,
	})
	return a
}

// StartAnimation starts the assistant message animation if it should be spinning.
func (a *AssistantMessageItem) StartAnimation() tea.Cmd {
	if !a.isSpinning() {
		return nil
	}
	return a.anim.Start()
}

// Animate progresses the assistant message animation if it should be spinning.
func (a *AssistantMessageItem) Animate(msg anim.StepMsg) tea.Cmd {
	if !a.isSpinning() {
		return nil
	}
	// Bump the G6 list-cache version so the next draw re-renders
	// this item: a spinner tick mutates anim's internal frame
	// counter, which changes the rendered output but is invisible
	// to the per-section content hashes. Without the bump the list
	// cache would serve the previously rendered frame indefinitely
	// and the spinner would appear frozen.
	a.Bump()
	return a.anim.Animate(msg)
}

// ID implements MessageItem.
func (a *AssistantMessageItem) ID() string {
	return a.message.ID
}

// RawRender implements [MessageItem].
func (a *AssistantMessageItem) RawRender(width int) string {
	cappedWidth := cappedMessageWidth(width)

	var spinner string
	if a.isSpinning() {
		spinner = a.renderSpinning()
	}

	content, height := a.renderMessageContent(cappedWidth)
	highlightedContent := a.renderHighlighted(content, cappedWidth, height)
	if spinner != "" {
		if highlightedContent != "" {
			highlightedContent += "\n\n"
		}
		return highlightedContent + spinner
	}

	return highlightedContent
}

// Render implements MessageItem.
func (a *AssistantMessageItem) Render(width int) string {
	// XXX: Here, we're manually applying the focused/blurred styles because
	// using lipgloss.Render can degrade performance for long messages due to
	// it's wrapping logic.
	// We already know that the content is wrapped to the correct width in
	// RawRender, so we can just apply the styles directly to each line.
	//
	// The split + per-line prefix loop is O(L); cache the result keyed by
	// (width, focused, sectionsFingerprint) so steady-state Render becomes a
	// pointer return. The fingerprint folds in the per-section srcHash/extra
	// so any sub-cache change invalidates this prefix cache without requiring
	// an explicit drop. Bypass the cache while spinning (RawRender's spinner
	// suffix changes every animation frame) or while a highlight range is
	// active (selection drag).
	useCache := !a.isSpinning() && !a.isHighlighted()
	cappedWidth := cappedMessageWidth(width)
	key := a.prefixCacheKey(cappedWidth)
	if useCache {
		if cached, ok := a.getCachedPrefixedRender(width, key); ok {
			return cached
		}
	}
	focused := a.sty.Messages.AssistantFocused.Render()
	blurred := a.sty.Messages.AssistantBlurred.Render()
	rendered := a.RawRender(width)
	lines := strings.Split(rendered, "\n")
	for i, line := range lines {
		if a.focused {
			lines[i] = focused + line
		} else {
			lines[i] = blurred + line
		}
	}
	out := strings.Join(lines, "\n")
	if useCache {
		a.setCachedPrefixedRender(out, width, key)
	}
	return out
}

// prefixCacheKey builds the G17 prefixed-render cache key. We pack the
// focus bit into bit 0 and a fingerprint of the section caches into the
// upper bits, so any change to a sub-section's source text or extras
// forces the prefix cache to miss without needing an explicit drop.
// cappedWidth is included so a cached prefix never survives a
// section-cache miss caused by a width change. The finish reason is
// folded in too because it controls the composition of
// renderMessageContent (e.g. appending the constant "Canceled" string) —
// that decision lives outside any section's own hash.
func (a *AssistantMessageItem) prefixCacheKey(cappedWidth int) uint64 {
	thinkSrc, thinkExtra := a.thinkingKey()
	contentSrc, contentExtra := a.contentKey()
	errSrc, errExtra := a.errorKey()
	h := fnv.New64a()
	var buf [8]byte
	writeU64 := func(v uint64) {
		binary.LittleEndian.PutUint64(buf[:], v)
		_, _ = h.Write(buf[:])
	}
	writeU64(uint64(cappedWidth))
	writeU64(thinkSrc)
	writeU64(thinkExtra)
	writeU64(contentSrc)
	writeU64(contentExtra)
	writeU64(errSrc)
	writeU64(errExtra)
	writeU64(a.compositionKey())
	fingerprint := h.Sum64()
	var focusBit uint64
	if a.focused {
		focusBit = 1
	}
	return (fingerprint &^ 1) | focusBit
}

// compositionKey hashes the inputs to renderMessageContent's structural
// decisions (which sections to include, whether to append the constant
// "Canceled" footer) so that flipping IsFinished or the finish reason
// invalidates the prefix cache even when no section's own source text
// changed.
func (a *AssistantMessageItem) compositionKey() uint64 {
	var finishedFlag byte
	var reason string
	if a.message.IsFinished() {
		finishedFlag = 1
		reason = string(a.message.FinishReason())
	}
	// Length-prefixed framing keeps the finished flag and the reason
	// string from blending into one another.
	return fnvFields([]byte{finishedFlag}, []byte(reason))
}

// renderMessageContent renders the message content including thinking, main
// content, and finish reason. Each section is served from its own cache;
// only the section whose source text or extras changed since the last
// render is recomputed.
func (a *AssistantMessageItem) renderMessageContent(width int) (string, int) {
	var messageParts []string
	thinking := strings.TrimSpace(a.message.ReasoningContent().Thinking)
	content := strings.TrimSpace(a.message.Content().Text)
	// if the message has reasoning content add that first
	if thinking != "" {
		messageParts = append(messageParts, a.cachedThinking(width))
	}

	// then add the main content
	if content != "" {
		// add a spacer between thinking and content
		if thinking != "" {
			messageParts = append(messageParts, "")
		}
		messageParts = append(messageParts, a.cachedContent(width))
	}

	// finally add any finish reason info
	if a.message.IsFinished() {
		switch a.message.FinishReason() {
		case message.FinishReasonCanceled:
			messageParts = append(messageParts, a.sty.Messages.AssistantCanceled.Render("Canceled"))
		case message.FinishReasonError:
			messageParts = append(messageParts, a.cachedError(width))
		}
	}

	out := strings.Join(messageParts, "\n")
	return out, lipgloss.Height(out)
}

// thinkingKey returns the (srcHash, extra) cache key components for the
// thinking section. extra folds in everything other than the raw
// thinking text that affects the rendered output: the view mode
// (collapsed / tail-window / full) and the footer state (which depends
// on IsThinking, ToolCalls, and ThinkingDuration).
func (a *AssistantMessageItem) thinkingKey() (uint64, uint64) {
	thinking := a.message.ReasoningContent().Thinking
	srcHash := fnv64(thinking)

	showFooter := !a.message.IsThinking() || len(a.message.ToolCalls()) > 0
	var durationStr string
	if showFooter {
		duration := a.message.ThinkingDuration()
		if duration.String() != "0s" {
			durationStr = duration.String()
		}
	}
	var footer byte
	if showFooter {
		footer = 1
	}
	// Length-prefixed framing avoids any delimiter collision between the
	// flag bytes and the duration string. The view mode is folded in so
	// that toggling collapsed ↔ tail-window ↔ full invalidates only the
	// thinking section, not content/error.
	extra := fnvFields([]byte{byte(a.thinkingViewMode), footer}, []byte(durationStr))
	return srcHash, extra
}

// contentKey returns the (srcHash, extra) cache key components for the
// main content section.
func (a *AssistantMessageItem) contentKey() (uint64, uint64) {
	return fnv64(a.message.Content().Text), 0
}

// errorKey returns the (srcHash, extra) cache key components for the
// error section. Returns (0, 0) when no error is present so the cache
// stays a no-op for non-error messages.
func (a *AssistantMessageItem) errorKey() (uint64, uint64) {
	if !a.message.IsFinished() || a.message.FinishReason() != message.FinishReasonError {
		return 0, 0
	}
	finishPart := a.message.FinishPart()
	if finishPart == nil {
		return 0, 0
	}
	// Length-prefixed framing prevents Message+Details collisions between
	// distinct (Message, Details) tuples that would otherwise concatenate
	// to the same byte sequence.
	return fnvFields([]byte(finishPart.Message), []byte(finishPart.Details)), 0
}

// cachedThinking returns the rendered thinking section, computing and
// caching it on miss. The thinking-box height (used for click target
// detection) is preserved across hits via assistantSection.aux so the
// cached path never desyncs click detection.
func (a *AssistantMessageItem) cachedThinking(width int) string {
	srcHash, extra := a.thinkingKey()
	if a.thinkingSec.hit(width, srcHash, extra) {
		a.thinkingBoxHeight = a.thinkingSec.aux
		return a.thinkingSec.out
	}
	out := a.renderThinking(a.message.ReasoningContent().Thinking, width)
	a.thinkingSec.store(width, srcHash, extra, out, a.thinkingBoxHeight)
	return out
}

// cachedContent returns the rendered content section.
func (a *AssistantMessageItem) cachedContent(width int) string {
	srcHash, extra := a.contentKey()
	if a.contentSec.hit(width, srcHash, extra) {
		return a.contentSec.out
	}
	out := a.renderMarkdown(a.message.Content().Text, width)
	a.contentSec.store(width, srcHash, extra, out, 0)
	return out
}

// cachedError returns the rendered error section.
func (a *AssistantMessageItem) cachedError(width int) string {
	srcHash, extra := a.errorKey()
	if a.errorSec.hit(width, srcHash, extra) {
		return a.errorSec.out
	}
	out := a.renderError(width)
	a.errorSec.store(width, srcHash, extra, out, 0)
	return out
}

// renderThinking renders the thinking/reasoning content with footer.
//
// Slicing happens AFTER glamour rendering so fenced code blocks, list
// continuations, and tables are not split mid-block. The bordered
// ThinkingBox style is applied on top of the (already-windowed) lines so
// the visual box matches what the user sees today.
func (a *AssistantMessageItem) renderThinking(thinking string, width int) string {
	renderer := common.QuietMarkdownRenderer(a.sty, width)
	// QuietMarkdownRenderer returns a process-wide cached renderer that
	// is not safe for concurrent use; serialize via the per-renderer
	// mutex exactly as the streaming-content path does.
	mu := common.LockMarkdownRenderer(renderer)
	mu.Lock()
	rendered, err := renderer.Render(thinking)
	mu.Unlock()
	if err != nil {
		rendered = thinking
	}
	rendered = strings.TrimSpace(rendered)

	lines := strings.Split(rendered, "\n")
	totalLines := len(lines)

	switch a.thinkingViewMode {
	case thinkingCollapsed:
		if totalLines > maxCollapsedThinkingHeight {
			lines = lines[totalLines-maxCollapsedThinkingHeight:]
			hint := a.sty.Messages.ThinkingTruncationHint.Render(
				fmt.Sprintf(assistantMessageTruncateFormat, totalLines-maxCollapsedThinkingHeight),
			)
			lines = append([]string{hint, ""}, lines...)
		}
	case thinkingTailWindow:
		if totalLines > maxExpandedThinkingTailLines {
			lines = lines[totalLines-maxExpandedThinkingTailLines:]
			hint := a.sty.Messages.ThinkingTruncationHint.Render(
				fmt.Sprintf(assistantMessageTailWindowFormat, totalLines-maxExpandedThinkingTailLines),
			)
			lines = append([]string{hint, ""}, lines...)
		}
	case thinkingFullExpanded:
		// full view: no windowing.
	}

	thinkingStyle := a.sty.Messages.ThinkingBox.Width(width)
	result := thinkingStyle.Render(strings.Join(lines, "\n"))
	a.thinkingBoxHeight = lipgloss.Height(result)

	var footer string
	// if thinking is done add the thought for footer
	if !a.message.IsThinking() || len(a.message.ToolCalls()) > 0 {
		duration := a.message.ThinkingDuration()
		if duration.String() != "0s" {
			footer = a.sty.Messages.ThinkingFooterTitle.Render("Thought for ") +
				a.sty.Messages.ThinkingFooterDuration.Render(duration.String())
		}
	}

	if footer != "" {
		result += "\n\n" + footer
	}

	return result
}

// renderMarkdown renders content as markdown. G5 routes the call
// through streamingContent, which caches the glamour render of a
// "stable prefix" so each streaming flush only re-renders the
// trailing partial. The streaming cache invalidates itself on width
// change and on any content that is not a prefix-extension of the
// previously rendered content (e.g. user retried the turn), and falls
// back to a full render whenever boundary detection has the slightest
// doubt — see findSafeMarkdownBoundary.
func (a *AssistantMessageItem) renderMarkdown(content string, width int) string {
	renderer := common.MarkdownRenderer(a.sty, width)
	return a.streamingContent.Render(content, width, renderer)
}

// clearCache drops the per-width render cache, every per-section cache,
// and resets the streaming-markdown stable-prefix cache. Resetting the
// streaming cache here is required on a style/theme change: without it
// the OLD style's ANSI sequences would stay embedded in the cached
// stable-prefix render and the next flush would visually mix styles. The
// section caches likewise embed style-dependent ANSI. ClearItemCaches
// (invoked on theme change) calls this.
func (a *AssistantMessageItem) clearCache() {
	a.cachedMessageItem.clearCache()
	a.thinkingSec.reset()
	a.contentSec.reset()
	a.errorSec.reset()
	a.streamingContent.Reset()
}

func (a *AssistantMessageItem) renderSpinning() string {
	if a.message.IsThinking() {
		a.anim.SetLabel("Thinking")
	} else if a.message.IsSummaryMessage {
		a.anim.SetLabel("Summarizing")
	}
	return a.anim.Render()
}

// renderError renders an error message.
func (a *AssistantMessageItem) renderError(width int) string {
	finishPart := a.message.FinishPart()
	errTag := a.sty.Messages.ErrorTag.Render("ERROR")
	truncated := ansi.Truncate(finishPart.Message, width-2-lipgloss.Width(errTag), "...")
	title := fmt.Sprintf("%s %s", errTag, a.sty.Messages.ErrorTitle.Render(truncated))
	details := a.sty.Messages.ErrorDetails.Width(width - 2).Render(finishPart.Details)
	return fmt.Sprintf("%s\n\n%s", title, details)
}

// isSpinning returns true if the assistant message is still generating.
func (a *AssistantMessageItem) isSpinning() bool {
	isThinking := a.message.IsThinking()
	isFinished := a.message.IsFinished()
	hasContent := strings.TrimSpace(a.message.Content().Text) != ""
	hasToolCalls := len(a.message.ToolCalls()) > 0
	return (isThinking || !isFinished) && !hasContent && !hasToolCalls
}

// SetMessage is used to update the underlying message. The per-section
// caches dedupe identical content via FNV-64 hashes, so only the section
// whose source text or extras changed is recomputed on the next render;
// the others survive and serve cache hits.
func (a *AssistantMessageItem) SetMessage(message *message.Message) tea.Cmd {
	wasSpinning := a.isSpinning()
	a.message = message
	// Bump the G6 version even if the underlying *message.Message
	// pointer is identical: callers mutate the message in place
	// (delta append) and we cannot tell from here. The per-section
	// caches are content-keyed, so a redundant bump only costs one
	// list-cache repopulation; we do NOT clearCache here so streaming
	// a content delta keeps the thinking section's cached render.
	a.Bump()
	if !wasSpinning && a.isSpinning() {
		return a.StartAnimation()
	}
	return nil
}

// Finished implements list.Item. A streaming assistant message reports
// false; once the message reports IsFinished() and is no longer
// spinning, the rendered output is terminal and may be frozen.
func (a *AssistantMessageItem) Finished() bool {
	return a.message.IsFinished() && !a.isSpinning()
}

// ToggleExpanded advances the G17 thinking view-mode cycle and returns
// whether the item is now in any expanded state (tail-window or full).
// The cycle is collapsed → tail-window → full → collapsed, with the
// tail-window step skipped when the rendered thinking fits within
// maxExpandedThinkingTailLines so short blocks remain a two-click toggle.
// Both the thinking section cache and the G17 prefix cache fold
// thinkingViewMode into their keys, so no explicit cache drop is required
// here.
//
// When the message carries no thinking text the toggle is a no-op: there
// is nothing to expand, and mutating the view mode would thrash the
// thinking-section cache key for no visible benefit.
func (a *AssistantMessageItem) ToggleExpanded() bool {
	if strings.TrimSpace(a.message.ReasoningContent().Thinking) == "" {
		return a.thinkingViewMode != thinkingCollapsed
	}
	switch a.thinkingViewMode {
	case thinkingCollapsed:
		if a.tailWindowWouldTruncate() {
			a.thinkingViewMode = thinkingTailWindow
		} else {
			a.thinkingViewMode = thinkingFullExpanded
		}
	case thinkingTailWindow:
		a.thinkingViewMode = thinkingFullExpanded
	case thinkingFullExpanded:
		a.thinkingViewMode = thinkingCollapsed
	}
	a.Bump()
	return a.thinkingViewMode != thinkingCollapsed
}

// tailWindowWouldTruncate reports whether the current thinking text is
// long enough that the tail-window step is worth inserting into the
// toggle cycle. We use a cheap source-text logical-line count as the
// heuristic rather than peeking into the cache: the cache may be
// populated in collapsed state (where its height is bounded by
// maxCollapsedThinkingHeight and tells us nothing about the underlying
// length), and re-running glamour just to count lines would defeat the
// cache. The heuristic can over-trigger (a source with many short lines
// may wrap to fewer than N lines), in which case the tail-window render
// is visually identical to full and the cycle costs the user one extra
// toggle — preferred over failing to show the affordance on a genuinely
// long block.
//
// Logical line count is `1 + newlineCount` (a string with no newlines is
// one line). Comparing newline count alone introduces an off-by-one that
// lets a source whose post-newline-split length equals the cap skip the
// tail-window step.
func (a *AssistantMessageItem) tailWindowWouldTruncate() bool {
	lineCount := 1 + strings.Count(a.message.ReasoningContent().Thinking, "\n")
	return lineCount > maxExpandedThinkingTailLines
}

// HandleMouseClick implements MouseClickable. It signals (via a true
// return) that the click lies on the thinking box so the caller can
// invoke [AssistantMessageItem.ToggleExpanded] through the generic
// [Expandable] path. Toggling here directly would double-toggle because
// the caller always runs the generic path after a handled click.
func (a *AssistantMessageItem) HandleMouseClick(btn ansi.MouseButton, x, y int) bool {
	if btn != ansi.MouseLeft {
		return false
	}
	// Only the thinking box is clickable; other regions of the assistant
	// message should not trigger expansion.
	return a.thinkingBoxHeight > 0 && y < a.thinkingBoxHeight
}

// HandleKeyEvent implements KeyEventHandler.
func (a *AssistantMessageItem) HandleKeyEvent(key tea.KeyMsg) (bool, tea.Cmd) {
	if k := key.String(); k == "c" || k == "y" {
		text := a.message.Content().Text
		return true, common.CopyToClipboard(text, "Message copied to clipboard")
	}
	return false, nil
}
