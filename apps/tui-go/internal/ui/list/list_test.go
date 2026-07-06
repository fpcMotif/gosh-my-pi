package list

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// trackedItem is a test helper that counts Render calls. The body of
// Render is the item's content concatenated with the width so that
// "served from cache" vs "freshly rendered" is observable both from
// the render-hit counter and from the rendered string itself.
type trackedItem struct {
	*Versioned
	body       string
	finished   bool
	renderHits int
}

func newTrackedItem(body string, finished bool) *trackedItem {
	return &trackedItem{
		Versioned: NewVersioned(),
		body:      body,
		finished:  finished,
	}
}

func (t *trackedItem) Render(width int) string {
	t.renderHits++
	return t.body + ":w=" + strconv.Itoa(width)
}

func (t *trackedItem) Finished() bool {
	return t.finished
}

// TestList_RenderMemo_PointerKey covers the G6 invariant that the
// list-level cache is keyed by item pointer, not slice index, so
// PrependItems and AppendItems do not shift cached entries to the
// wrong item.
func TestList_RenderMemo_PointerKey(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false)
	b := newTrackedItem("bravo", false)
	c := newTrackedItem("charlie", false)

	l := NewList(a, b, c)
	l.SetSize(40, 10)

	first := l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	// Prepending a new item must not shift the existing entries to the
	// wrong key. Scroll to the top so the prepended item is visible.
	z := newTrackedItem("zulu", false)
	l.PrependItems(z)
	l.ScrollToTop()
	_ = l.Render()
	require.Equal(t, 1, z.renderHits, "prepended item rendered once")
	require.Equal(t, 1, a.renderHits, "stable item must keep its cached entry across PrependItems")
	require.Equal(t, 1, b.renderHits, "stable item must keep its cached entry across PrependItems")
	require.Equal(t, 1, c.renderHits, "stable item must keep its cached entry across PrependItems")

	// AppendItems is symmetric.
	d := newTrackedItem("delta", false)
	l.AppendItems(d)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	require.Contains(t, first, "alpha")
}

// TestList_SetSize_WidthChangeInvalidates covers the G6 invariant that
// a width change drops every cached entry but a height-only change
// leaves the cache intact.
func TestList_SetSize_WidthChangeInvalidates(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false)
	b := newTrackedItem("bravo", false)

	l := NewList(a, b)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)

	// Height-only change: no invalidation.
	l.SetSize(40, 20)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits, "height-only change must keep cache entries")
	require.Equal(t, 1, b.renderHits, "height-only change must keep cache entries")

	// Width change: every entry invalidates.
	l.SetSize(80, 20)
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "width change must invalidate cache entries")
	require.Equal(t, 2, b.renderHits, "width change must invalidate cache entries")
}

// TestList_RemoveItem_DropsEntry covers the G6 invariant that
// RemoveItem drops the cache entry for the removed item but leaves the
// surviving entries in place.
func TestList_RemoveItem_DropsEntry(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false)
	b := newTrackedItem("bravo", false)
	c := newTrackedItem("charlie", false)

	l := NewList(a, b, c)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	l.RemoveItem(1) // remove b
	_ = l.Render()
	require.Equal(t, 1, a.renderHits, "stable item must keep cached entry across RemoveItem")
	require.Equal(t, 1, c.renderHits, "stable item must keep cached entry across RemoveItem")

	// Re-adding b must render it as if fresh — its entry was dropped.
	l.AppendItems(b)
	_ = l.Render()
	require.Equal(t, 2, b.renderHits, "re-added item must re-render")
}

// TestList_FrozenItem_RendersExactlyOnce covers the freeze rule:
// items that report Finished() == true on entry creation are marked
// frozen after the first render and are never re-rendered until width
// change or version bump. This is the core G6 perf contract — a
// spinner tick or scroll on an unrelated item must not re-render a
// finished item.
func TestList_FrozenItem_RendersExactlyOnce(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", true)
	b := newTrackedItem("bravo", true)

	l := NewList(a, b)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits, "frozen items render exactly once on first draw")
	require.Equal(t, 1, b.renderHits, "frozen items render exactly once on first draw")

	// Many subsequent renders must not re-render frozen items.
	for range 5 {
		_ = l.Render()
	}
	require.Equal(t, 1, a.renderHits, "frozen items must not re-render across redraws")
	require.Equal(t, 1, b.renderHits, "frozen items must not re-render across redraws")
}

