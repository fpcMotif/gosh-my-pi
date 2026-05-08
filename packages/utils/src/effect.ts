// Curated Effect re-surface for the workspace.
// Consumers should import from "@oh-my-pi/pi-utils/effect" rather than "effect" directly,
// so the dep version (and any future workspace-wide policy) is pinned in one place.
//
// Only the stable API surface that exists in both Effect v3 and v4-beta is re-exported here.
// v4-only primitives (e.g. Workflow at "effect/unstable/workflow") are intentionally NOT
// re-exported until v4 GA.

export * as Cause from "effect/Cause";
export * as Context from "effect/Context";
export * as Data from "effect/Data";
export * as Duration from "effect/Duration";
export * as Effect from "effect/Effect";
export * as Exit from "effect/Exit";
export * as Fiber from "effect/Fiber";
export * as Layer from "effect/Layer";
export * as Option from "effect/Option";
export * as Schedule from "effect/Schedule";
export * as Stream from "effect/Stream";

export { effectFromSignal, signalFromFiber } from "./effect-signal";
