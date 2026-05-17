import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { InternalUrlRouter, type InternalResource, type InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	BashTool,
	bashToolPresenter,
	bashToolRenderer,
	formatBashCommand,
	getBashEnvForDisplay,
} from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool, readToolPresenter, readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ImageProtocol, TERMINAL, type Component, visibleWidth } from "@oh-my-pi/pi-tui";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;

let artifactCounter = 0;

function createToolSession(
	cwd: string,
	settings: Settings = Settings.isolated(),
	overrides: Partial<ToolSession> = {},
): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(sessionDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
		...overrides,
	};
}

function textOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map(content => content.text)
			.join("\n") ?? ""
	);
}

function renderPlain(component: Component, width: number): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function expectWidthBounded(component: Component, width: number): void {
	for (const line of component.render(width)) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

function createInternalRouter(content: string): InternalUrlRouter {
	const router = new InternalUrlRouter();
	for (const scheme of ["agent", "skill"]) {
		router.register({
			scheme,
			resolve: async (url: InternalUrl): Promise<InternalResource> => ({
				url: url.toString(),
				content,
				contentType: "text/plain",
				sourcePath: `${scheme}://source`,
			}),
		});
	}
	return router;
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
});

afterEach(() => {
	terminal.imageProtocol = originalProtocol;
	vi.restoreAllMocks();
});

