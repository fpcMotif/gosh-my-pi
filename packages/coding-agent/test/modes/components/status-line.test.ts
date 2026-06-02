import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { fromAny } from "@total-typescript/shoehorn";
import { _resetSettingsForTest, Settings } from "../../../src/config/settings";
import { StatusLineComponent } from "../../../src/modes/components/status-line";
import { initTheme } from "../../../src/modes/theme/theme";
import * as git from "../../../src/utils/git";

let tempRoot: string;
let originalProjectDir: string;
let originalGhPath: string | undefined;

function renderTop(component: StatusLineComponent, width = 260): string {
	return sanitizeText(Bun.stripANSI(component.getTopBorder(width).content));
}

function renderBottom(component: StatusLineComponent, width = 80): string {
	const lines = component.render(width);
	return lines.length > 0 ? sanitizeText(Bun.stripANSI(lines[0])) : "";
}

function createSession() {
	const now = Date.now();
	return fromAny({
		state: {
			model: { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000, thinking: true },
			thinkingLevel: "high",
			messages: [
				{
					role: "assistant",
					timestamp: now - 1_000,
					stopReason: "end_turn",
					usage: { input: 50_000, output: 2_000, cacheRead: 10_000, cacheWrite: 5_000, totalTokens: 67_000 },
				},
			],
		},
		isStreaming: false,
		isFastModeEnabled: vi.fn(() => true),
		modelRegistry: { isUsingOAuth: vi.fn(() => true) },
		sessionManager: {
			titleSource: "user",
			getSessionName: vi.fn(() => "Focused Session"),
			getSessionId: vi.fn(() => "session-abcdef123456"),
			getUsageStatistics: vi.fn(() => ({
				input: 12_000,
				output: 3_400,
				cacheRead: 2_000,
				cacheWrite: 600,
				premiumRequests: 1.25,
				cost: 0.42,
			})),
		},
		getAsyncJobSnapshot: vi.fn(() => ({ running: [{ id: "job-1" }, { id: "job-2" }], recent: [] })),
	});
}

async function useFakeGh(script: string): Promise<void> {
	const ghPath = path.join(tempRoot, "fake-gh");
	await Bun.write(ghPath, `#!/bin/sh\n${script}\n`);
	await fs.chmod(ghPath, 0o755);
	Bun.env.OMP_GH_PATH = ghPath;
}

function mockFeatureBranch(branchName = "feature/pr"): void {
	vi.spyOn(git.head, "resolveSync").mockReturnValue(
		fromAny({
			kind: "ref",
			branchName,
			ref: `refs/heads/${branchName}`,
			commit: "def456",
			headPath: path.join(tempRoot, ".git", "HEAD"),
		}),
	);
}

function createPrStatusLine(): StatusLineComponent {
	const component = new StatusLineComponent(createSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["git", "pr"],
		rightSegments: [],
		separator: "slash",
		showHookStatus: true,
	});
	return component;
}

async function waitForPrLookup(onBranchChange: { mock: { calls: unknown[] } }, minimumCalls = 2): Promise<void> {
	for (let i = 0; i < 100 && onBranchChange.mock.calls.length < minimumCalls; i++) {
		await Bun.sleep(10);
	}
}

async function waitForPrText(component: StatusLineComponent, text: string): Promise<string> {
	let rendered = renderTop(component);
	for (let i = 0; i < 100 && !rendered.includes(text); i++) {
		await Bun.sleep(10);
		rendered = renderTop(component);
	}
	return rendered;
}

