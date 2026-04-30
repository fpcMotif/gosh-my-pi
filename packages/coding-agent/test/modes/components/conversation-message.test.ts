import { beforeAll, describe, expect, it } from "bun:test";
import { CustomMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/custom-message";
import { SkillMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/skill-message";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { visibleWidth } from "@oh-my-pi/pi-tui";

function renderPlain(component: { render(width: number): string[] }, width: number): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function expectWidthBounded(component: { render(width: number): string[] }, width: number): void {
	for (const line of component.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

describe("conversation message framing", () => {
	it("renders user messages with prompt label, OSC prompt markers, and bounded width", () => {
		const component = new UserMessageComponent("hello\tworld");
		const raw = component.render(50).join("\n");
		const rendered = Bun.stripANSI(raw);

		expect(rendered).toContain("you");
		expect(rendered).toContain("hello   world");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw).toContain("\x1b]133;B\x07");
		expectWidthBounded(component, 50);
	});

	it("renders default custom messages with type label and sanitized body", () => {
		const message: CustomMessage = {
			role: "custom",
			customType: "note",
			content: "body\tline",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message);
		const rendered = renderPlain(component, 60);

		expect(rendered).toContain("custom note");
		expect(rendered).toContain("body   line");
		expectWidthBounded(component, 60);
	});

	it("renders skill summaries collapsed and prompt content when expanded", () => {
		const message: CustomMessage<SkillPromptDetails> = {
			role: "custom",
			customType: "skill-prompt",
			content: "skill prompt body",
			display: true,
			timestamp: Date.now(),
			details: { name: "review", path: "skills/review/SKILL.md", lineCount: 2 },
		};
		const component = new SkillMessageComponent(message);
		const collapsed = renderPlain(component, 72);

		expect(collapsed).toContain("skill");
		expect(collapsed).toContain("Skill: review");
		expect(collapsed).toContain("Prompt: 2 lines");
		expect(collapsed).not.toContain("skill prompt body");

		component.setExpanded(true);
		const expanded = renderPlain(component, 72);
		expect(expanded).toContain("Prompt");
		expect(expanded).toContain("skill prompt body");
		expectWidthBounded(component, 72);
	});
});
