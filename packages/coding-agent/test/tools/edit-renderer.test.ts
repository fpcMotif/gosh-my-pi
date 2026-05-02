import { describe, expect, it } from "bun:test";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("editToolRenderer", () => {
	it("shows the target path from partial JSON while edit args stream", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				edits: [{}],
				__partialJson: '{"edits":[{"path":"packages/coding-agent/src/edit/renderer.ts","old_text":"before',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});

	it("uses atom input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				input: "---packages/coding-agent/src/edit/renderer.ts\n$\n+// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "atom" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
	});

	it("recognizes compact and quoted atom input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactComponent = editToolRenderer.renderCall(
			{
				input: "---foo bar.ts\n^\n+// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "atom" } },
			uiTheme,
		);

		const quotedComponent = editToolRenderer.renderCall(
			{
				input: "---'baz qux.ts'\n+// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "atom" } },
			uiTheme,
		);

		const compactRendered = Bun.stripANSI(compactComponent.render(160).join("\n"));
		const quotedRendered = Bun.stripANSI(quotedComponent.render(160).join("\n"));
		expect(compactRendered).toContain("foo bar.ts");
		expect(quotedRendered).toContain("baz qux.ts");
	});

	it("uses atom input headers for completed single-file result path", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/renderer.ts" }],
				details: {
					diff: "+1|// preview",
					op: "update",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "atom" } },
			uiTheme,
			{
				input: "---packages/coding-agent/src/edit/renderer.ts\n$\n+// preview",
			},
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain(" …");
	});

	it("sanitizes rendered error text and keeps UI lines width-bounded", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: `Failed\tto apply patch\nbad\u0007control\n${"x".repeat(80)}`,
					},
				],
				details: {
					diff: "",
					op: "update",
				},
				isError: true,
			},
			{ expanded: true, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{
				path: "/tmp/example.ts",
				oldText: "before",
				newText: "after",
			},
		);

		const lines = component.render(40);
		const rendered = Bun.stripANSI(lines.join("\n"));

		expect(rendered).toContain("Failed   to apply patch");
		expect(rendered).toContain("badcontrol");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\u0007");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});
});
