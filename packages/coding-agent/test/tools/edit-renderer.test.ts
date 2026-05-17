import { describe, expect, it } from "bun:test";
import { editToolPresenter, editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("editToolRenderer", () => {
	it("exposes neutral presentation data for edit call summaries", () => {
		const presentation = editToolPresenter.presentCall(
			{
				path: "packages/coding-agent/src/edit/renderer.ts",
				newText: "after",
			},
			{ expanded: false, isPartial: true, renderContext: { editMode: "replace" } },
		);

		expect(presentation?.type).toBe("block");
		if (presentation?.type !== "block") return;
		expect(presentation.status?.title).toBe("Edit");
		expect(presentation.status?.description).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(presentation.sections[0].lines.join("\n")).toContain("after");
	});

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

	it("renders multi-file call summaries and apply_patch parse errors", async () => {
		const uiTheme = await getUiTheme();
		const multiFile = editToolRenderer.renderCall(
			{
				edits: [
					{ path: "src/one.ts", new_text: "one" },
					{ path: "src/two.ts", new_text: "two" },
				],
			},
			{ expanded: false, isPartial: true, renderContext: { editMode: "replace" } },
			uiTheme,
		);
		const malformedPatch = editToolRenderer.renderCall(
			{ input: "*** Update File: src/bad.ts\n@@\n+missing begin" },
			{ expanded: false, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);

		const multiFileRendered = Bun.stripANSI(multiFile.render(160).join("\n"));
		const malformedRendered = Bun.stripANSI(malformedPatch.render(160).join("\n"));
		expect(multiFileRendered).toContain("src/one.ts");
		expect(multiFileRendered).toContain("(+1 more)");
		expect(malformedRendered).toContain("The first line of the patch must be");
	});

	it("renders every call preview source with the expected label", async () => {
		await getUiTheme();
		const errorPreview = editToolPresenter.presentCall(
			{ path: "src/error.ts" },
			{
				expanded: false,
				isPartial: true,
				renderContext: { editMode: "replace", editDiffPreview: { error: "bad\tpreview" } },
			},
		);
		const computedPreview = editToolPresenter.presentCall(
			{ path: "src/computed.ts", previewDiff: "+computed" },
			{ expanded: false, isPartial: true, renderContext: { editMode: "replace" } },
		);
		const contextPreview = editToolPresenter.presentCall(
			{ path: "src/context.ts" },
			{
				expanded: false,
				isPartial: true,
				renderContext: { editMode: "replace", editDiffPreview: { path: "src/context.ts", diff: "+context" } },
			},
		);
		const streamingPatch = editToolPresenter.presentCall(
			{ path: "src/stream.ts", op: "update", diff: "+streamed" },
			{ expanded: false, isPartial: true, renderContext: { editMode: "patch" } },
		);
		const plainDiff = editToolPresenter.presentCall(
			{ path: "src/plain.ts", diff: "+plain" },
			{ expanded: false, isPartial: true, renderContext: { editMode: "patch" } },
		);

		expect(errorPreview?.type).toBe("block");
		expect(computedPreview?.type).toBe("block");
		expect(contextPreview?.type).toBe("block");
		expect(streamingPatch?.type).toBe("block");
		expect(plainDiff?.type).toBe("block");
		if (
			errorPreview?.type !== "block" ||
			computedPreview?.type !== "block" ||
			contextPreview?.type !== "block" ||
			streamingPatch?.type !== "block" ||
			plainDiff?.type !== "block"
		)
			return;
		expect(errorPreview.sections[0].lines.join("\n")).toContain("bad   preview");
		expect(computedPreview.sections[0].lines.join("\n")).toContain("(preview)");
		expect(contextPreview.sections[0].lines.join("\n")).toContain("+context");
		expect(streamingPatch.sections[0].lines.join("\n")).toContain("(streaming)");
		expect(plainDiff.sections[0].lines.join("\n")).toContain("+plain");
	});

	it("keeps neutral call presentations bounded for renames and long previews", async () => {
		await getUiTheme();
		const longPreview = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
		const presentation = editToolPresenter.presentCall(
			{ path: "src/old.ts", rename: "src/new.ts", previewDiff: longPreview },
			{ expanded: false, isPartial: true, renderContext: { editMode: "patch" } },
		);

		expect(presentation?.type).toBe("block");
		if (presentation?.type !== "block") return;
		expect(presentation.status.description).toContain("src/old.ts");
		expect(presentation.status.description).toContain("src/new.ts");
		expect(presentation.sections[0].lines.join("\n")).toContain("2 more lines");
	});

	it("includes computed first changed line in call descriptions", async () => {
		const uiTheme = await getUiTheme();
		const presentation = editToolPresenter.presentCall(
			{ path: "src/call-line.ts" },
			{
				expanded: false,
				isPartial: true,
				renderContext: {
					editMode: "replace",
					editDiffPreview: { path: "src/call-line.ts", diff: "+changed", firstChangedLine: 12 },
				},
			},
		);
		const component = editToolRenderer.renderCall(
			{ path: "src/call-line.ts" },
			{
				expanded: false,
				isPartial: true,
				renderContext: {
					editMode: "replace",
					editDiffPreview: { path: "src/call-line.ts", diff: "+changed", firstChangedLine: 12 },
				},
			},
			uiTheme,
		);

		expect(presentation?.type).toBe("block");
		if (presentation?.type !== "block") return;
		expect(presentation.status.description).toContain("src/call-line.ts:12");
		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("src/call-line.ts:12");
	});

	it("returns status-only neutral presentations when no preview text is available", async () => {
		await getUiTheme();
		const presentation = editToolPresenter.presentCall(
			{ path: "src/status-only.ts" },
			{ expanded: false, isPartial: true, renderContext: { editMode: "replace" } },
		);

		expect(presentation).toEqual({
			type: "status",
			status: {
				icon: "pending",
				spinnerFrame: undefined,
				title: "Edit",
				description: "src/status-only.ts",
			},
		});
	});

	it("delegates vim call and result rendering through the edit renderer", async () => {
		const uiTheme = await getUiTheme();
		const callComponent = editToolRenderer.renderCall(
			{ file: "src/vim.ts", steps: [{ kbd: ["g", "g"] }] },
			{ expanded: false, isPartial: true, renderContext: { editMode: "vim" } },
			uiTheme,
		);
		const resultComponent = editToolRenderer.renderResult(
			{ content: [{ type: "text", text: "closed vim buffer" }] },
			{ expanded: false, isPartial: false, renderContext: { editMode: "vim" } },
			uiTheme,
		);

		expect(
			editToolPresenter.presentCall({ file: "src/vim.ts" }, { expanded: false, isPartial: true }),
		).toBeUndefined();
		expect(Bun.stripANSI(callComponent.render(160).join("\n"))).toContain("g g");
		expect(Bun.stripANSI(resultComponent.render(160).join("\n"))).toContain("closed vim buffer");
	});

	it("renders ordinary edit results without structured details", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{ content: [{ type: "text", text: "plain result" }] },
			{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{ path: "src/plain-result.ts" },
		);

		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("src/plain-result.ts");
	});

	it("renders rename, first changed line, diagnostics, and diff previews for single-file results", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					diff: "",
					op: "move",
					move: "src/new.ts",
					firstChangedLine: 7,
					diagnostics: {
						messages: ["src/old.ts:7:1 [error] expected semicolon (semi)"],
						summary: "1 error(s)",
						errored: true,
					},
				},
			},
			{
				expanded: true,
				isPartial: false,
				renderContext: {
					editMode: "patch",
					editDiffPreview: { path: "src/old.ts", diff: "+preview", firstChangedLine: 9 },
					renderDiff: text => `rendered:${text}`,
				},
			},
			uiTheme,
			{ path: "src/old.ts", oldText: "before", newText: "after" },
		);

		const first = Bun.stripANSI(component.render(160).join("\n"));
		const cached = Bun.stripANSI(component.render(160).join("\n"));
		component.invalidate();
		const rebuilt = Bun.stripANSI(component.render(160).join("\n"));

		expect(first).toContain("src/old.ts:9");
		expect(first).toContain("src/new.ts");
		expect(first).toContain("rendered:+preview");
		expect(first).toContain("1 error(s)");
		expect(cached).toBe(first);
		expect(rebuilt).toBe(first);
	});

	it("renders result preview errors when no committed diff is available", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: { diff: "", op: "update" },
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: { editMode: "replace", editDiffPreview: { path: "src/error.ts", error: "preview failed" } },
			},
			uiTheme,
			{ path: "src/error.ts", oldText: "before", newText: "after" },
		);

		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("preview failed");
	});

	it("omits empty diff previews from successful result bodies", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: { diff: "", op: "update" },
			},
			{
				expanded: false,
				isPartial: false,
				renderContext: { editMode: "replace", editDiffPreview: { path: "src/empty.ts", diff: "" } },
			},
			uiTheme,
			{ path: "src/empty.ts", oldText: "before", newText: "after" },
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("src/empty.ts");
		expect(rendered).not.toContain("(preview)");
	});

	it("renders multi-file result bodies and pending-file summaries", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					diff: "",
					perFileResults: [
						{ path: "src/one.ts", diff: "+one", op: "update" },
						{ path: "src/two.ts", diff: "", op: "update", isError: true, errorText: "failed\tfile" },
					],
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
			{
				edits: [{ path: "src/one.ts" }, { path: "src/two.ts" }, { path: "src/three.ts" }],
			},
		);

		const first = Bun.stripANSI(component.render(160).join("\n"));
		const cached = Bun.stripANSI(component.render(160).join("\n"));
		component.invalidate();
		const rebuilt = Bun.stripANSI(component.render(160).join("\n"));

		expect(first).toContain("src/one.ts");
		expect(first).toContain("src/two.ts");
		expect(first).toContain("failed   file");
		expect(first).toContain("1 more file pending");
		expect(cached).toBe(first);
		expect(rebuilt).toBe(first);
	});
});
