package workspace

import (
	"encoding/json"
	"testing"

	"github.com/fpcMotif/gosh-my-pi/apps/tui-go/internal/message"
)

func userMsg(id, text string) message.Message {
	return message.Message{
		ID:    id,
		Role:  message.User,
		Parts: []message.ContentPart{message.TextContent{Text: text}},
	}
}

// TestReconcileUserID_PrefersWireCorrelationID pins the correlation-id fix: when
// the backend echoes the id this frontend assigned, reconciliation is an exact
// id hit. This is robust even when two user messages share identical text —
// the case where the old content-match collapsed both echoes onto the most
// recent local message and orphaned the earlier one.
func TestReconcileUserID_PrefersWireCorrelationID(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	w.upsertMessageLocked(userMsg("user-A", "hi"))
	w.upsertMessageLocked(userMsg("user-B", "hi"))

	gotA, okA := w.reconcileUserIDLocked(userMsg("user-A", "hi"))
	if !okA || gotA != "user-A" {
		t.Fatalf("reconcile echo for first message = (%q,%v), want (user-A,true)", gotA, okA)
	}
	gotB, okB := w.reconcileUserIDLocked(userMsg("user-B", "hi"))
	if !okB || gotB != "user-B" {
		t.Fatalf("reconcile echo for second identical-text message = (%q,%v), want (user-B,true)", gotB, okB)
	}
}

// TestReconcileUserID_FallsBackToContentMatch covers an older backend that does
// not echo the id: the inbound id is unknown, so reconciliation falls back to
// content matching (preserving pre-fix behavior).
func TestReconcileUserID_FallsBackToContentMatch(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	w.upsertMessageLocked(userMsg("user-A", "hello"))

	got, ok := w.reconcileUserIDLocked(userMsg("unknown-fresh", "hello"))
	if !ok || got != "user-A" {
		t.Fatalf("content fallback = (%q,%v), want (user-A,true)", got, ok)
	}
}

// TestReconcileUserID_NoMatchReturnsFalse: an unknown id with novel text is a
// genuinely new message (CreatedEvent), not an update.
func TestReconcileUserID_NoMatchReturnsFalse(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	if _, ok := w.reconcileUserIDLocked(userMsg("brand-new", "never seen")); ok {
		t.Fatal("reconcile for a novel message returned ok=true, want false (new message)")
	}
}

// TestUpsertSeedsCounterPastAdoptedID pins the resume-collision fix (CID-1):
// after adopting a persisted user message whose correlation id is "user-1", the
// next minted id must be disjoint from it. Otherwise nextID("user") re-mints
// "user-1" and upsertMessageLocked overwrites the historical row in place,
// silently losing transcript content. Both rows must survive.
func TestUpsertSeedsCounterPastAdoptedID(t *testing.T) {
	w := NewGmpWorkspace(nil, "/tmp/project")
	// Resume: a persisted user message arrives carrying correlation id "user-1".
	w.upsertMessageLocked(userMsg("user-1", "OLD HISTORICAL PROMPT"))

	minted := w.nextID("user")
	if minted == "user-1" {
		t.Fatalf("nextID minted %q, colliding with the adopted resume id user-1", minted)
	}
	w.upsertMessageLocked(userMsg(minted, "BRAND NEW PROMPT"))

	if len(w.msgOrder) != 2 {
		t.Fatalf("msgOrder has %d rows, want 2; the new prompt clobbered the resumed one", len(w.msgOrder))
	}
	historical := w.messages["user-1"]
	if got := historical.Content().Text; got != "OLD HISTORICAL PROMPT" {
		t.Fatalf("resumed user-1 text = %q, want it preserved", got)
	}
}

func parseUserWireMessage(t *testing.T, fields map[string]any) message.Message {
	t.Helper()
	w := NewGmpWorkspace(nil, "/tmp/project")
	raw, err := json.Marshal(map[string]any{"message": fields})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	msg, ok := w.parseAgentMessage(raw, "message")
	if !ok {
		t.Fatal("parseAgentMessage returned ok=false")
	}
	return msg
}

// TestParseAgentMessage_AdoptsWireID: a backend-echoed user id is adopted
// verbatim (not replaced by a fresh local id) — this is what makes the
// id-based reconciliation a map hit.
func TestParseAgentMessage_AdoptsWireID(t *testing.T) {
	msg := parseUserWireMessage(t, map[string]any{
		"role":      "user",
		"id":        "user-42",
		"content":   "hi",
		"timestamp": 1_700_000_000_000,
	})
	if msg.ID != "user-42" {
		t.Fatalf("parsed user id = %q, want the wire correlation id user-42", msg.ID)
	}
}

// TestParseAgentMessage_NoWireIDGetsFreshID: a backend that omits the id still
// yields a usable (generated) id.
func TestParseAgentMessage_NoWireIDGetsFreshID(t *testing.T) {
	msg := parseUserWireMessage(t, map[string]any{
		"role":      "user",
		"content":   "hi",
		"timestamp": 1_700_000_000_000,
	})
	if msg.ID == "" || msg.ID == "user-42" {
		t.Fatalf("parsed user id = %q, want a freshly generated id", msg.ID)
	}
}