describe("StatusLineComponent", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await initTheme(false, undefined, undefined, "dark", "light");
		originalProjectDir = getProjectDir();
		originalGhPath = Bun.env.OMP_GH_PATH;
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-"));
		setProjectDir(tempRoot);
		await Settings.init({
			inMemory: true,
			cwd: tempRoot,
			agentDir: path.join(tempRoot, "agent"),
			overrides: {
				"statusLine.preset": "custom",
				"statusLine.leftSegments": ["session_name", "model", "mode", "path", "git"],
				"statusLine.rightSegments": [
					"token_total",
					"token_rate",
					"cost",
					"context_pct",
					"context_total",
					"session",
					"time_spent",
				],
				"statusLine.separator": "slash",
				"statusLine.showHookStatus": true,
				"statusLine.segmentOptions": { path: { abbreviate: false, maxLength: 28 } },
			},
		});

		vi.spyOn(git.head, "resolveSync").mockReturnValue(
			fromAny({
				kind: "ref",
				branchName: "main",
				ref: "refs/heads/main",
				commit: "abc123",
				headPath: path.join(tempRoot, ".git", "HEAD"),
			}),
		);
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(null);
		vi.spyOn(git.status, "summary").mockResolvedValue({ staged: 1, unstaged: 2, untracked: 3 });
		vi.spyOn(git.branch, "default").mockResolvedValue("main");
	});

	afterEach(async () => {
		setProjectDir(originalProjectDir);
		if (originalGhPath === undefined) {
			delete Bun.env.OMP_GH_PATH;
		} else {
			Bun.env.OMP_GH_PATH = originalGhPath;
		}
		_resetSettingsForTest();
		await fs.rm(tempRoot, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("renders configured status segments, cached git status, and width-bounded overflow", async () => {
		const component = new StatusLineComponent(createSession());
		component.setAutoCompactEnabled(true);
		component.setSubagentCount(3);
		component.setPlanModeStatus({ enabled: true, paused: false });
		component.setLoopModeStatus({ enabled: true });
		component.setSessionStartTime(Date.now() - 65_000);

		const first = renderTop(component);
		expect(first).toContain("Focused Session");
		expect(first).toContain("Sonnet 4");
		expect(first).toContain("Plan");
		expect(first).toContain("main");
		expect(first).toContain("18K");
		expect(first).toContain("$0.42");
		expect(first).toContain("(sub)");
		expect(first).toContain("2 jobs running");

		// Cached git status resolves asynchronously; poll for it rather than racing a fixed sleep.
		let withGitStatus = "";
		for (let i = 0; i < 20 && !withGitStatus.includes("*2"); i++) {
			await Bun.sleep(5);
			withGitStatus = renderTop(component);
		}
		expect(withGitStatus).toContain("*2");
		expect(withGitStatus).toContain("+1");
		expect(withGitStatus).toContain("?3");

		const narrow = component.getTopBorder(24);
		expect(narrow.width).toBeLessThanOrEqual(24);
		expect(sanitizeText(Bun.stripANSI(narrow.content))).not.toContain("$0.42");

		component.setPlanModeStatus({ enabled: true, paused: true });
		const paused = renderTop(component);
		expect(paused).toContain("Plan");
		expect(paused).toContain("⏸");

		component.invalidate();
	});

	it("renders sorted sanitized hook statuses and respects showHookStatus", () => {
		const component = new StatusLineComponent(createSession());
		component.setHookStatus("z-last", "second\tstatus");
		component.setHookStatus("a-first", "\x1b[31mfirst\x1b[0m");

		const rendered = component.render(80);
		expect(rendered).toHaveLength(1);
		expect(renderBottom(component)).toBe("first second status");

		component.setHookStatus("a-first", undefined);
		expect(renderBottom(component)).toBe("second status");

		component.updateSettings({ showHookStatus: false });
		expect(component.render(80)).toEqual([]);
	});

	it("handles missing git repository watcher setup and closes cleanly", () => {
		const component = new StatusLineComponent(createSession());
		const onBranchChange = vi.fn();

		component.watchBranch(onBranchChange);
		component.dispose();

		expect(onBranchChange).not.toHaveBeenCalled();
	});

	it("watches the git HEAD file and notifies on changes", async () => {
		const headPath = path.join(tempRoot, ".git", "HEAD");
		await Bun.write(headPath, "ref: refs/heads/main\n");

		// Point the repo lookup at a real HEAD so #setupGitWatcher opens an fs.FSWatcher on it.
		vi.spyOn(git.repo, "resolveSync").mockReturnValue(fromAny({ headPath, branchName: "main", commit: "abc" }));

		const component = new StatusLineComponent(createSession());
		try {
			const onBranchChange = vi.fn();
			component.watchBranch(onBranchChange);

			await Bun.write(headPath, "ref: refs/heads/develop\n"); // mutate HEAD to fire the watcher
			// fs.watch dispatch is async; bounded poll instead of racing the kernel.
			for (let i = 0; i < 20 && !onBranchChange.mock.calls.length; i++) {
				await Bun.sleep(25);
			}
			expect(onBranchChange).toHaveBeenCalled();
		} finally {
			component.dispose(); // ensure the fs.FSWatcher is closed even if the assertion above throws
		}
	});

	it("looks up pull request status with an explicit gh command path", async () => {
		await useFakeGh(`printf '%s\\n' '{"number":123,"url":"https://github.com/example/repo/pull/123"}'`);
		mockFeatureBranch();
		const component = createPrStatusLine();
		const onBranchChange = vi.fn();
		component.watchBranch(onBranchChange);

		expect(renderTop(component)).toContain("feature/pr");
		const rendered = await waitForPrText(component, "#123");

		expect(onBranchChange).toHaveBeenCalled();
		expect(rendered).toContain("#123");
	});

	it("caches a missing pull request when gh exits nonzero", async () => {
		await useFakeGh("exit 7");
		mockFeatureBranch();
		const component = createPrStatusLine();
		const onBranchChange = vi.fn();
		component.watchBranch(onBranchChange);

		renderTop(component);
		await waitForPrLookup(onBranchChange);

		const rendered = renderTop(component);
		expect(onBranchChange).toHaveBeenCalled();
		expect(rendered).toContain("feature/pr");
		expect(rendered).not.toContain("#");
	});

	it("ignores malformed and non-numeric gh pull request payloads", async () => {
		await useFakeGh("printf '%s\\n' 'not-json'");
		mockFeatureBranch("feature/malformed-pr");
		const malformed = createPrStatusLine();
		const malformedChange = vi.fn();
		malformed.watchBranch(malformedChange);

		renderTop(malformed);
		await waitForPrLookup(malformedChange);
		expect(renderTop(malformed)).not.toContain("#");

		await useFakeGh(`printf '%s\\n' '{"number":"123","url":"https://github.com/example/repo/pull/123"}'`);
		mockFeatureBranch("feature/non-numeric-pr");
		const nonNumeric = createPrStatusLine();
		const nonNumericChange = vi.fn();
		nonNumeric.watchBranch(nonNumericChange);

		renderTop(nonNumeric);
		await waitForPrLookup(nonNumericChange);
		expect(renderTop(nonNumeric)).not.toContain("#");
	});
});
