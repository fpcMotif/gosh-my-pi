// Clock — Effect service for `Date.now()` + `Bun.sleep()`. Used by
// AgentRunController as a test seam: Live binding talks to the real
// runtime; tests provide a deterministic Layer.
//
// Co-located with AgentRunController in `./run/` rather than living
// under a generic `./layers/` directory because the only consumer in
// pi-agent-core is the run surface.

import { Context, Effect, Layer } from "@oh-my-pi/pi-utils/effect";

export interface ClockShape {
	readonly now: Effect.Effect<number>;
	readonly sleep: (ms: number) => Effect.Effect<void>;
}

export class Clock extends Context.Service<Clock, ClockShape>()("@oh-my-pi/pi-agent-core/Clock") {}

export const LiveClock: Layer.Layer<Clock> = Layer.succeed(Clock)({
	now: Effect.sync(() => Date.now()),
	sleep: ms => Effect.promise(() => Bun.sleep(ms)),
});