describe("bash presentation and minimizer artifacts", () => {
	it("recovers streaming env args from partial JSON and shell-escapes the preview", () => {
		const env = getBashEnvForDisplay({
			command: "printf ok",
			env: { MERGED: "complete" },
			__partialJson:
				'{"env":{"QUOTE":"a\\"b","BACKSLASH":"a\\\\b","SLASH":"a\\/b","BACKSPACE":"a\\b","FORM":"a\\f","NEWLINE":"a\\nb","RETURN":"a\\rb","TAB":"a\\tb","UNICODE":"\\u0041","BAD_UNICODE":"\\u12zz","DEFAULT":"a\\qb","DOLLAR":"$value","MERGED":"partial"}}',
		});

		expect(env).toEqual({
			QUOTE: 'a"b',
			BACKSLASH: "a\\b",
			SLASH: "a/b",
			BACKSPACE: "a\b",
			FORM: "a\f",
			NEWLINE: "a\nb",
			RETURN: "a\rb",
			TAB: "a\tb",
			UNICODE: "A",
			BAD_UNICODE: "\\u12zz",
			DEFAULT: "aqb",
			DOLLAR: "$value",
			MERGED: "complete",
		});

		const command = formatBashCommand({ command: "printf\tok", cwd: "src", env });
		expect(command).toContain("cd src &&");
		expect(command).toContain('DOLLAR="\\$value"');
		expect(command).toContain('NEWLINE="a\\nb"');
		expect(command).toContain('QUOTE="a\\"b"');
		expect(command).toContain("printf   ok");

		const presentation = bashToolPresenter.presentCall?.(
			{ command: "printf ok", __partialJson: '{"env":{"STREAMED":"value"}}' },
			{ expanded: false, isPartial: true },
		);
		expect(presentation).toEqual({
			type: "status",
			status: { icon: "pending", title: "Bash", description: '$ STREAMED="value" printf ok' },
		});
	});

	it("persists lossless minimizer originals when the executor asks for an artifact", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-original-artifact-"));
		try {
			const originalPath = path.join(tempDir, "original.log");
			vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
				const originalId = await options?.onMinimizedSave?.("raw\toriginal", {
					filter: "demo",
					inputBytes: 12,
					outputBytes: 4,
				});
				return {
					output: `minimized ${originalId}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 20,
					outputLines: 1,
					outputBytes: 20,
				};
			});
			const tool = new BashTool(
				createToolSession(tempDir, Settings.isolated(), {
					allocateOutputArtifact: async (toolType: string) => {
						if (toolType === "bash-original") return { id: "raw-original", path: originalPath };
						return { id: "exec-output", path: path.join(tempDir, "exec.log") };
					},
				}),
			);

			const result = await tool.execute("bash-minimized", { command: "demo" });

			expect(textOutput(result)).toContain("minimized raw-original");
			expect(await Bun.file(originalPath).text()).toBe("raw\toriginal");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps bash execution successful when original artifact allocation is unavailable", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-original-unavailable-"));
		try {
			vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
				const originalId = await options?.onMinimizedSave?.("raw original", {
					filter: "demo",
					inputBytes: 12,
					outputBytes: 4,
				});
				return {
					output: `minimized ${originalId ?? "without-original"}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 20,
					outputLines: 1,
					outputBytes: 20,
				};
			});

			for (const allocateOriginal of [
				async () => ({ id: "", path: "" }),
				async () => {
					throw new Error("disk unavailable");
				},
			]) {
				const tool = new BashTool(
					createToolSession(tempDir, Settings.isolated(), {
						allocateOutputArtifact: async (toolType: string) => {
							if (toolType === "bash-original") return await allocateOriginal();
							return { id: "exec-output", path: path.join(tempDir, "exec.log") };
						},
					}),
				);

				const result = await tool.execute("bash-minimized-fallback", { command: "demo" });
				expect(textOutput(result)).toContain("minimized without-original");
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("persists lossless minimizer originals from explicit async jobs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-async-original-artifact-"));
		const asyncJobManager = new AsyncJobManager({ onJobComplete: async () => {} });
		try {
			const originalPath = path.join(tempDir, "async-original.log");
			vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
				const originalId = await options?.onMinimizedSave?.("async raw\toriginal", {
					filter: "demo",
					inputBytes: 18,
					outputBytes: 5,
				});
				return {
					output: `async minimized ${originalId}`,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					totalLines: 1,
					totalBytes: 30,
					outputLines: 1,
					outputBytes: 30,
				};
			});
			const tool = new BashTool(
				createToolSession(tempDir, Settings.isolated({ "async.enabled": true }), {
					asyncJobManager,
					getSessionId: () => "async-original-session",
					allocateOutputArtifact: async (toolType: string) => {
						if (toolType === "bash-original") return { id: "async-raw-original", path: originalPath };
						return { id: "exec-output", path: path.join(tempDir, "exec.log") };
					},
				}),
			);

			const result = await tool.execute("bash-async-minimized", { command: "demo", async: true });
			const jobId = result.details?.async?.jobId;
			if (jobId === null || jobId === undefined || jobId === "") {
				throw new Error("expected async job id");
			}
			await asyncJobManager.getJob(jobId)?.promise;

			expect(await Bun.file(originalPath).text()).toBe("async raw\toriginal");
		} finally {
			await asyncJobManager.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("renders legacy bash call and result components with timeout, truncation, cache, and sixel handling", () => {
		const call = bashToolRenderer.renderCall({ command: "pwd", cwd: "." }, { expanded: false }, theme);
		expect(renderPlain(call, 88)).toContain("$ pwd");

		const collapsed = bashToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
				details: {
					timeoutSeconds: 3,
					requestedTimeoutSeconds: 7200,
					meta: {
						truncation: {
							direction: "tail",
							truncatedBy: "lines",
							totalLines: 9,
							totalBytes: 100,
							outputLines: 4,
							outputBytes: 18,
							shownRange: { start: 6, end: 9 },
							artifactId: "full-bash",
						},
					},
				},
			},
			{ expanded: false, renderContext: { previewLines: 2 } },
			theme,
			{ command: "printf demo" },
		);
		const collapsedText = renderPlain(collapsed, 88);
		expect(collapsedText).toContain("showing 2 of 4");
		expect(collapsedText).toContain("Timeout: 3s (requested 7200s clamped)");
		expect(collapsedText).toContain("Read artifact://full-bash for full output");
		expectWidthBounded(collapsed, 88);

		const expanded = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "from result" }], details: { timeoutSeconds: 2 } },
			{ expanded: false, renderContext: { expanded: true, output: "from context", isFullOutput: true } },
			theme,
			{ command: "printf context" },
		);
		expect(renderPlain(expanded, 88)).toContain("from context");
		expanded.invalidate?.();
		expect(renderPlain(expanded, 88)).toContain("from context");

		terminal.imageProtocol = ImageProtocol.Sixel;
		const sixel = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "\u001bPqimage\u001b\\\nplain\tline" }] },
			{ expanded: true },
			theme,
			{ command: "imgcat" },
		);
		const sixelRaw = sixel.render(120).join("\n");
		expect(sixelRaw).toContain("\u001bPqimage\u001b\\");
		const sixelText = Bun.stripANSI(sixelRaw);
		expect(sixelText).toContain("plain   line");
	});
});

