import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import { _resetSettingsForTest, Settings, type SettingPath } from "../../../src/config/settings";
import {
	SettingsSelectorComponent,
	type SettingsRuntimeContext,
	type StatusLinePreviewSettings,
} from "../../../src/modes/components/settings-selector";
import { initTheme } from "../../../src/modes/theme/theme";

const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ENTER = "\n";
const ESC = "\x1b";

let tempRoot: string;

function render(component: SettingsSelectorComponent, width = 160): string {
	return sanitizeText(Bun.stripANSI(component.render(width).join("\n")));
}

function createContext(overrides: Partial<SettingsRuntimeContext> = {}): SettingsRuntimeContext {
	return fromAny<SettingsRuntimeContext>({
		availableThinkingLevels: ["low", "medium", "high"],
		thinkingLevel: "medium",
		availableThemes: ["pi-vivid", "nord"],
		cwd: tempRoot,
		...overrides,
	});
}

function createSelector(
	callbacks: {
		onChange?: (path: SettingPath, value: unknown) => void;
		onThemePreview?: (theme: string) => void | Promise<void>;
		onStatusLinePreview?: (settings: StatusLinePreviewSettings) => void;
		getStatusLinePreview?: () => string;
		onPluginsChanged?: () => void;
		onCancel?: () => void;
	} = {},
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(createContext(), {
		onChange: callbacks.onChange ?? vi.fn(),
		onThemePreview: callbacks.onThemePreview,
		onStatusLinePreview: callbacks.onStatusLinePreview,
		getStatusLinePreview: callbacks.getStatusLinePreview,
		onPluginsChanged: callbacks.onPluginsChanged,
		onCancel: callbacks.onCancel ?? vi.fn(),
	});
}

