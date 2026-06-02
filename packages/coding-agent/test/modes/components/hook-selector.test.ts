import { beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";
import { initTheme } from "../../../src/modes/theme/theme";

describe("HookSelectorComponent", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders outlined options and handles navigation, selection, side actions, external editor, and cancel", () => {
		const selected: string[] = [];
		const onCancel = vi.fn();
		const onLeft = vi.fn();
		const onRight = vi.fn();
		const onExternalEditor = vi.fn();
		const selector = new HookSelectorComponent(
			"Choose **hook**",
			["one", "two", "three", "four"],
			option => selected.push(option),
			onCancel,
			{
				initialIndex: 1,
				outline: true,
				maxVisible: 3,
				onLeft,
				onRight,
				onExternalEditor,
				helpText: "custom help",
			},
		);

		const rendered = sanitizeText(selector.render(40).join("\n"));
		expect(rendered).toContain("custom help");
		expect(rendered).toContain("two");

		selector.handleInput("j");
		selector.handleInput("\r");
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[C");
		selector.handleInput(String.fromCharCode("g".charCodeAt(0) & 31));
		selector.handleInput("\x1b");
		selector.dispose();

		expect(selected).toEqual(["three"]);
		expect(onLeft).toHaveBeenCalledTimes(1);
		expect(onRight).toHaveBeenCalledTimes(1);
		expect(onExternalEditor).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
