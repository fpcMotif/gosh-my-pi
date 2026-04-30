import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

function makeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 12,
		output: 34,
		cacheRead: 0,
		cacheWrite: 5,
		totalTokens: 51,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function makeAssistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: makeUsage({ input: 0, output: 0, cacheWrite: 0 }),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function renderPlain(component: AssistantMessageComponent, width: number): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function expectWidthBounded(component: AssistantMessageComponent, width: number): void {
	for (const line of component.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	_resetSettingsForTest();
});

describe("AssistantMessageComponent", () => {
	it("preserves assistant content order and sanitizes rendered tabs", () => {
		const message = makeAssistantMessage({
			content: [
				{ type: "text", text: "First response" },
				{ type: "thinking", thinking: "thinking\ttrace" },
				{ type: "text", text: "Second response" },
			],
		});
		const component = new AssistantMessageComponent(message, false);
		const rendered = renderPlain(component, 72);

		expect(rendered.indexOf("First response")).toBeGreaterThanOrEqual(0);
		expect(rendered.indexOf("thinking   trace")).toBeGreaterThan(rendered.indexOf("First response"));
		expect(rendered.indexOf("Second response")).toBeGreaterThan(rendered.indexOf("thinking   trace"));
		expect(rendered).not.toContain("\t");
		expectWidthBounded(component, 72);
	});

	it("honors hidden thinking while preserving visible answer text", () => {
		const message = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: "internal notes" },
				{ type: "text", text: "Visible answer" },
			],
		});
		const component = new AssistantMessageComponent(message, true);
		const rendered = renderPlain(component, 64);

		expect(rendered).toContain("Thinking...");
		expect(rendered).not.toContain("internal notes");
		expect(rendered).toContain("Visible answer");
		expectWidthBounded(component, 64);
	});

	it("surfaces aborted and error messages after partial assistant text", () => {
		const aborted = new AssistantMessageComponent(
			makeAssistantMessage({
				content: [{ type: "text", text: "Partial answer" }],
				stopReason: "aborted",
				errorMessage: "User cancelled from test",
			}),
		);
		const errored = new AssistantMessageComponent(
			makeAssistantMessage({
				content: [{ type: "text", text: "Partial answer" }],
				stopReason: "error",
				errorMessage: "Provider failed from test",
			}),
		);

		expect(renderPlain(aborted, 80)).toContain("User cancelled from test");
		expect(renderPlain(errored, 80)).toContain("Error: Provider failed from test");
		expectWidthBounded(aborted, 80);
		expectWidthBounded(errored, 80);
	});

	it("renders token usage footer only when enabled", () => {
		const message = makeAssistantMessage({ content: [{ type: "text", text: "Answer" }] });
		const component = new AssistantMessageComponent(message, false);
		component.setUsageInfo(makeUsage());

		expect(renderPlain(component, 80)).not.toContain("cache:");

		settings.set("display.showTokenUsage", true);
		component.invalidate();

		const rendered = renderPlain(component, 80);
		expect(rendered).toContain("17");
		expect(rendered).toContain("34");
		expectWidthBounded(component, 80);
	});
});