describe("SettingsSelectorComponent", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await initTheme(false, undefined, undefined, "dark", "light");
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settings-selector-"));
		await Settings.init({
			inMemory: true,
			cwd: tempRoot,
			agentDir: path.join(tempRoot, "agent"),
			overrides: {
				"statusLine.showHookStatus": true,
				"statusLine.preset": "pi-vivid",
				"statusLine.separator": "slash",
				"theme.dark": "pi-vivid",
			},
		});
	});

	afterEach(async () => {
		_resetSettingsForTest();
		await fs.rm(tempRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("renders the appearance tab and applies boolean setting changes with status preview refresh", () => {
		const changes: Array<{ path: SettingPath; value: unknown }> = [];
		let lastStatusPreview: StatusLinePreviewSettings | undefined;
		const onCancel = vi.fn();
		const component = createSelector({
			onChange: (path, value) => changes.push({ path, value }),
			onStatusLinePreview: preview => {
				lastStatusPreview = preview;
			},
			getStatusLinePreview: () => "status-preview",
			onCancel,
		});

		const initial = render(component);
		expect(initial).toContain("Settings:");
		expect(initial).toContain("Dark Theme");
		expect(initial).toContain("Preview:");
		expect(initial).toContain("status-preview");

		const focus = component.getFocusComponent();
		for (let i = 0; i < 6; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER);

		expect(changes).toContainEqual({ path: "statusLine.showHookStatus", value: false });
		expect(render(component)).toMatch(/Show Hook Status\s+false/);
		expect(lastStatusPreview).toMatchObject({ preset: "pi-vivid", separator: "slash" });

		component.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("uses runtime theme options, live preview text, and selected theme persistence", () => {
		const changes: Array<{ path: SettingPath; value: unknown }> = [];
		const onThemePreview = vi.fn(async () => {});
		const component = createSelector({
			onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
			onThemePreview,
			getStatusLinePreview: () => "theme-preview",
		});

		const focus = component.getFocusComponent();
		focus.handleInput?.(ENTER);
		const submenu = render(component);
		expect(submenu).toContain("Dark Theme");
		expect(submenu).toContain("Preview:");
		expect(submenu).toContain("theme-preview");

		focus.handleInput?.(DOWN);
		expect(onThemePreview).toHaveBeenCalledWith("nord");

		focus.handleInput?.(ENTER);
		expect(changes).toContainEqual({ path: "theme.dark", value: "nord" });
		expect(render(component)).toMatch(/Dark Theme\s+nord/);
	});

	it("previews and persists status-line preset submenu choices", () => {
		let lastStatusPreview: StatusLinePreviewSettings | undefined;
		const changes: Array<{ path: SettingPath; value: unknown }> = [];
		const component = createSelector({
			onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
			onStatusLinePreview: preview => {
				lastStatusPreview = preview;
			},
			getStatusLinePreview: () => "status-preview",
		});

		const focus = component.getFocusComponent();
		for (let i = 0; i < 4; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER);
		expect(render(component)).toContain("Status Line Preset");

		focus.handleInput?.(DOWN);
		expect(lastStatusPreview).toMatchObject({ preset: "default" });

		focus.handleInput?.(ENTER);
		expect(changes).toContainEqual({ path: "statusLine.preset", value: "default" });
		expect(render(component)).toMatch(/Status Line Preset\s+default/);
	});

	it("switches tabs and exposes the active focus component", () => {
		const onCancel = vi.fn();
		const component = createSelector({ onCancel });

		component.handleInput(TAB);
		expect(render(component)).toContain("Thinking Level");

		for (let i = 0; i < 7; i++) {
			component.handleInput(TAB);
		}
		expect(render(component)).toContain("Plugins");
		expect(component.getFocusComponent()).toBeDefined();

		component.handleInput(SHIFT_TAB);
		expect(render(component)).toContain("Providers");

		component.handleInput(ESC);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("edits free-text settings and keeps tab input inside the active text field", () => {
		const changes: Array<{ path: SettingPath; value: unknown }> = [];
		const component = createSelector({
			onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
		});

		// Tab 5 times past Appearance to land on the "Tools" tab (anchor: "Artifact spill threshold").
		for (let i = 0; i < 5; i++) {
			component.handleInput(TAB);
		}
		expect(render(component)).toContain("Artifact spill threshold");

		// Scroll 26 rows down within the Tools tab to reach the "Screenshot directory" text setting.
		// Brittle to settings-defs reordering; the two assertions below catch any drift.
		const focus = component.getFocusComponent();
		for (let i = 0; i < 26; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER);
		const editorOpen = render(component);
		expect(editorOpen).toContain("Screenshot directory");
		expect(editorOpen).toContain("Enter to save");

		component.handleInput(TAB);
		expect(render(component)).toContain("Screenshot directory");

		component.handleInput("/tmp/screens");
		component.handleInput(ENTER);
		expect(changes).toContainEqual({ path: "browser.screenshotDir", value: "/tmp/screens" });
		expect(render(component)).toContain("/tmp/screens");
	});

	it("populates the thinking-level submenu from the session's available levels", () => {
		const component = new SettingsSelectorComponent(
			createContext({ availableThinkingLevels: fromAny(["low", "high"]) }),
			{ onChange: vi.fn(), onCancel: vi.fn() },
		);

		component.handleInput(TAB); // Appearance -> Model tab
		component.getFocusComponent().handleInput?.(ENTER); // open the first Model setting: Thinking Level

		const submenu = render(component);
		expect(submenu).toContain("Thinking Level");
		expect(submenu).toContain("low");
		expect(submenu).toContain("high");
		expect(submenu).not.toContain("medium"); // not offered by the session, so not listed
	});

	it("restores the theme preview when the theme submenu is cancelled", () => {
		const themePreviews: string[] = [];
		const component = createSelector({
			onThemePreview: themeName => {
				themePreviews.push(themeName);
			},
			getStatusLinePreview: () => "theme-preview",
		});

		const focus = component.getFocusComponent();
		focus.handleInput?.(ENTER); // open Dark Theme submenu
		focus.handleInput?.(DOWN); // preview "nord"
		expect(themePreviews).toContain("nord");

		focus.handleInput?.(ESC); // cancel restores the persisted dark theme set in beforeEach overrides
		expect(themePreviews.at(-1)).toBe("pi-vivid");
		expect(render(component)).toContain("Dark Theme");
	});

	it("restores the persisted status-line preset preview when its submenu is cancelled", () => {
		let lastStatusPreview: StatusLinePreviewSettings | undefined;
		const component = createSelector({
			onStatusLinePreview: preview => {
				lastStatusPreview = preview;
			},
			getStatusLinePreview: () => "status-preview",
		});

		const focus = component.getFocusComponent();
		for (let i = 0; i < 4; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER); // open Status Line Preset submenu
		focus.handleInput?.(DOWN); // preview "default"
		expect(lastStatusPreview).toMatchObject({ preset: "default" });

		focus.handleInput?.(ESC); // cancel reverts to the persisted preset
		expect(lastStatusPreview).toMatchObject({ preset: "pi-vivid" });
	});

	it("emits separator-only previews on navigation and restores them on cancel", () => {
		let lastStatusPreview: StatusLinePreviewSettings | undefined;
		const component = createSelector({
			onStatusLinePreview: preview => {
				lastStatusPreview = preview;
			},
			getStatusLinePreview: () => "status-preview",
		});

		const focus = component.getFocusComponent();
		for (let i = 0; i < 5; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER); // open Status Line Separator submenu
		focus.handleInput?.(DOWN); // preview the next separator
		expect(lastStatusPreview?.separator).toBeDefined();
		expect(lastStatusPreview?.preset).toBeUndefined(); // separator preview carries only the separator

		focus.handleInput?.(ESC); // cancel reverts to the persisted separator
		expect(lastStatusPreview).toEqual({ separator: "slash" });
	});

	it("cancels when escape reaches the focused settings list directly", () => {
		const onCancel = vi.fn();
		const component = createSelector({ onCancel });

		component.getFocusComponent().handleInput?.(ESC); // escape with no submenu open
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("re-enables tab switching after a text-input submenu is cancelled", () => {
		const component = createSelector();
		// Same navigation as the "edits free-text settings" test: 5 TABs to the Tools tab,
		// then 26 DOWNs to the "Screenshot directory" row, then ENTER opens its text input.
		for (let i = 0; i < 5; i++) {
			component.handleInput(TAB);
		}
		const focus = component.getFocusComponent();
		for (let i = 0; i < 26; i++) {
			focus.handleInput?.(DOWN);
		}
		focus.handleInput?.(ENTER); // open the Screenshot directory text input
		expect(render(component)).toContain("Enter to save");

		focus.handleInput?.(ESC); // cancel the text input without saving
		expect(render(component)).not.toContain("Enter to save");

		component.handleInput(TAB); // tab switching works again once the field is closed
		expect(render(component)).not.toContain("Screenshot directory");
	});
});

// PluginSettingsComponent's onCancel/onPluginsChanged forwarders are uncovered — driving them
// requires a real plugin-discovery environment, and AGENTS.md forbids asserting passthrough wiring.
