import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "../../../src/modes/components/bash-execution";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

/**
 * Contract: BashExecutionComponent.appendOutput is intentionally throttled
 * so that a 500M-line stream cannot saturate the event loop. The throttle
 * accepts one chunk per CHUNK_THROTTLE_MS (50ms) window and DROPS the rest;
 * the upstream OutputSink captures every byte for the final artifact, and
 * setComplete(...{output}) replaces the streamed view with the canonical
 * output once the command finishes.
 *
 * Lockdown coverage of three pieces of behaviour the user-visible UX
 * depends on:
 *   1. Single-chunk and multi-line chunks render as-is.
 *   2. The 50ms gate drops mid-window chunks (intentional perf optimisation).
 *   3. setComplete({output}) replaces the throttled view with the full
 *      output - no chunk is lost forever.
 */

const CHUNK_THROTTLE_MS = 50;
const STREAMING_LINE_CAP = 100; // PREVIEW_LINES * 5

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	setThemeInstance(theme);
});

const ui = { requestRender: () => {} } as unknown as TUI;

describe("BashExecutionComponent — chunk throttling and final flush", () => {
	it("renders a single chunk verbatim into the output buffer", () => {
		const component = new BashExecutionComponent("echo hi", ui, false);
		component.appendOutput("hello world");
		expect(component.getOutput()).toBe("hello world");
	});

	it("accumulates multi-line content within a single chunk", () => {
		const component = new BashExecutionComponent("seq 1 3", ui, false);
		component.appendOutput("1\n2\n3");
		expect(component.getOutput()).toBe("1\n2\n3");
	});

	it("merges the leading line of a follow-up chunk with the trailing line of the prior chunk", async () => {
		const component = new BashExecutionComponent("printf", ui, false);
		component.appendOutput("first part ");
		// Wait past the throttle gate so the second chunk is processed too.
		await Bun.sleep(CHUNK_THROTTLE_MS + 5);
		component.appendOutput("second part\nnext line");
		expect(component.getOutput()).toBe("first part second part\nnext line");
	});

	it("drops mid-window chunks while the throttle gate is open (intentional perf optimisation)", () => {
		const component = new BashExecutionComponent("seq", ui, false);
		// First chunk passes the gate.
		component.appendOutput("chunk-0");
		// Subsequent chunks within 50ms are dropped from the displayed buffer.
		// (The upstream OutputSink captures them; setComplete replays the full output.)
		for (let i = 1; i < 50; i++) component.appendOutput(`drop-${i}`);
		const output = component.getOutput();
		expect(output).toBe("chunk-0");
		// None of the dropped tokens leaked into the displayed buffer.
		expect(output).not.toContain("drop-");
	});

	it("processes a fresh chunk after the throttle window elapses", async () => {
		const component = new BashExecutionComponent("seq", ui, false);
		component.appendOutput("a");
		// During gate: dropped.
		component.appendOutput("dropped");
		// Wait for the gate to clear.
		await Bun.sleep(CHUNK_THROTTLE_MS + 5);
		component.appendOutput("b");
		const output = component.getOutput();
		// Final line is "ab" because chunks merge their boundary line.
		expect(output).toBe("ab");
		expect(output).not.toContain("dropped");
	});

	it("caps the displayed line count at STREAMING_LINE_CAP during streaming", async () => {
		const component = new BashExecutionComponent("yes", ui, false);
		const giant = Array.from({ length: STREAMING_LINE_CAP * 3 }, (_, i) => `line-${i}`).join("\n");
		component.appendOutput(giant);
		const lines = component.getOutput().split("\n");
		expect(lines.length).toBeLessThanOrEqual(STREAMING_LINE_CAP);
		// Most recent lines kept (slice(-STREAMING_LINE_CAP)).
		expect(lines.at(-1)).toBe(`line-${STREAMING_LINE_CAP * 3 - 1}`);
	});

	it("setComplete({output}) replaces the throttled view with the canonical full output", () => {
		const component = new BashExecutionComponent("seq", ui, false);
		component.appendOutput("partial-during-stream");
		for (let i = 0; i < 10; i++) component.appendOutput(`drop-${i}`);
		// Caller passes the full captured output to setComplete - this is the
		// guarantee that throttle drops are not user-visible after completion.
		component.setComplete(0, false, { output: "1\n2\n3\n4\n5" });
		expect(component.getOutput()).toBe("1\n2\n3\n4\n5");
	});

	it("setComplete without {output} keeps whatever the throttled view had", () => {
		const component = new BashExecutionComponent("true", ui, false);
		component.appendOutput("just-this");
		component.setComplete(0, false);
		expect(component.getOutput()).toBe("just-this");
	});
});