// TestList_FrozenItem_TransitionsAfterFinish covers a streaming item
// that later reports Finished() == true: it transitions to frozen on
// the first render after finish and stops re-rendering afterwards.
func TestList_FrozenItem_TransitionsAfterFinish(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false) // streaming
	l := NewList(a)
	l.SetSize(40, 10)

	// While unfinished, every render with a version bump rebuilds the
	// cache because the item's Finished() is false.
	for range 3 {
		a.Bump()
		_ = l.Render()
	}
	require.Equal(t, 3, a.renderHits)

	// Item finishes; on the next render it freezes.
	a.finished = true
	a.Bump()
	_ = l.Render()
	require.Equal(t, 4, a.renderHits, "post-finish render still happens once")

	for range 5 {
		_ = l.Render()
	}
	require.Equal(t, 4, a.renderHits, "frozen after finish, no further renders")
}

// TestList_NonFinishedItem_ReRendersEachBump is the running-spinner
// contract: a non-Finished() item must re-render whenever its version
// bumps (each Animate tick), so the advanced spinner frame reaches the
// screen. Without a bump the version-stable entry is a cache hit.
func TestList_NonFinishedItem_ReRendersEachBump(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("spinner", false)
	l := NewList(a)
	l.SetSize(40, 10)

	_ = l.Render()
	require.Equal(t, 1, a.renderHits)

	// Each version bump (one per spinner tick) forces exactly one
	// re-render.
	for i := 1; i <= 5; i++ {
		a.Bump()
		_ = l.Render()
		require.Equal(t, 1+i, a.renderHits, "each spinner tick must re-render once")
	}

	// A redraw without a bump is a cache hit even for a non-finished
	// item: there is no new frame to show.
	_ = l.Render()
	require.Equal(t, 6, a.renderHits, "redraw without a bump must not re-render")
}

// TestList_FrozenItem_VersionBumpUnfreezes covers the rule that a
// frozen item that gets a version bump is unfrozen and re-rendered
// exactly once — no stale output — then re-freezes.
func TestList_FrozenItem_VersionBumpUnfreezes(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", true)
	l := NewList(a)
	l.SetSize(40, 10)

	_ = l.Render()
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)

	a.Bump()
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "version bump must invalidate frozen entry exactly once")

	// Re-renders without bumping go back to cache hits.
	_ = l.Render()
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "post-bump render re-freezes")
}

// TestList_FrozenItem_ResizeUnfreezes covers that a width change
// invalidates frozen entries.
func TestList_FrozenItem_ResizeUnfreezes(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", true)
	l := NewList(a)
	l.SetSize(40, 10)

	_ = l.Render()
	require.Equal(t, 1, a.renderHits)

	l.SetSize(80, 10)
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "width change must invalidate frozen entry")
}

// TestList_FrozenItem_SelectionDragUnfreeze covers the selection-drag
// escape hatch: an active selection-drag span must un-freeze items
// inside the range; ending the drag re-freezes them.
func TestList_FrozenItem_SelectionDragUnfreeze(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", true)
	b := newTrackedItem("bravo", true)
	c := newTrackedItem("charlie", true)

	l := NewList(a, b, c)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	// Begin a selection drag spanning items 0..1. Items inside the
	// range re-render exactly once (the un-freeze drops the cached
	// entry).
	l.BeginSelectionDrag(0, 1)
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "drag-spanned item must re-render once on entering the drag")
	require.Equal(t, 2, b.renderHits, "drag-spanned item must re-render once on entering the drag")
	require.Equal(t, 1, c.renderHits, "out-of-range item must remain frozen")

	// While the drag is active, items inside the range are not frozen
	// but version-stable, so subsequent renders hit the cache.
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "unfrozen but version-stable hits the cache")
	require.Equal(t, 2, b.renderHits, "unfrozen but version-stable hits the cache")

	// End the drag. Items inside the range re-render once and re-freeze.
	l.EndSelectionDrag()
	_ = l.Render()
	require.Equal(t, 3, a.renderHits, "post-drag render re-freezes the entry")
	require.Equal(t, 3, b.renderHits, "post-drag render re-freezes the entry")

	for range 3 {
		_ = l.Render()
	}
	require.Equal(t, 3, a.renderHits, "frozen after drag end")
	require.Equal(t, 3, b.renderHits, "frozen after drag end")
}

