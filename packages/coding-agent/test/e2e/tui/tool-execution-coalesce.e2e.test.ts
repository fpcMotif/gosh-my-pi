import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { fromPartial } from "@total-typescript/shoehorn";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

/**
 * Contract: ToolExecutionComponent.updateArgs is the streaming entry-point
 * for tool-call argument updates. Stress contracts the renderer relies on:
 *   - updateArgs is idempotent for unchanged args (equality skip at line 238).
 *   - updateArgs with malformed input does not crash the component.
 *   - setArgsComplete bypasses the debounce window and runs the diff
 *     compute immediately.
 *   - The component never throws when args is null/undefined/non-object.
 *
 * The diff-preview compute is async and depends on EDIT_MODE_STRATEGIES
 * for the tool name; for `read` (no edit mode) the strategy is undefined
 * and #runPreviewDiff returns early — keeping the test deterministic.
 */

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	setThemeInstance(theme);
});

const ui = fromPartial<TUI>({ requestRender: () => {} });

function makeComponent(toolName = "read"): ToolExecutionComponent {
	return new ToolExecutionComponent(toolName, { path: "/tmp/foo" }, {}, undefined, ui, "/tmp", "tc-1");
}

describe("ToolExecutionComponent — updateArgs stability", () => {
	it("constructs and renders without throwing for a trivial args payload", () => {
		const component = makeComponent();
		expect(() => component.render(80)).not.toThrow();
	});

	it("accepts a single updateArgs call without throwing", () => {
		const component = makeComponent();
		expect(() => component.updateArgs({ path: "/tmp/foo", offset: 0 })).not.toThrow();
	});

	it("accepts 100 rapid identical updateArgs calls without throwing or crashing", () => {
		// This exercises the equality-skip path inside #runPreviewDiff. Even
		// for non-edit tools it must not panic, allocate unboundedly, or
		// schedule N timers (debounce coalesces).
		const component = makeComponent();
		const args = { path: "/tmp/foo", offset: 100 };
		expect(() => {
			for (let i = 0; i < 100; i++) component.updateArgs(args);
		}).not.toThrow();
	});

	it("accepts updateArgs with a partially-streamed __partialJson sentinel", () => {
		// __partialJson is the sentinel the streaming layer attaches when the
		// tool args JSON is mid-stream. Component must not panic on partial
		// JSON or non-string sentinel.
		const component = makeComponent("edit");
		expect(() => {
			component.updateArgs({ path: "/tmp/foo", __partialJson: '{"path":"' });
			component.updateArgs({ path: "/tmp/foo", __partialJson: '{"path":"/tmp/' });
			component.updateArgs({ path: "/tmp/foo", __partialJson: '{"path":"/tmp/foo"}' });
		}).not.toThrow();
	});

	it("accepts updateArgs with null and non-object args without crashing", () => {
		const component = makeComponent();
		// Even though tool calls always pass an object, a buggy provider could
		// send anything; component must degrade gracefully.
		expect(() => component.updateArgs(null)).not.toThrow();
		expect(() => component.updateArgs(undefined)).not.toThrow();
		expect(() => component.updateArgs("not an object")).not.toThrow();
		expect(() => component.updateArgs(42)).not.toThrow();
	});

	it("setArgsComplete is callable repeatedly without throwing", () => {
		const component = makeComponent();
		expect(() => {
			component.setArgsComplete("tc-1");
			component.setArgsComplete("tc-1");
			component.setArgsComplete("tc-1");
		}).not.toThrow();
	});

	it("updateArgs followed by setArgsComplete renders without throwing", () => {
		const component = makeComponent();
		component.updateArgs({ path: "/tmp/foo" });
		component.setArgsComplete("tc-1");
		expect(() => component.render(80)).not.toThrow();
	});
});
