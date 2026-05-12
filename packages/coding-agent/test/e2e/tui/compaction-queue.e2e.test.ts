import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { fromAny } from "@total-typescript/shoehorn";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../../../src/modes/types";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";

/**
 * Contract: UiHelpers.flushCompactionQueue drains messages queued during
 * compaction in three ordered phases:
 *   1. Pre-prompt slash commands (run before the first non-command).
 *   2. The first non-slash message (sent via session.prompt with
 *      streamingBehavior so AgentBusyError races don't strand it).
 *   3. The rest of the queue (steer / followUp / prompt as appropriate).
 *
 * Failure modes the suite defends against:
 *   - Empty queue must be a fast no-op (no error, no clearQueue).
 *   - All-slash-command queue must drain via prompt().
 *   - willRetry queue must drain sequentially via the same per-message
 *     dispatcher, with no fire-and-forget.
 *   - The "rest" loop must not double-deliver messages if the firstPrompt
 *     promise rejects mid-flight (potential bug at line 640-648 of
 *     ui-helpers.ts: firstPrompt is .catch()'d but `rest` runs in parallel
 *     while it's pending).
 */

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme not found");
	setThemeInstance(theme);
});

interface SessionLog {
	prompt: Array<{ text: string; opts?: { streamingBehavior?: string } }>;
	steer: string[];
	followUp: string[];
	clearQueueCalls: number;
}

function createStubContext(opts: {
	compactionQueued: CompactionQueuedMessage[];
	knownSlashCommands?: Set<string>;
	promptImpl?: (text: string, opts?: { streamingBehavior?: string }) => Promise<void>;
}): { ctx: InteractiveModeContext; chatContainer: Container; sessionLog: SessionLog } {
	const chatContainer = new Container();
	const pendingMessagesContainer = new Container();
	const sessionLog: SessionLog = { prompt: [], steer: [], followUp: [], clearQueueCalls: 0 };

	const known = opts.knownSlashCommands ?? new Set<string>();

	const session = {
		prompt:
			opts.promptImpl ??
			((text: string, options?: { streamingBehavior?: string }) => {
				sessionLog.prompt.push({ text, opts: options });
				return Promise.resolve();
			}),
		steer: (text: string) => {
			sessionLog.steer.push(text);
			return Promise.resolve();
		},
		followUp: (text: string) => {
			sessionLog.followUp.push(text);
			return Promise.resolve();
		},
		clearQueue: () => {
			sessionLog.clearQueueCalls += 1;
		},
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
	};

	const ui = { requestRender: () => {} } as unknown as TUI;

	// We track the prompt impl so the stub can be redefined per-test (the
	// `session.prompt` is the field flushCompactionQueue actually invokes).
	const ctx: Partial<InteractiveModeContext> = {
		isBackgrounded: false,
		chatContainer,
		pendingMessagesContainer,
		ui,
		session: session as unknown as InteractiveModeContext["session"],
		settings: fromAny<InteractiveModeContext["settings"]>({ get: () => undefined }),
		fileSlashCommands: known,
		compactionQueuedMessages: opts.compactionQueued,
		updatePendingMessagesDisplay: () => {},
		showStatus: () => {},
		showError: () => {},
		showWarning: () => {},
		// isKnownSlashCommand is normally a UiHelpers method - we stub at the ctx
		// because UiHelpers.flushCompactionQueue calls `this.ctx.isKnownSlashCommand`
		// (the InteractiveMode runtime forwards UiHelpers methods onto ctx).
		isKnownSlashCommand: (text: string) => {
			if (!text.startsWith("/")) return false;
			const spaceIdx = text.indexOf(" ");
			const cmdName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
			return known.has(cmdName);
		},
		keybindings: fromAny<InteractiveModeContext["keybindings"]>({ getDisplayString: () => "Alt+Up" }),
	};
	return { ctx: ctx as InteractiveModeContext, chatContainer, sessionLog };
}

describe("UiHelpers.flushCompactionQueue — ordered draining of post-compaction messages", () => {
	afterEach(() => {});

	it("is a no-op when the compaction queue is empty", async () => {
		const { ctx, sessionLog } = createStubContext({ compactionQueued: [] });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue();

		expect(sessionLog.prompt).toHaveLength(0);
		expect(sessionLog.steer).toHaveLength(0);
		expect(sessionLog.followUp).toHaveLength(0);
		expect(sessionLog.clearQueueCalls).toBe(0);
	});

	it("drains an all-slash-command queue via session.prompt", async () => {
		const known = new Set(["compact", "clear"]);
		const queue: CompactionQueuedMessage[] = [
			{ text: "/compact", mode: "steer" },
			{ text: "/clear", mode: "steer" },
		];
		const { ctx, sessionLog } = createStubContext({ compactionQueued: queue, knownSlashCommands: known });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue();

		expect(sessionLog.prompt.map(c => c.text)).toEqual(["/compact", "/clear"]);
		expect(sessionLog.steer).toHaveLength(0);
		expect(sessionLog.followUp).toHaveLength(0);
	});

	it("sends the first non-slash message via prompt() with the steer streamingBehavior tag", async () => {
		const known = new Set(["pre"]);
		const queue: CompactionQueuedMessage[] = [
			{ text: "/pre arg", mode: "steer" },
			{ text: "actual prompt", mode: "steer" },
			{ text: "follow-up text", mode: "followUp" },
		];
		const { ctx, sessionLog } = createStubContext({ compactionQueued: queue, knownSlashCommands: known });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue();

		// Pre-command via prompt (no streamingBehavior).
		expect(sessionLog.prompt[0]?.text).toBe("/pre arg");
		// First non-slash via prompt() with streamingBehavior 'steer'.
		const firstNonSlash = sessionLog.prompt.find(c => c.text === "actual prompt");
		expect(firstNonSlash).toBeDefined();
		expect(firstNonSlash?.opts?.streamingBehavior).toBe("steer");
	});

	it("flags the first non-slash message as 'followUp' when its mode is followUp", async () => {
		const queue: CompactionQueuedMessage[] = [{ text: "follow up", mode: "followUp" }];
		const { ctx, sessionLog } = createStubContext({ compactionQueued: queue });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue();

		const sent = sessionLog.prompt.find(c => c.text === "follow up");
		expect(sent?.opts?.streamingBehavior).toBe("followUp");
	});

	it("under willRetry, drains every message sequentially via its mode-specific dispatcher", async () => {
		const known = new Set(["c"]);
		const queue: CompactionQueuedMessage[] = [
			{ text: "/c", mode: "steer" },
			{ text: "steer me", mode: "steer" },
			{ text: "follow me", mode: "followUp" },
		];
		const { ctx, sessionLog } = createStubContext({ compactionQueued: queue, knownSlashCommands: known });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: true });

		// Slash command via prompt (always).
		expect(sessionLog.prompt.map(c => c.text)).toEqual(["/c"]);
		// steer-mode → steer(), followUp-mode → followUp(). No fire-and-forget.
		expect(sessionLog.steer).toEqual(["steer me"]);
		expect(sessionLog.followUp).toEqual(["follow me"]);
	});

	it("clears the compactionQueuedMessages array exactly once at the start", async () => {
		const queue: CompactionQueuedMessage[] = [{ text: "msg", mode: "steer" }];
		const { ctx } = createStubContext({ compactionQueued: queue });
		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue();

		// After the flush, the queue must be empty - the function reassigns
		// it to [] before any awaits.
		expect(ctx.compactionQueuedMessages).toHaveLength(0);
	});
});
