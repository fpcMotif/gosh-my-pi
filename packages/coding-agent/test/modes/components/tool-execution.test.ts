import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as imageConvert from "@oh-my-pi/pi-coding-agent/utils/image-convert";
import { toolPresenters, type ToolPresenter } from "@oh-my-pi/pi-coding-agent/tools/presenters";
import { toolRenderers, type ToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { ImageProtocol, TERMINAL, Text, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { fromPartial } from "@total-typescript/shoehorn";

const uiStub = fromPartial<TUI>({ requestRender() {} });

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;

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

afterEach(() => {
	terminal.imageProtocol = originalProtocol;
	_resetSettingsForTest();
	vi.restoreAllMocks();
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
		const previousPresenter = toolPresenters.presentation_demo;
		const presentationRenderer: ToolRenderer = {
			renderCall: () => {
				throw new Error("legacy renderCall should not run");
			},
			renderResult: () => new Text("unused", 0, 0),
		};
		const presenter: ToolPresenter = {
			presentCall: () => ({
				type: "status",
				status: { icon: "pending", title: "Presented", description: "neutral summary" },
			}),
		};
		toolRenderers.presentation_demo = presentationRenderer;
		toolPresenters.presentation_demo = presenter;
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
			if (previousPresenter) {
				toolPresenters.presentation_demo = previousPresenter;
			} else {
				delete toolPresenters.presentation_demo;
			}
		}
	});

	it("updates streamed write arguments and stops the pending spinner when args complete", async () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"write",
			{ file_path: "src/old.ts", content: "old" },
			{},
			undefined,
			fromPartial<TUI>({ requestRender }),
		);

		try {
			component.updateArgs({ file_path: "src/new.ts", content: "new\tcontent" });
			await Bun.sleep(100);
			let rendered = renderPlain(component, 88);
			expect(rendered).toContain("src/new.ts");
			expect(rendered).toContain("new   content");
			expect(requestRender).toHaveBeenCalled();

			component.setArgsComplete();
			component.setExpanded(true);
			component.setShowImages(false);
			component.invalidate();
			rendered = renderPlain(component, 88);

			expect(rendered).toContain("src/new.ts");
			expectWidthBounded(component, 88);
		} finally {
			component.stopAnimation();
		}
	});

	it("renders computed edit previews after streamed edit args settle", async () => {
		const requestRender = vi.fn();
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-execution-edit-preview-"));
		const editTool = fromPartial<AgentTool & { mode: "replace" }>({ mode: "replace" });
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const component = new ToolExecutionComponent(
				"edit",
				{ path: "", edits: [] },
				{},
				editTool,
				fromPartial<TUI>({ requestRender }),
				tmpDir,
			);

			component.updateArgs({
				path: "preview.ts",
				edits: [{ old_text: "const value = 1;", new_text: "const value = 2;" }],
				__partialJson:
					'{"path":"preview.ts","edits":[{"old_text":"const value = 1;","new_text":"const value = 2;"}]}',
			});
			await Bun.sleep(120);

			const rendered = renderPlain(component, 160);
			expect(rendered).toContain("preview.ts");
			expect(rendered).toContain("preview");
			expect(rendered).toContain("const value = 2;");
			expect(requestRender).toHaveBeenCalled();
			expectWidthBounded(component, 160);
			component.stopAnimation();
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("normalizes invalid bash timeouts out of built-in render context", () => {
		const component = new ToolExecutionComponent("bash", { command: "pwd", timeout: "soon" }, {}, undefined, uiStub);
		const rendered = renderPlain(component, 88);

		expect(rendered).toContain("pwd");
		expect(rendered).not.toContain("soon");
		expectWidthBounded(component, 88);
	});

	it("prefers structured presentation data for built-in renderer results", () => {
		const previous = toolRenderers.presentation_result_demo;
		const previousPresenter = toolPresenters.presentation_result_demo;
		const presentationRenderer: ToolRenderer = {
			renderCall: () => new Text("legacy call", 0, 0),
			renderResult: () => {
				throw new Error("legacy renderResult should not run");
			},
		};
		const presenter: ToolPresenter = {
			presentResult: () => ({
				type: "status",
				status: { icon: "success", title: "Presented Result", description: "neutral result summary" },
			}),
		};
		toolRenderers.presentation_result_demo = presentationRenderer;
		toolPresenters.presentation_result_demo = presenter;
		try {
			const component = new ToolExecutionComponent("presentation_result_demo", {}, {}, undefined, uiStub);
			component.updateResult({ content: [{ type: "text", text: "raw fallback" }] }, false);
			const rendered = renderPlain(component, 88);

			expect(rendered).toContain("legacy call");
			expect(rendered).toContain("Presented Result");
			expect(rendered).toContain("neutral result summary");
			expect(rendered).not.toContain("raw fallback");
			expectWidthBounded(component, 88);
		} finally {
			if (previous) {
				toolRenderers.presentation_result_demo = previous;
			} else {
				delete toolRenderers.presentation_result_demo;
			}
			if (previousPresenter) {
				toolPresenters.presentation_result_demo = previousPresenter;
			} else {
				delete toolPresenters.presentation_result_demo;
			}
		}
	});

	it("invalidates custom renderer components that do not provide their own invalidate hook", () => {
		const previous = toolRenderers.invalidate_demo;
		const renderCalls: number[] = [];
		toolRenderers.invalidate_demo = {
			renderCall: () =>
				fromPartial({
					render: (width: number) => {
						renderCalls.push(width);
						return ["custom renderer"];
					},
				}),
			renderResult: () => new Text("unused", 0, 0),
		};
		try {
			const component = new ToolExecutionComponent("invalidate_demo", {}, {}, undefined, uiStub);
			expect(renderPlain(component, 88)).toContain("custom renderer");

			component.invalidate();
			expect(renderPlain(component, 88)).toContain("custom renderer");
			expect(renderCalls).toEqual([86, 86]);
		} finally {
			if (previous) {
				toolRenderers.invalidate_demo = previous;
			} else {
				delete toolRenderers.invalidate_demo;
			}
		}
	});

	it("renders image fallback text when image display is disabled", () => {
		const component = new ToolExecutionComponent("demo_tool", {}, { showImages: false }, undefined, uiStub);
		component.updateResult(
			{
				content: [
					{ type: "text", text: "before image" },
					{ type: "image", data: "not-image-data", mimeType: "image/png" },
				],
			},
			false,
		);

		const rendered = renderPlain(component, 88);
		expect(rendered).toContain("before image");
		expect(rendered).toContain("[Image: [image/png]]");
		expectWidthBounded(component, 88);
	});

	it("renders image components through the terminal fallback when no image protocol renderer is active", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-execution-image-fallback-"));
		terminal.imageProtocol = null;
		await Settings.init({
			inMemory: true,
			cwd: tempDir,
			agentDir: path.join(tempDir, "agent"),
		});
		try {
			const component = new ToolExecutionComponent("demo_tool", {}, { showImages: true }, undefined, uiStub);
			component.updateResult(
				{
					content: [{ type: "image", data: "not-image-data", mimeType: "image/png" }],
				},
				false,
			);

			const rendered = renderPlain(component, 88);
			expect(rendered).toContain("[Image: [image/png]");
			expectWidthBounded(component, 88);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("sends non-PNG images through the converter before Kitty rendering", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const tinyGif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
		const convertToPng = vi.spyOn(imageConvert, "convertToPng");
		const component = new ToolExecutionComponent("demo_tool", {}, { showImages: true }, undefined, uiStub);

		component.updateResult(
			{
				content: [{ type: "image", data: tinyGif, mimeType: "image/gif" }],
			},
			false,
		);
		await Bun.sleep(50);

		expect(convertToPng).toHaveBeenCalledWith(tinyGif, "image/gif");
		expect(renderPlain(component, 88)).toContain("demo_tool");
	});

	it("keeps rendering when Kitty image conversion rejects", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const convertToPng = vi.spyOn(imageConvert, "convertToPng").mockRejectedValue(new Error("decode failed"));
		const component = new ToolExecutionComponent("demo_tool", {}, { showImages: true }, undefined, uiStub);

		component.updateResult(
			{
				content: [{ type: "image", data: "bad-image", mimeType: "image/jpeg" }],
			},
			false,
		);
		await Bun.sleep(20);

		expect(convertToPng).toHaveBeenCalledWith("bad-image", "image/jpeg");
		expect(renderPlain(component, 88)).toContain("demo_tool");
	});

	it("renders pending summaries for partial multi-file edit results", () => {
		const component = new ToolExecutionComponent(
			"edit",
			{
				edits: [{ path: "one.ts" }, { path: "two.ts" }, { path: "three.ts" }],
			},
			{},
			fromPartial<AgentTool & { mode: "replace" }>({ mode: "replace" }),
			uiStub,
		);

		component.updateResult(
			{
				content: [],
				details: {
					perFileResults: [{ path: "one.ts" }, { path: "two.ts" }],
				},
			},
			true,
		);

		const rendered = renderPlain(component, 160);
		expect(rendered).toContain("one.ts");
		expect(rendered).toContain("two.ts");
		expect(rendered).toContain("1 more file pending");
	});
});
