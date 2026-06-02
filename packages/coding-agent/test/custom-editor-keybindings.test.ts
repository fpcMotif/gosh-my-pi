import { describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

describe("CustomEditor temporary model selector keybinding", () => {
	it("triggers the temporary selector from a remapped action key instead of Alt+P", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;
		editor.setActionKeys("app.model.selectTemporary", ["ctrl+y"]);

		editor.handleInput(ctrl("y"));
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});

	it("removes the default Alt+P shortcut when the action is disabled", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.setActionKeys("app.model.selectTemporary", []);
		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor custom key handlers", () => {
	it("registers, removes, and clears extension key handlers", () => {
		const editor = createEditor();
		const onCtrlY = vi.fn();
		const onCtrlU = vi.fn();

		editor.setCustomKeyHandler("ctrl+y", onCtrlY);
		editor.setCustomKeyHandler("ctrl+u", onCtrlU);

		editor.handleInput(ctrl("y"));
		expect(onCtrlY).toHaveBeenCalledTimes(1);
		expect(onCtrlU).not.toHaveBeenCalled();

		editor.removeCustomKeyHandler("ctrl+y");
		editor.handleInput(ctrl("y"));
		expect(onCtrlY).toHaveBeenCalledTimes(1);

		editor.handleInput(ctrl("u"));
		expect(onCtrlU).toHaveBeenCalledTimes(1);

		editor.clearCustomKeyHandlers();
		editor.handleInput(ctrl("u"));
		expect(onCtrlU).toHaveBeenCalledTimes(1);
	});
});
