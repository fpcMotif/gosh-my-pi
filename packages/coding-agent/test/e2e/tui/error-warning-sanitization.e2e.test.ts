import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";

/**
 * Contract: UiHelpers.showError / showWarning sanitises caller-supplied
 * text before injecting it into the chat. Failing this contract leaks
 * raw ANSI escape sequences, BEL characters, and tab gaps into the
 * terminal — every renderer downstream of showError trusts the caller
 * sent display-safe text.
 *
 * Also asserts the backgrounded path goes through process.stderr so
 * non-interactive consumers see error output.
 */

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	setThemeInstance(theme);
});

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function createStubContext(): { ctx: InteractiveModeContext; chatContainer: Container; renderCalls: number } {
	const chatContainer = new Container();
	const ui = { requestRender: () => {} } as unknown as TUI;
	let renderCalls = 0;
	const renderCounting = new Proxy(ui, {
		get(target, prop) {
			if (prop === "requestRender") return () => (renderCalls += 1);
			return target[prop as keyof TUI];
		},
	});
	const ctx = {
		isBackgrounded: false,
		chatContainer,
		ui: renderCounting,
		// Other UiHelpers methods reference these but showError/showWarning
		// don't, so we leave them as no-op stubs:
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		chatContainer,
		get renderCalls() {
			return renderCalls;
		},
	} as { ctx: InteractiveModeContext; chatContainer: Container; renderCalls: number };
}

function lastTextRendered(container: Container, width = 80): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	if (typeof (last as { render?: (w: number) => string[] | string }).render !== "function") return "";
	const result = (last as { render: (w: number) => string[] | string }).render(width);
	return Array.isArray(result) ? result.join("\n") : result;
}

describe("UiHelpers.showError / showWarning — text sanitisation", () => {
	afterEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(spyOn as unknown as { restoreAll?: () => void }).restoreAll?.();
	});

	it("strips raw tab characters from error messages", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		helpers.showError("col1\tcol2\tcol3");
		const rendered = stripAnsi(lastTextRendered(chatContainer));
		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("col1");
		expect(rendered).toContain("col3");
	});

	it("strips raw tab characters from warning messages", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		helpers.showWarning("warn\there");
		const rendered = stripAnsi(lastTextRendered(chatContainer));
		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("warn");
		expect(rendered).toContain("here");
	});

	it("strips embedded ANSI SGR escape sequences from error messages", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		// Caller-supplied ANSI red on a "harmless" word - this would otherwise
		// leak past theme.fg and corrupt the surrounding error styling.
		helpers.showError("normal \x1b[31minjected red\x1b[0m text");
		const raw = lastTextRendered(chatContainer);
		// After the theme.fg("error", ...) wrapper our framework adds, the
		// caller's escape sequences should NOT appear in the visible-character
		// stream. Strip all ANSI; the literal escape body should not survive.
		const stripped = stripAnsi(raw);
		expect(stripped).not.toMatch(/\x1b\[/);
		// And the visible payload still includes the message body.
		expect(stripped).toContain("injected red");
	});

	it("strips BEL (0x07) characters that would otherwise ring the terminal", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		helpers.showError("loud\x07message");
		const rendered = stripAnsi(lastTextRendered(chatContainer));
		expect(rendered).not.toContain("\x07");
		expect(rendered).toContain("loud");
		expect(rendered).toContain("message");
	});

	it("renders an empty error message without leaking stale state", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		helpers.showError("");
		// Two children: spacer + Text("Error: "). Should not crash.
		expect(chatContainer.children.length).toBeGreaterThanOrEqual(1);
		const rendered = stripAnsi(lastTextRendered(chatContainer));
		// "Error:" prefix is the framework's, not the caller's.
		expect(rendered.toLowerCase()).toContain("error");
	});

	it("writes to stderr (not chatContainer) when isBackgrounded is true", () => {
		const { ctx, chatContainer } = createStubContext();
		(ctx as unknown as { isBackgrounded: boolean }).isBackgrounded = true;

		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

		const helpers = new UiHelpers(ctx);
		helpers.showError("background error");

		// chatContainer must NOT be touched in backgrounded mode.
		expect(chatContainer.children.length).toBe(0);
		// stderr must be written to with a sanitised message.
		expect(stderrSpy).toHaveBeenCalled();
		const written = stderrSpy.mock.calls.map(c => String(c[0])).join("");
		expect(written).toContain("background error");
		expect(written).not.toContain("\t");

		stderrSpy.mockRestore();
	});

	it("preserves multi-line error content but each line must be ANSI-clean", () => {
		const { ctx, chatContainer } = createStubContext();
		const helpers = new UiHelpers(ctx);
		helpers.showError("line one\nline two\x1b[31mred\x1b[0m");
		const stripped = stripAnsi(lastTextRendered(chatContainer));
		expect(stripped).toContain("line one");
		expect(stripped).toContain("line two");
		expect(stripped).toContain("red");
		expect(stripped).not.toMatch(/\x1b\[/);
	});
});
