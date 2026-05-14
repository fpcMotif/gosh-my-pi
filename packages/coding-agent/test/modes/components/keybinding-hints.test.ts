import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { initTheme } from "../../../src/modes/theme/theme";
import { appKey, appKeyHint, editorKey, keyHint, rawKeyHint } from "../../../src/modes/components/keybinding-hints";

describe("keybinding hint helpers", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.confirm": ["enter", "ctrl+j"],
			}),
		);
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("formats editor, app, and raw key hints from configured bindings", () => {
		const appBindings = KeybindingsManager.inMemory({
			"app.editor.external": ["ctrl+g", "alt+e"],
			"app.session.new": [],
		});

		expect(editorKey("tui.select.confirm")).toBe("enter/ctrl+j");
		expect(appKey(appBindings, "app.editor.external")).toBe("ctrl+g/alt+e");
		expect(appKey(appBindings, "app.session.new")).toBe("");
		expect(keyHint("tui.select.confirm", "accept")).toContain("accept");
		expect(appKeyHint(appBindings, "app.editor.external", "edit")).toContain("edit");
		expect(rawKeyHint("↑↓", "move")).toContain("move");
	});
});
