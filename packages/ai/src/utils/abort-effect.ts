// Local-abort watchdog as an Effect.
//
// Runs an async body under a per-call AbortController plus a timeout.
// The Effect:
//   - succeeds with `void` when the body resolves first,
//   - fails with LocalAbort({kind, durationMs}) when the watchdog elapses,
//   - is interrupted (no failure) when the optional callerSignal aborts.
//
// In every case the per-call AbortController is aborted in the scope
// finalizer, so the body's underlying I/O sees `signal.aborted` regardless
// of which path wins the race. The body MUST thread the supplied signal
// into its fetch / SSE / WebSocket call — that is the only way the
// watchdog tear-down reaches the network.
//
// Public during the P4d-P4f window so non-codex providers can adopt the
// typed-error failure mode incrementally; once Http.requestStream is the
// single entrypoint (P4f) this helper becomes Layer-internal.

import { Duration, Effect, Schedule } from "@oh-my-pi/pi-utils/effect";
import { effectFromSignal } from "@oh-my-pi/pi-utils/effect-signal";
import { LocalAbort } from "../errors";

export interface LocalAbortWatchdogOpts {
	/** Caller-supplied signal; when it fires the program is interrupted. */
	readonly callerSignal?: AbortSignal;
	/**
	 * Idle/first-event/handshake budget. `kind` selects which LocalAbort
	 * variant is raised when the budget elapses without progress.
	 */
	readonly watchdog: { readonly kind: "timeout" | "idle" | "stall"; readonly timeoutMs: number };
	/**
	 * The actual work. Receives a per-call AbortSignal owned by this
	 * helper; the body MUST thread it into whatever fetch / SSE / WS API
	 * it drives so a watchdog hit also tears down the underlying I/O.
	 */
	readonly body: (signal: AbortSignal) => Promise<void>;
}

/**
 * Build a watchdog Effect that fails with a tagged LocalAbort after
 * `timeoutMs` elapses. Exposed so other Effect pipelines can splice the
 * same failure shape into their own Effect.raceFirst / Effect.timeout
 * combinators without re-deriving the kind/duration plumbing.
 */
export const watchdogFailureEffect = (kind: LocalAbort["kind"], timeoutMs: number): Effect.Effect<never, LocalAbort> =>
	Effect.fail(new LocalAbort({ kind, durationMs: timeoutMs })).pipe(Effect.delay(Duration.millis(timeoutMs)));

/**
 * One-shot delay Schedule pinned to a single Effect.sleep so call sites that
 * need a watchdog-shaped Schedule (e.g. composing Effect.repeat or
 * Effect.scheduleFrom) get one without re-deriving the spaced+recurs pair.
 */
export const oneShotWatchdogSchedule = (timeoutMs: number): Schedule.Schedule<number> =>
	Schedule.recurs(0).pipe(Schedule.addDelay(() => Effect.succeed(Duration.millis(timeoutMs))));

export const runWithLocalAbortWatchdog = (opts: LocalAbortWatchdogOpts): Effect.Effect<void, LocalAbort> =>
	Effect.scoped(
		Effect.gen(function* () {
			const controller = new AbortController();
			yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

			// Use Effect.suspend so opts.body runs synchronously the moment
			// the work fiber starts, not after a tryPromise scheduling tick.
			// The body's own rejection is swallowed: the helper's contract is
			// race outcome only — body errors are surfaced through the body's
			// own iterator/output channel, not this Effect.
			const work = Effect.suspend(() => {
				const promise = opts.body(controller.signal).then(
					() => undefined,
					() => undefined,
				);
				return Effect.promise(() => promise);
			});

			const watchdog = watchdogFailureEffect(opts.watchdog.kind, opts.watchdog.timeoutMs);

			const program: Effect.Effect<void, LocalAbort> = Effect.raceFirst(work, watchdog);

			if (opts.callerSignal === undefined) {
				return yield* program;
			}
			return yield* effectFromSignal(opts.callerSignal, program);
		}),
	);
