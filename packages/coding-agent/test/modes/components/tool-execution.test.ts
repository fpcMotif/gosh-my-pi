import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toolRenderers, type ToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { fromPartial } from "@total-typescript/shoehorn";

const uiStub = fromPartial<TUI>({ requestRender() {} });

function renderPlain(component: ToolExecutionComponent, width: number): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function expectWidthBounded(component: ToolExecutionComponent, width: number): void {
	for (const line of component.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

describe("ToolExecutionComponent", () => {
	it("renders a pending generic tool with compact argument summary", () => {
		const component = new ToolExecutionComponent(
			"demo_tool",
			{ path: "src/demo.ts", mode: "read" },
			{},
			undefined,
			uiStub,
		);
		const rendered = renderPlain(component, 88);

		expect(rendered).toContain("demo_tool");
		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("read");
		expectWidthBounded(component, 88);
	});

	it("renders successful output with sanitized raw content", () => {
		const component = new ToolExecutionComponent("demo_tool", { path: "demo.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "alpha\tbeta\nsecond line" }],
			},
			false,
		);

		const rendered = renderPlain(component, 72);
		expect(rendered).toContain("demo_tool");
		expect(rendered).toContain("alpha   beta");
		expect(rendered).toContain("second line");
		expect(rendered).not.toContain("\t");
		expectWidthBounded(component, 72);
	});

	it("renders errored output distinctly without hiding the failure text", () => {
		const component = new ToolExecutionComponent("demo_tool", { path: "demo.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "failed\tbadly" }],
				isError: true,
			},
			false,
		);

		const rendered = renderPlain(component, 72);
		expect(rendered).toContain("demo_tool");
		expect(rendered).toContain("failed   badly");
		expect(rendered).not.toContain("\t");
		expectWidthBounded(component, 72);
	});

	it("prefers structured presentation data for built-in renderer calls", () => {
		const previous = toolRenderers.presentation_demo;
		const presentationRenderer: ToolRenderer = {
			presentCall: () => ({
				type: "status",
				status: { icon: "pending", title: "Presented", description: "neutral summary" },
			}),
			renderCall: () => {
				throw new Error("legacy renderCall should not run");
			},
			renderResult: () => new Text("unused", 0, 0),
		};
		toolRenderers.presentation_demo = presentationRenderer;
		try {
			const component = new ToolExecutionComponent("presentation_demo", {}, {}, undefined, uiStub);
			const rendered = renderPlain(component, 88);

			expect(rendered).toContain("Presented");
			expect(rendered).toContain("neutral summary");
			expectWidthBounded(component, 88);
		} finally {
			if (previous) {
				toolRenderers.presentation_demo = previous;
			} else {
				delete toolRenderers.presentation_demo;
			}
		}
	});
});
