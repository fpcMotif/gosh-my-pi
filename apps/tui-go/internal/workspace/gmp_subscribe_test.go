package workspace

import "testing"

// TestDrainStep_RecoversAndContinues pins the drainer-resilience contract: a
// panic processing one side-channel frame must not unwind the drain loop. The
// bug this guards against put recover() at goroutine scope (deferred in the
// drain func), so the first panicking frame killed the whole `for range`
// drainer — with no consumer the side-channel buffer then filled after 16
// frames and wedged the ompclient read loop (stalling responses and agent
// events too). drainStep scopes recover to a single iteration, so the loop
// keeps draining subsequent frames.
func TestDrainStep_RecoversAndContinues(t *testing.T) {
	t.Parallel()
	calls := 0
	steps := []func(){
		func() { calls++ },
		func() { calls++; panic("bad frame") },
		func() { calls++ },
	}
	for _, fn := range steps {
		// Must not propagate the panic to this loop — that is the regression.
		drainStep("test", fn)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3: drainStep must isolate a per-frame panic so every frame is still processed", calls)
	}
}
