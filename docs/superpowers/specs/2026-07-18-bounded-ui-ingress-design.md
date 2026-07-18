# Bounded Go UI ingress

Status: implemented and verified.

## Historical baseline

Before this change, `GmpWorkspace.sendUI` used a 1,024-slot channel and spilled
overflow into one goroutine per message. That path was unbounded and reordered
snapshots around terminal events.

## Contract

- `sendUI` never waits for `Program.Send`.
- Semantic edges stay FIFO: create, finish, auth, approval, and backend exit.
- Pending updates for one message may collapse to their newest full snapshot.
- An update never crosses a later semantic edge.
- Finished message snapshots are semantic edges, never coalesced updates.
- One drain goroutine owns `Program.Send`. One overload may start one closer,
  never one goroutine per offer.
- The mailbox admits 256 normal slots and one terminal overload slot. The
  first overflowing offer latches, appends a visible overload exit, wakes the
  drainer, and starts one backend close outside the mailbox mutex. Later
  offers drop.
- The lower transport queues fail closed on overflow. They close every fan-out
  channel and reap the backend instead of dropping a protocol edge.

## Design

Use a mutex-protected mailbox plus a one-slot wake channel.

The mailbox stores FIFO slots. A pending `pubsub.UpdatedEvent[message.Message]`
is indexed by message ID. Another update for that ID replaces the same slot.
Any non-coalescible message is a barrier: clear the update index, then append
the edge. Later updates therefore append after it.

The drain goroutine removes one slot at a time and calls `Program.Send`.
Producers only mutate the mailbox and signal the wake channel. The queue grows
with distinct semantic work, not token-stream frequency. At the normal cap,
the reserved terminal slot preserves all queued edges and makes overload
visible before the backend closes.

## Rejected designs

- Generic bounded dropping: may lose create, auth, approval, or exit edges.
- Blocking on a full channel: can deadlock Bubble Tea's update loop.
- Per-offer overflow goroutines: unbounded and not FIFO.
- Whole-workspace reconciliation: strongest long-term shape, but too broad for
  this change. It requires replacing every event-driven UI transition.

## Proof

- Hold `Program.Send`; enqueue thousands of updates for one message. `sendUI`
  stays non-blocking and the mailbox retains one update.
- Put a terminal edge between two update bursts. Delivery is final pre-edge
  snapshot, edge, final post-edge snapshot.
- Hold `Program.Send`; fill 256 distinct edges. The next offer creates exactly
  one terminal overload message, then later offers make no change.
- Run workspace race tests and live high-rate tool streaming.