describe("read presentation and directory execution", () => {
	it("reports read intent and line-number display mode from settings", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-line-number-contract-"));
		try {
			await Bun.write(path.join(tempDir, "numbered.txt"), "alpha\nbeta");
			const tool = new ReadTool(
				createToolSession(
					tempDir,
					Settings.isolated({
						"edit.mode": "replace",
						readLineNumbers: true,
					}),
				),
			);

			expect(tool.intent({})).toBe("Reading");
			expect(tool.intent({ path: "notes.txt" })).toBe("Reading notes.txt");
			expect(tool.intent({ path: "https://example.test/page" })).toBe("Fetching https://example.test/page");

			const result = await tool.execute("read-numbered", { path: path.join(tempDir, "numbered.txt") });
			expect(textOutput(result)).toContain("1|alpha");
			expect(textOutput(result)).toContain("2|beta");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reads internal resources with pagination and rejects extraction plus pagination", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-internal-resource-"));
		try {
			const tool = new ReadTool(
				createToolSession(
					tempDir,
					Settings.isolated({
						"edit.mode": "replace",
						readLineNumbers: true,
					}),
					{ internalRouter: createInternalRouter("one\ntwo\nthree") },
				),
			);

			const paged = await tool.execute("read-internal-paged", { path: "agent://result", sel: "2+1" });
			expect(textOutput(paged)).toContain("2|two");
			expect(textOutput(paged)).toContain("1 more lines in resource");
			expect(paged.details?.resolvedPath).toBe("agent://source");

			const extracted = await tool.execute("read-internal-extracted", { path: "agent://result/summary" });
			expect(textOutput(extracted)).toBe("one\ntwo\nthree");

			const skill = await tool.execute("read-skill-resource", { path: "skill://demo" });
			expect(textOutput(skill)).toContain("three");

			expect(tool.execute("read-internal-invalid", { path: "agent://result/summary", sel: "1+1" })).rejects.toThrow(
				"Cannot combine query extraction with offset/limit",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("presents read calls, text results, image results, and URL fallbacks", () => {
		expect(readToolPresenter.presentCall?.({ path: "https://example.test" }, { expanded: false })).toBeUndefined();

		const call = readToolPresenter.presentCall?.(
			{ file_path: "/tmp/demo.ts", offset: 2, limit: 3 },
			{ expanded: false },
		);
		expect(call).toEqual({
			type: "status",
			status: { icon: "pending", title: "Read", description: "/tmp/demo.ts:2-4" },
		});

		const textResult = readToolPresenter.presentResult?.(
			{
				content: [{ type: "text", text: "1|const value = 1;" }],
				details: {
					resolvedPath: "/private/tmp/demo.ts",
					displayContent: { text: "const value = 1;", startLine: 1 },
					meta: {
						truncation: {
							direction: "head",
							truncatedBy: "lines",
							totalLines: 10,
							totalBytes: 100,
							outputLines: 1,
							outputBytes: 16,
							shownRange: { start: 1, end: 1 },
							nextOffset: 2,
						},
					},
				},
			},
			{ expanded: true },
			{ path: "/tmp/demo.ts" },
		);
		expect(textResult?.type).toBe("code");
		if (textResult?.type === "code") {
			expect(textResult.code.output).toContain("Resolved path: /private/tmp/demo.ts");
			expect(textResult.code.output).toContain("Use sel=2 to continue");
		}

		const imageResult = readToolPresenter.presentResult?.(
			{
				content: [
					{ type: "text", text: "Image metadata:\n- MIME: image/png" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				details: { suffixResolution: { from: "wrong.png", to: "actual.png" } },
			},
			{ expanded: false },
			{ path: "wrong.png" },
		);
		expect(imageResult?.type).toBe("block");
		if (imageResult?.type === "block") {
			expect(imageResult.status.description).toContain("actual.png");
			expect(imageResult.sections[0]?.lines).toContain("- MIME: image/png");
		}

		const urlCall = readToolRenderer.renderCall({ path: "https://example.test" }, { expanded: false }, theme);
		expect(renderPlain(urlCall, 88)).toContain("example.test");

		const urlResult = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "remote body" }],
				details: {
					kind: "url",
					url: "https://example.test",
					finalUrl: "https://example.test/final",
					contentType: "text/plain",
					method: "GET",
					notes: [],
				},
			},
			{ expanded: false },
			theme,
			{ path: "https://example.test" },
		);
		expect(renderPlain(urlResult, 88)).toContain("remote body");
	});

	it("renders legacy read text and image results with cache invalidation", () => {
		const textComponent = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "1|const value = 1;" }],
				details: {
					resolvedPath: "/private/tmp/demo.ts",
					displayContent: { text: "const value = 1;", startLine: 1 },
					meta: {
						truncation: {
							direction: "head",
							truncatedBy: "lines",
							totalLines: 10,
							totalBytes: 100,
							outputLines: 1,
							outputBytes: 16,
							shownRange: { start: 1, end: 1 },
							nextOffset: 2,
						},
					},
				},
			},
			{ expanded: false },
			theme,
			{ file_path: "/tmp/demo.ts", offset: 1, limit: 1 },
		);
		expect(renderPlain(textComponent, 120)).toContain("const value = 1;");
		expect(renderPlain(textComponent, 120)).toContain("Resolved path: /private/tmp/demo.ts");
		textComponent.invalidate?.();
		expect(renderPlain(textComponent, 120)).toContain("Use sel=2 to continue");

		const imageComponent = readToolRenderer.renderResult(
			{
				content: [
					{ type: "text", text: "Image metadata:" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				details: { suffixResolution: { from: "wrong.png", to: "actual.png" } },
			},
			{ expanded: false },
			theme,
			{ path: "wrong.png" },
		);
		const imageText = renderPlain(imageComponent, 88);
		expect(imageText).toContain("actual.png");
		expect(imageText).toContain("Image metadata:");
		imageComponent.invalidate?.();
		expect(renderPlain(imageComponent, 88)).toContain("actual.png");
	});

	it("reads directory entries with native suffix markers and skips entries that cannot be statted", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-directory-contract-"));
		try {
			await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
			await fs.mkdir(path.join(tempDir, "nested"));
			await fs.symlink(path.join(tempDir, "missing-target"), path.join(tempDir, "broken-link"));

			const tool = new ReadTool(createToolSession(tempDir));
			const result = await tool.execute("read-directory", { path: tempDir });
			const output = textOutput(result);

			expect(result.details?.isDirectory).toBe(true);
			expect(output).toContain("alpha.txt");
			expect(output).toContain("nested/");
			expect(output).not.toContain("broken-link");

			const emptyDir = path.join(tempDir, "empty");
			await fs.mkdir(emptyDir);
			const emptyResult = await tool.execute("read-empty-directory", { path: emptyDir });
			expect(textOutput(emptyResult)).toBe("(empty directory)");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves unique suffix matches and exposes the correction in read output", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-suffix-resolution-"));
		try {
			await fs.mkdir(path.join(tempDir, "notes", "deep"), { recursive: true });
			await Bun.write(path.join(tempDir, "notes", "deep", "target.md"), "suffix match\n");
			const tool = new ReadTool(createToolSession(tempDir));

			const result = await tool.execute("read-suffix-match", { path: "deep/target.md" });
			const output = textOutput(result);

			expect(output).toContain("[Path 'deep/target.md' not found; resolved to 'notes/deep/target.md'");
			expect(output).toContain("suffix match");
			expect(result.details?.suffixResolution).toEqual({
				from: "deep/target.md",
				to: "notes/deep/target.md",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
