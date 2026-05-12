// Effect-side replacement for the legacy `createAbortSourceTracker` helper.
//
// `runWithLocalAbortWatchdog` runs a Promise-returning body inside an Effect
// scope, racing it against a first-event watchdog Effect. The body receives a
// per-call `AbortSignal` whose owning controller is aborted by the scope
// finalizer on any non-success exit:
//
//   - body resolves            → finalizer skipped (controller stays open)
//   - body throws              → fiber fails, finalizer aborts controller
//   - watchdog Effect fires    → race interrupts body fiber, finalizer aborts
//   - caller signal aborts     → effectFromSignal interrupts, finalizer aborts
//
// The single `controller.signal` threaded into `body` is the only signal a
// caller has to plumb into `fetch` / SDK calls. There is no `AbortSignal.any`
// merge — every cancellation source flows through the scope finalizer.
//
// Idle-timeout throws from `iterateWithIdleTimeout` are detected by the
// shared `STREAM_STALLED_SUFFIX` substring and re-raised as
// `LocalAbort({ kind: "idle" })`; first-event watchdog wins are raised as
// `LocalAbort({ kind, durationMs })` directly.

import { Effect, effectFromSignal } from "@oh-my-pi/pi-utils/effect";
import { LocalAbort } from "../errors";
import { STREAM_STALLED_SUFFIX } from "./idle-iterator";

export interface WatchdogConfig {
	readonly kind: "timeout" | "idle" | "stall";
	readonly timeoutMs: number;
}

export interface RunWithWatchdogOptions {
	readonly callerSignal?: AbortSignal;
	readonly firstEventWatchdog?: WatchdogConfig;
	readonly body: (signal: AbortSignal) => Promise<void>;
}

export function runWithLocalAbortWatchdog(opts: RunWithWatchdogOptions): Promise<void> {
	const { callerSignal, firstEventWatchdog, body } = opts;
	const program = Effect.scoped(
		Effect.gen(function* () {
			const controller = new AbortController();
			yield* Effect.addFinalizer(exit =>
				Effect.sync(() => {
					if (exit._tag !== "Success" && !controller.signal.aborted) {
						controller.abort();
					}
				}),
			);

			const startedAt = Date.now();

			const bodyEffect = Effect.tryPromise({
				try: effectSignal => {
					if (effectSignal.aborted) {
						controller.abort();
					} else {
						effectSignal.addEventListener(
							"abort",
							() => {
								if (!controller.signal.aborted) controller.abort();
							},
							{ once: true },
						);
					}
					return body(controller.signal);
				},
				catch: (cause: unknown): LocalAbort | unknown => {
					if (cause instanceof Error && cause.message.endsWith(STREAM_STALLED_SUFFIX)) {
						return new LocalAbort({ kind: "idle", durationMs: Date.now() - startedAt });
					}
					return cause;
				},
			});

			const watchdogEffect: Effect.Effect<never, LocalAbort> =
				firstEventWatchdog && firstEventWatchdog.timeoutMs > 0
					? Effect.flatMap(Effect.sleep(`${firstEventWatchdog.timeoutMs} millis`), () =>
							Effect.fail(
								new LocalAbort({
									kind: firstEventWatchdog.kind,
									durationMs: firstEventWatchdog.timeoutMs,
								}),
							),
						)
					: Effect.never;

			const raced = Effect.raceFirst(bodyEffect, watchdogEffect);
			return yield* callerSignal ? effectFromSignal(callerSignal, raced) : raced;
		}),
	);
	return Effect.runPromise(program);
}