// TestList_RenderOutputStableAcrossDraws is the G6 byte-equality
// invariant: rendering the same list multiple times must produce the
// same bytes regardless of which items are frozen.
func TestList_RenderOutputStableAcrossDraws(t *testing.T) {
	t.Parallel()

	items := make([]Item, 0, 5)
	for i := range 5 {
		items = append(items, newTrackedItem("item-"+strconv.Itoa(i), i%2 == 0))
	}
	l := NewList(items...)
	l.SetSize(40, 20)

	first := l.Render()
	for range 4 {
		require.Equal(t, first, l.Render(), "render output must be byte-stable across draws")
	}
	require.True(t, strings.Contains(first, "item-0"))
}

// TestList_SetItems_PointerOverlapRetainsCache covers SetItems
// invalidation semantics. When the new slice shares some pointers with
// the previous slice, the cache entries for the surviving items must
// be retained; entries for removed items must be dropped.
func TestList_SetItems_PointerOverlapRetainsCache(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false)
	b := newTrackedItem("bravo", false)
	c := newTrackedItem("charlie", false)
	d := newTrackedItem("delta", false)

	l := NewList(a, b, c)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	// Replace the slice with one that shares a and c (b dropped, d added).
	l.SetItems(a, c, d)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits, "stable item must keep cached entry across SetItems")
	require.Equal(t, 1, c.renderHits, "stable item must keep cached entry across SetItems")
	require.Equal(t, 1, d.renderHits, "new item renders once")

	// Re-introducing b after it was dropped must rebuild its entry.
	l.SetItems(a, b, c)
	_ = l.Render()
	require.Equal(t, 2, b.renderHits, "re-introduced item must re-render — its old entry was dropped")
	require.Equal(t, 1, a.renderHits, "stable item retained across multiple SetItems")
	require.Equal(t, 1, c.renderHits, "stable item retained across multiple SetItems")
}

// TestList_SetItems_AllNewDropsEveryEntry covers the pure-replace case
// (e.g. session switch): a SetItems slice with no pointer overlap
// drops every previous cache entry.
func TestList_SetItems_AllNewDropsEveryEntry(t *testing.T) {
	t.Parallel()

	a := newTrackedItem("alpha", false)
	b := newTrackedItem("bravo", false)
	c := newTrackedItem("charlie", false)

	l := NewList(a, b, c)
	l.SetSize(40, 10)
	_ = l.Render()
	require.Equal(t, 1, a.renderHits)
	require.Equal(t, 1, b.renderHits)
	require.Equal(t, 1, c.renderHits)

	x := newTrackedItem("xray", false)
	y := newTrackedItem("yankee", false)
	l.SetItems(x, y)
	_ = l.Render()
	require.Equal(t, 1, x.renderHits, "new item renders once")
	require.Equal(t, 1, y.renderHits, "new item renders once")

	// Re-introducing the originals must rebuild every entry.
	l.SetItems(a, b, c)
	_ = l.Render()
	require.Equal(t, 2, a.renderHits, "previously-dropped item must re-render")
	require.Equal(t, 2, b.renderHits, "previously-dropped item must re-render")
	require.Equal(t, 2, c.renderHits, "previously-dropped item must re-render")
}

// TestVersioned_BumpMonotonic covers the basic Versioned contract:
// Version() starts at zero and Bump() advances it monotonically.
func TestVersioned_BumpMonotonic(t *testing.T) {
	t.Parallel()

	v := NewVersioned()
	require.Equal(t, uint64(0), v.Version())
	v.Bump()
	require.Equal(t, uint64(1), v.Version())
	v.Bump()
	v.Bump()
	require.Equal(t, uint64(3), v.Version())
}
