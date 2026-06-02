import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { fromAny } from "@total-typescript/shoehorn";
import { CommandController, renderProviderSection } from "../../../src/modes/controllers/command-controller";
import { initTheme, theme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

let tempRoot: string;
let originalProjectDir: string;

function render(container: Container, width = 160): string {
	return sanitizeText(Bun.stripANSI(container.render(width).join("\n")));
}

function createStats() {
	return {
		sessionFile: "/tmp/session.jsonl",
		sessionId: "session-1",
		userMessages: 2,
		assistantMessages: 3,
		toolCalls: 4,
		toolResults: 4,
		totalMessages: 9,
		tokens: { input: 1000, output: 500, cacheRead: 25, cacheWrite: 10, total: 1535 },
		cost: 1.2345,
		premiumRequests: 2.5,
	};
}

function createHarness() {
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const statusContainer = new Container();
	const editorContainer = new Container();
	const todoContainer = new Container();
	const pendingTools = new Map();
	const errors: string[] = [];
	const warnings: string[] = [];
	const statuses: string[] = [];
	const editor = { onEscape: undefined };
	const authStorage = {
		hasOAuth: vi.fn(() => false),
		has: vi.fn(() => false),
		hasAuth: vi.fn(() => false),
	};
	const sessionManager = {
		getUsageStatistics: vi.fn(() => ({ premiumRequests: 0 })),
		getEntries: vi.fn(() => []),
		getCwd: vi.fn(() => tempRoot),
		getSessionFile: vi.fn(() => undefined),
		getSessionName: vi.fn(() => "Session"),
		setSessionName: vi.fn(async (title: string) => title.trim().length > 0),
		flush: vi.fn(async () => {}),
		moveTo: vi.fn(async () => {}),
		titleSource: "user",
	};
	const session = {
		exportToHtml: vi.fn(async (_arg?: string) => "/tmp/session.html"),
		formatSessionAsText: vi.fn(() => ""),
		getLastAssistantText: vi.fn(() => ""),
		messages: [],
		skills: [],
		systemPrompt: "",
		getSessionStats: vi.fn(() => createStats()),
		sessionManager,
		settings: { getGroup: vi.fn(() => ({ enabled: false, strategy: "off" })) },
		fetchUsageReports: vi.fn(async () => null),
		model: undefined,
		modelRegistry: { authStorage },
		providerSessionState: undefined,
		getAsyncJobSnapshot: vi.fn(() => null),
		agent: { state: { tools: [{ name: "read", description: "Read files" }] } },
		isStreaming: false,
		executeBash: vi.fn(async (_command: string, onChunk: (chunk: string) => void) => {
			onChunk("hello\n");
			return { exitCode: 0, cancelled: false, output: "hello\n" };
		}),
		executePython: vi.fn(async (_code: string, onChunk: (chunk: string) => void) => {
			onChunk("py\n");
			return { exitCode: 0, cancelled: false, output: "py\n" };
		}),
		compact: vi.fn(async () => {}),
		abortCompaction: vi.fn(() => {}),
		isCompacting: false,
		newSession: vi.fn(async () => true),
		fork: vi.fn(async () => true),
		sessionFile: "/tmp/forked.jsonl",
		prompt: vi.fn(async () => {}),
		handoff: vi.fn(async () => ({ savedPath: "/tmp/handoff.md" })),
		refreshBaseSystemPrompt: vi.fn(async () => {}),
	};
	const ctx = fromAny<InteractiveModeContext>({
		ui: { terminal: { columns: 100 }, requestRender: vi.fn(), setFocus: vi.fn() },
		chatContainer,
		pendingMessagesContainer,
		statusContainer,
		editorContainer,
		todoContainer,
		editor,
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		session,
		sessionManager,
		settings: {
			get: vi.fn((key: string) => (key === "memories.enabled" ? false : "auto")),
			getCwd: vi.fn(() => tempRoot),
			getAgentDir: vi.fn(() => path.join(tempRoot, "agent")),
		},
		keybindings: { getAllKeybindings: vi.fn(() => []) },
		mcpManager: {
			getConnectedServers: vi.fn(() => ["fs"]),
			getConnection: vi.fn(() => ({ tools: [{ name: "read_file" }] })),
		},
		lspServers: [{ name: "tsserver", status: "ready", fileTypes: ["ts"] }],
		loadingAnimation: undefined,
		pendingTools,
		pendingBashComponents: [],
		bashComponent: undefined,
		pendingPythonComponents: [],
		pythonComponent: undefined,
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		showError: (message: string) => errors.push(message),
		showWarning: (message: string) => warnings.push(message),
		showStatus: (message: string) => statuses.push(message),
		rebuildChatFromMessages: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		refreshSessionChrome: vi.fn(),
		resetObserverRegistry: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		refreshSlashCommandState: vi.fn(async () => {}),
		flushCompactionQueue: vi.fn(async () => {}),
	});
	return {
		ctx,
		session,
		sessionManager,
		chatContainer,
		pendingMessagesContainer,
		statusContainer,
		errors,
		warnings,
		statuses,
	};
}

describe("CommandController", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		originalProjectDir = getProjectDir();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "command-controller-"));
	});

	afterEach(async () => {
		setProjectDir(originalProjectDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("handles export warnings, export errors, and debug transcript output", async () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);
		vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

		await controller.handleExportCommand("/export --copy");
		expect(harness.warnings.at(-1)).toBe("Use /dump to copy the session to clipboard.");

		harness.session.exportToHtml.mockRejectedValueOnce(new Error("disk full"));
		await controller.handleExportCommand("/export");
		expect(harness.errors.at(-1)).toBe("Failed to export session: disk full");

		harness.session.exportToHtml.mockResolvedValueOnce("/tmp/out.html");
		await controller.handleExportCommand("/export /tmp/out.html");
		expect(harness.statuses.at(-1)).toBe("Session exported to: /tmp/out.html");
		expect(controller.openInBrowser).toHaveBeenCalledWith("/tmp/out.html");

		controller.handleDumpCommand();
		expect(harness.errors.at(-1)).toBe("No messages to dump yet.");

		const emptyHarness = createHarness();
		await new CommandController(emptyHarness.ctx).handleDebugTranscriptCommand();
		expect(emptyHarness.errors.at(-1)).toBe("No messages to dump yet.");

		harness.chatContainer.addChild(new Text("line\tone", 0, 0));
		await controller.handleDebugTranscriptCommand();
		expect(harness.statuses.at(-1)).toContain("Debug transcript written to:");

		harness.session.exportToHtml.mockRejectedValueOnce(new Error("share export failed"));
		await controller.handleShareCommand();
		expect(harness.errors.at(-1)).toBe("Failed to export session: share export failed");
	});

	it("copies assistant text, code blocks, and the last executable tool command", () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);

		controller.handleCopyCommand();
		expect(harness.errors.at(-1)).toBe("No agent messages to copy yet.");

		harness.session.getLastAssistantText.mockReturnValueOnce("plain response");
		controller.handleCopyCommand("last");
		expect(harness.statuses.at(-1)).toBe("Copied last agent message to clipboard");

		harness.session.getLastAssistantText.mockReturnValueOnce("no fenced code");
		controller.handleCopyCommand("code");
		expect(harness.warnings.at(-1)).toBe("No code block found in the last agent message.");

		harness.session.getLastAssistantText.mockReturnValueOnce("```ts\nconst one = 1;\n```\n\n```sh\necho done\n```");
		controller.handleCopyCommand("code");
		expect(harness.statuses.at(-1)).toBe("Copied last code block to clipboard");

		harness.session.getLastAssistantText.mockReturnValueOnce("```ts\nconst one = 1;\n```\n\n```sh\necho done\n```");
		controller.handleCopyCommand("all");
		expect(harness.statuses.at(-1)).toBe("Copied 2 code blocks to clipboard");

		controller.handleCopyCommand("cmd");
		expect(harness.warnings.at(-1)).toBe("No bash or python command found in the conversation.");

		harness.session.messages = fromAny([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "bun check" } },
					{ type: "toolCall", name: "python", arguments: { code: "print('ok')" } },
				],
			},
		]);
		controller.handleCopyCommand("cmd");
		expect(harness.statuses.at(-1)).toBe("Copied last python code to clipboard");

		controller.handleCopyCommand("unknown");
		expect(harness.errors.at(-1)).toBe("Unknown subcommand: unknown. Use code, all, cmd, or last.");
	});

	it("renders jobs and usage reports from local session data", async () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);

		await controller.handleJobsCommand();
		expect(harness.warnings.at(-1)).toBe("Async background jobs are unavailable in this session.");

		harness.session.getAsyncJobSnapshot.mockReturnValueOnce({ running: [], recent: [] });
		await controller.handleJobsCommand();
		expect(render(harness.chatContainer)).toContain("No async jobs yet.");

		harness.session.getAsyncJobSnapshot.mockReturnValueOnce({
			running: [
				{
					id: "job-running",
					type: "task",
					status: "running",
					startTime: Date.now() - 1500,
					label: "running job with a long label that should be truncated at terminal width",
				},
			],
			recent: [
				{ id: "job-done", type: "bash", status: "completed", startTime: Date.now() - 2500, label: "done" },
				{ id: "job-cancel", type: "python", status: "cancelled", startTime: Date.now() - 3500, label: "cancelled" },
				{ id: "job-fail", type: "task", status: "failed", startTime: Date.now() - 4500, label: "failed" },
			],
		});
		await controller.handleJobsCommand();
		const jobs = render(harness.chatContainer);
		expect(jobs).toContain("Running Jobs");
		expect(jobs).toContain("job-running [task] running");
		expect(jobs).toContain("job-done [bash] completed");
		expect(jobs).toContain("job-cancel [python] cancelled");
		expect(jobs).toContain("job-fail [task] failed");

		const noUsageHarness = createHarness();
		delete fromAny<{ fetchUsageReports?: unknown }>(noUsageHarness.session).fetchUsageReports;
		await new CommandController(noUsageHarness.ctx).handleUsageCommand(null);
		expect(noUsageHarness.warnings.at(-1)).toBe("Usage reporting is not configured for this session.");

		fromAny<{ fetchUsageReports: () => Promise<UsageReport[] | null> }>(harness.session).fetchUsageReports = vi.fn(
			async () => {
				throw new Error("provider down");
			},
		);
		await controller.handleUsageCommand();
		expect(harness.errors.at(-1)).toBe("Failed to fetch usage data: provider down");

		await controller.handleUsageCommand([]);
		expect(harness.warnings.at(-1)).toBe("No usage data available.");

		const now = Date.now();
		const reports = fromAny<UsageReport[]>([
			{
				provider: "openai-codex",
				fetchedAt: now - 5000,
				metadata: { email: "a@example.com" },
				limits: [
					{
						label: "Requests",
						status: "ok",
						scope: { tier: "pro", accountId: "a", windowId: "daily" },
						amount: { usedFraction: 0.25 },
						window: { id: "daily", label: "Daily", resetsAt: now + 120000 },
						notes: ["healthy"],
					},
				],
			},
			{
				provider: "openai-codex",
				metadata: { accountId: "acct-b" },
				limits: [
					{
						label: "Tokens",
						status: "warning",
						scope: { accountId: "b", windowId: "quota" },
						amount: { unit: "percent", used: 80 },
						window: { id: "quota", label: "Quota window" },
					},
				],
			},
			{
				provider: "anthropic",
				metadata: { planType: "enterprise" },
				limits: [],
			},
		]);
		await controller.handleUsageCommand(reports);
		const usage = render(harness.chatContainer);
		expect(usage).toContain("Usage");
		expect(usage).toContain("Openai Codex");
		expect(usage).toContain("Requests (pro)");
		expect(usage).toContain("a@example.com");
		expect(usage).toContain("healthy");
		expect(usage).toContain("0.80 used (20% left)");
		expect(usage).toContain("Anthropic");
		expect(usage).toContain("account 1 (enterprise) -- no limits");
	});

	it("runs local skill, compaction, handoff, and execution command flows", async () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);
		const skillPath = path.join(tempRoot, "SKILL.md");
		await Bun.write(skillPath, "---\ndescription: Demo\n---\n# Skill body\n");

		await controller.handleSkillCommand(skillPath, "extra args");
		expect(harness.session.prompt).toHaveBeenCalledWith(expect.stringContaining("# Skill body"));
		expect(harness.session.prompt).toHaveBeenCalledWith(expect.stringContaining("User: extra args"));

		await controller.handleSkillCommand(path.join(tempRoot, "missing.md"), "");
		expect(harness.errors.at(-1)).toContain("Failed to load skill:");

		await controller.handleCompactCommand();
		expect(harness.warnings.at(-1)).toBe("Nothing to compact (no messages yet)");

		harness.sessionManager.getEntries.mockReturnValue([{ type: "message" }, { type: "message" }]);
		await controller.handleCompactCommand("keep tests");
		expect(harness.session.compact).toHaveBeenCalledWith("keep tests", undefined);
		expect(harness.ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(harness.ctx.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });

		harness.sessionManager.getEntries.mockReturnValueOnce([]);
		await controller.handleHandoffCommand();
		expect(harness.warnings.at(-1)).toBe("Nothing to hand off (no messages yet)");

		harness.sessionManager.getEntries.mockReturnValue([{ type: "message" }, { type: "message" }]);
		await controller.handleHandoffCommand("handoff note");
		expect(harness.session.handoff).toHaveBeenCalledWith("handoff note");
		expect(harness.statuses.at(-1)).toBe("Handoff document saved to: /tmp/handoff.md");

		await controller.handleBashCommand("echo hi", true);
		expect(harness.session.executeBash).toHaveBeenCalledWith("echo hi", expect.any(Function), {
			excludeFromContext: true,
		});
		expect(harness.ctx.bashComponent).toBeUndefined();

		await controller.handlePythonCommand("print('hi')");
		expect(harness.session.executePython).toHaveBeenCalledWith("print('hi')", expect.any(Function), {
			excludeFromContext: false,
		});
		expect(harness.ctx.pythonComponent).toBeUndefined();
	});

	it("handles session, context, clear/drop/fork, and rename control paths", async () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);

		controller.handleToolsCommand();
		expect(render(harness.chatContainer)).toContain("Available Tools");

		controller.handleContextCommand();
		expect(harness.warnings.at(-1)).toBe("Context usage is unavailable: no model is selected for this session.");

		await controller.handleSessionCommand();
		const sessionInfo = render(harness.chatContainer);
		expect(sessionInfo).toContain("Session Info");
		expect(sessionInfo).toContain("No model selected");
		expect(sessionInfo).toContain("tsserver: ready");
		expect(sessionInfo).toContain("fs: connected (1 tools)");

		await controller.handleClearCommand();
		expect(harness.session.newSession).toHaveBeenCalledWith(undefined);
		expect(render(harness.chatContainer)).toContain("New session started");

		await controller.handleDropCommand();
		expect(harness.errors.at(-1)).toBe("Nothing to drop (in-memory session)");

		harness.sessionManager.getSessionFile.mockReturnValueOnce("/tmp/session.jsonl");
		await controller.handleDropCommand();
		expect(harness.session.newSession).toHaveBeenCalledWith({ drop: true });

		harness.session.isStreaming = true;
		await controller.handleForkCommand();
		expect(harness.warnings.at(-1)).toBe("Wait for the current response to finish or abort it before forking.");
		harness.session.isStreaming = false;
		await controller.handleForkCommand();
		expect(render(harness.chatContainer)).toContain("Session forked to forked.jsonl");

		harness.sessionManager.setSessionName.mockResolvedValueOnce(false);
		await controller.handleRenameCommand(" ");
		expect(harness.errors.at(-1)).toBe("Session name cannot be empty.");

		harness.sessionManager.setSessionName.mockResolvedValueOnce(true);
		harness.sessionManager.getSessionName.mockReturnValueOnce("Renamed");
		await controller.handleRenameCommand("Renamed");
		expect(harness.statuses.at(-1)).toBe('Session renamed to "Renamed".');
	});

	it("renders positive context usage, memory routing, changelog output, and move outcomes", async () => {
		const harness = createHarness();
		const controller = new CommandController(harness.ctx);

		harness.session.model = fromAny({ id: "demo-model", name: "Demo Model", contextWindow: 4096 });
		harness.session.systemPrompt = "You are useful.";
		harness.session.skills = [{ name: "debug", description: "Debug failing tests" }];
		harness.session.messages = fromAny([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
		harness.session.settings.getGroup.mockReturnValue({ enabled: true, strategy: "threshold", threshold: 0.8 });
		controller.handleContextCommand();
		expect(render(harness.chatContainer)).toContain("Context Usage");
		expect(render(harness.chatContainer)).toContain("Demo Model");

		await controller.handleMemoryCommand("/memory view");
		expect(harness.warnings.at(-1)).toBe("Memory payload is empty (memories disabled or no memory summary found).");

		await controller.handleMemoryCommand("/memory nope");
		expect(harness.errors.at(-1)).toBe("Usage: /memory <view|clear|reset|enqueue|rebuild>");

		await controller.handleChangelogCommand();
		expect(render(harness.chatContainer)).toContain("Recent Changes");
		expect(render(harness.chatContainer)).toContain("/changelog full");

		await controller.handleChangelogCommand(true);
		expect(harness.ctx.ui.requestRender).toHaveBeenCalled();
		harness.chatContainer.clear();

		harness.session.isStreaming = true;
		await controller.handleMoveCommand(tempRoot);
		expect(harness.warnings.at(-1)).toBe("Wait for the current response to finish or abort it before moving.");
		harness.session.isStreaming = false;

		await controller.handleMoveCommand("");
		expect(harness.errors.at(-1)).toBe("Usage: /move <path>");

		const missingDir = path.join(tempRoot, "missing");
		await controller.handleMoveCommand(missingDir);
		expect(harness.errors.at(-1)).toBe(`Directory does not exist: ${missingDir}`);

		const filePath = path.join(tempRoot, "file.txt");
		await Bun.write(filePath, "not a directory");
		await controller.handleMoveCommand(filePath);
		expect(harness.errors.at(-1)).toBe(`Not a directory: ${filePath}`);

		const targetDir = path.join(tempRoot, "target");
		await fs.mkdir(targetDir);
		await controller.handleMoveCommand(targetDir);
		expect(harness.sessionManager.flush).toHaveBeenCalled();
		expect(harness.sessionManager.moveTo).toHaveBeenCalledWith(targetDir);
		expect(render(harness.chatContainer)).toContain("Session moved to");

		const failedDir = path.join(tempRoot, "failed");
		await fs.mkdir(failedDir);
		harness.sessionManager.moveTo.mockRejectedValueOnce(new Error("cannot move"));
		await controller.handleMoveCommand(failedDir);
		expect(harness.errors.at(-1)).toBe("Move failed: cannot move");
	});

	it("renders provider details through the exported provider-section helper", () => {
		const output = renderProviderSection({ provider: "openai", fields: [{ label: "Auth", value: "oauth" }] }, theme);
		expect(sanitizeText(Bun.stripANSI(output))).toContain("Name: openai");
		expect(sanitizeText(Bun.stripANSI(output))).toContain("Auth: oauth");
	});
});
