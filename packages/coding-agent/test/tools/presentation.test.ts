import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { renderToolPresentation } from "../../src/tools/presentation";

function renderPlain(component: { render(width: number): string[] }, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("ToolPresentation", () => {
	it("adapts neutral status presentations to the legacy TUI", () => {
		const rendered = renderPlain(
			renderToolPresentation(
				{
					type: "status",
					status: { icon: "pending", title: "Read", description: "src/app.ts" },
				},
				theme,
			),
		);

		expect(rendered).toContain("Read");
		expect(rendered).toContain("src/app.ts");
	});

	it("adapts neutral block presentations to the legacy output block", () => {
		const rendered = renderPlain(
			renderToolPresentation(
				{
					type: "block",
					status: { icon: "success", title: "Bash" },
					state: "success",
					sections: [{ label: "Output", lines: ["alpha", "beta"] }],
				},
				theme,
			),
		);

		expect(rendered).toContain("Bash");
		expect(rendered).toContain("Output");
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
	});
});
