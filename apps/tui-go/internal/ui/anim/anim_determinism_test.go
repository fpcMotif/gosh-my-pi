package anim

import (
	"image/color"
	"testing"
)

// testSettings mirrors the call shape used by internal/ui/chat
// (assistant.go / tools.go build anim.New with an explicit ID, a fixed
// Size, gradient/label colors, and CycleColors=true). Colors are passed
// explicitly so the test does not depend on the styles package.
func testSettings(id string) Settings {
	return Settings{
		ID:          id,
		Size:        15,
		Label:       "Working",
		GradColorA:  color.RGBA{R: 0xff, G: 0x00, B: 0x00, A: 0xff},
		GradColorB:  color.RGBA{R: 0x00, G: 0x00, B: 0xff, A: 0xff},
		LabelColor:  color.RGBA{R: 0xcc, G: 0xcc, B: 0xcc, A: 0xff},
		CycleColors: true,
	}
}

// tick advances an Anim by n step messages, the same path the Bubble Tea
// model drives via StepMsg -> Animate.
func tick(a *Anim, n int) {
	for range n {
		a.Animate(StepMsg{ID: a.id})
	}
}

// Two Anims built from identical Settings (including the same ID) must
// render byte-identically before any tick. This is the property that the
// old wall-clock + time-seeded-rand implementation could not guarantee:
// birthOffsets were drawn from a clock-seeded RNG and the birth gate
// compared time.Since(startTime), so two instances diverged by wall clock.
func TestRenderDeterministicBeforeTick(t *testing.T) {
	a := New(testSettings("spinner-x"))
	b := New(testSettings("spinner-x"))

	if got, want := a.Render(), b.Render(); got != want {
		t.Fatalf("Render() before any tick differs across identical Settings:\n a=%q\n b=%q", got, want)
	}
}

// After applying the same number of Animate ticks, two Anims built from
// identical Settings must still render byte-identically. Frame advance is
// driven purely by the step counter, not wall clock.
func TestRenderDeterministicAfterEqualTicks(t *testing.T) {
	a := New(testSettings("spinner-y"))
	b := New(testSettings("spinner-y"))

	for _, n := range []int{1, 5, maxBirthSteps, maxBirthSteps + 12, 100} {
		tick(a, n)
		tick(b, n)
		if got, want := a.Render(), b.Render(); got != want {
			t.Fatalf("Render() after equal tick counts (cumulative through +%d) differs:\n a=%q\n b=%q", n, got, want)
		}
	}
}

// The step counter must actually drive frames: a single Anim's Render
// output must change between tick 0 and a later tick. Without this the
// "deterministic" port could be trivially satisfied by a frozen frame.
func TestRenderAdvancesWithSteps(t *testing.T) {
	a := New(testSettings("spinner-z"))

	before := a.Render()
	// Advance well past the birth window so both the cycling frame and the
	// post-birth ellipsis state have moved.
	tick(a, maxBirthSteps+ellipsisAnimSpeed+1)
	after := a.Render()

	if before == after {
		t.Fatalf("Render() did not change after %d steps; animation is not step-driven:\n before=%q\n after=%q",
			maxBirthSteps+ellipsisAnimSpeed+1, before, after)
	}
}

// Distinct IDs must produce distinct staggered entrances: the birth
// schedule is seeded off the id, so two spinners with different ids should
// not march in lock-step during the fade-in window. This guards the
// id-derived birth seed (vs. a single global seed) without depending on
// wall clock.
func TestDistinctIDsStaggerDifferently(t *testing.T) {
	a := New(testSettings("id-a"))
	b := New(testSettings("id-b"))

	// Within the birth window, mid-fade, the birth gate should differ.
	tick(a, maxBirthSteps/2)
	tick(b, maxBirthSteps/2)

	if a.Render() == b.Render() {
		t.Fatalf("distinct IDs produced identical mid-fade Render(); birth schedule is not id-derived")
	}
}
