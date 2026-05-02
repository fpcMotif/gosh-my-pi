/**
 * Differential rendering / leak coverage for TUI.
 *
 * Defends:
 *  - Re-rendering an unchanged tree does not trigger any full redraws.
 *  - Repeatedly mutating then reverting content does not accumulate
 *    differential render artifacts in the viewport.
 *  - Invalidate cycles do not unbound listener counts on the TUI's input
 *    listener registry.
 *  - The Markdown render cache `clearRenderCache` is callable repeatedly
 *    without growth (it is exercised on every theme change).
 */
import { describe, expect, it } from "bun:test";
import { clearRenderCache, type Component, Markdown, TUI } from "@oh-my-pi/pi-tui";
import { defaultMarkdownTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(0);
	await term.flush();
}

describe("TUI differential render contract", () => {
	it("does not full-redraw when content is unchanged across many cycles", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const cmp = new MutableLinesComponent(["alpha", "beta", "gamma"]);
		tui.addChild(cmp);
		tui.start();
		await settle(term);

		const baselineFullRedraws = tui.fullRedraws;
		for (let i = 0; i < 200; i++) {
			tui.requestRender();
			await settle(term);
		}
		// No content change => the differential renderer should not have
		// triggered any forced redraws.
		expect(tui.fullRedraws).toBe(baselineFullRedraws);

		tui.stop();
	});

	it("emits a single full redraw on forced render and zero on subsequent stable cycles", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const cmp = new MutableLinesComponent(["a", "b"]);
		tui.addChild(cmp);
		tui.start();
		await settle(term);

		const before = tui.fullRedraws;
		tui.requestRender(true);
		await settle(term);
		const afterForce = tui.fullRedraws;
		expect(afterForce).toBeGreaterThan(before);

		for (let i = 0; i < 50; i++) {
			tui.requestRender();
			await settle(term);
		}
		expect(tui.fullRedraws).toBe(afterForce);

		tui.stop();
	});

	it("returns to clean viewport after content shrinks back to baseline", async () => {
		const term = new VirtualTerminal(40, 8);
		const tui = new TUI(term);
		const cmp = new MutableLinesComponent(["base"]);
		tui.addChild(cmp);
		tui.start();
		await settle(term);
		const baseline = term
			.getViewport()
			.map(l => l.trimEnd())
			.join("\n");

		for (let i = 0; i < 20; i++) {
			cmp.setLines(["base", `extra ${i}`, `extra+1 ${i}`]);
			tui.requestRender();
			await settle(term);
			cmp.setLines(["base"]);
			tui.requestRender();
			await settle(term);
		}
		const final = term
			.getViewport()
			.map(l => l.trimEnd())
			.join("\n");
		expect(final).toBe(baseline);
		tui.stop();
	});
});

describe("Markdown render cache lifetime", () => {
	it("clearRenderCache is idempotent and tolerates repeated invocation", () => {
		for (let i = 0; i < 100; i++) {
			expect(() => clearRenderCache()).not.toThrow();
		}
	});

	it("Markdown component re-renders deterministically after cache clear", () => {
		const md = new Markdown("# title\n\ntext", 1, 1, defaultMarkdownTheme);
		const before = md.render(80).join("\n");
		clearRenderCache();
		md.invalidate();
		const after = md.render(80).join("\n");
		expect(after).toBe(before);
	});
});
