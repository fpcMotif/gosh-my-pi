import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import type { KeyId } from "../../../src/config/keybindings";
import { SessionObserverOverlayComponent } from "../../../src/modes/components/session-observer-overlay";
import type { ObservableSession, SessionObserverRegistry } from "../../../src/modes/session-observer-registry";
import { initTheme } from "../../../src/modes/theme/theme";
import type { ModelChangeEntry, SessionMessageEntry } from "../../../src/session/session-manager";

const observeKeys: KeyId[] = ["ctrl+s"];

function render(component: SessionObserverOverlayComponent, width = 160): string {
	return sanitizeText(Bun.stripANSI(component.render(width).join("\n")));
}

function createRegistry(initialSessions: ObservableSession[]): {
	registry: SessionObserverRegistry;
	setSessions(sessions: ObservableSession[]): void;
} {
	let sessions = initialSessions;
	return {
		registry: fromAny<SessionObserverRegistry>({
			getSessions: () => sessions.map(session => ({ ...session })),
		}),
		setSessions(nextSessions: ObservableSession[]) {
			sessions = nextSessions;
		},
	};
}

function session(overrides: Partial<ObservableSession> & Pick<ObservableSession, "id" | "label">): ObservableSession {
	return {
		id: overrides.id,
		kind: overrides.kind ?? "subagent",
		label: overrides.label,
		status: overrides.status ?? "active",
		lastUpdate: overrides.lastUpdate ?? 1,
		...overrides,
	};
}

function messageEntry(id: string, message: unknown): SessionMessageEntry {
	return fromAny<SessionMessageEntry>({
		type: "message",
		id,
		parentId: null,
		timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
		message,
	});
}

function modelEntry(id: string, model: string): ModelChangeEntry {
	return {
		type: "model_change",
		id,
		parentId: null,
		timestamp: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
		model,
		role: "default",
	};
}

async function writeEntries(filePath: string, entries: Array<ModelChangeEntry | SessionMessageEntry>): Promise<void> {
	await Bun.write(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function createSessionFile(
	name: string,
	entries: Array<ModelChangeEntry | SessionMessageEntry>,
): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-observer-overlay-"));
	const filePath = path.join(dir, `${name}.jsonl`);
	await writeEntries(filePath, entries);
	return filePath;
}

function assistantMessage(content: unknown[], overrides: Record<string, unknown> = {}): unknown {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "openai/gpt-5.4",
		usage: { input: 10, output: 20, total: 30 },
		stopReason: "toolUse",
		timestamp: 1,
		content,
		...overrides,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): unknown {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: text === "" ? [] : [{ type: "text", text }],
		isError,
		timestamp: 2,
	};
}

describe("SessionObserverOverlayComponent", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders the most recent active subagent transcript and exposes viewer keyboard controls", async () => {
		const alphaFile = await createSessionFile("alpha", [
			messageEntry("1", { role: "user", content: "alpha prompt", timestamp: 1 }),
		]);
		const betaFile = await createSessionFile("beta", [
			modelEntry("1", "openai/gpt-test"),
			messageEntry("2", { role: "user", content: "User\trequest\nsecond user line", timestamp: 1 }),
			messageEntry("3", {
				role: "developer",
				content: [{ type: "text", text: "Developer note\nsecond developer line" }],
				timestamp: 1,
			}),
			messageEntry(
				"4",
				assistantMessage([
					{ type: "thinking", thinking: `dense reasoning ${"x".repeat(240)}\nextra thought` },
					{
						type: "text",
						text: "first response line\nsecond response line\nthird response line\nfourth response line",
					},
					{
						type: "toolCall",
						id: "bash-call",
						name: "bash",
						arguments: { command: "bun\ttest test/example.test.ts" },
						intent: "run focused tests",
					},
					{
						type: "toolCall",
						id: "search-call",
						name: "search",
						arguments: { pattern: "TODO", path: "src" },
					},
					{ type: "toolCall", id: "lsp-call", name: "lsp", arguments: { action: "definition", file: "src/a.ts" } },
					{ type: "toolCall", id: "task-call", name: "task", arguments: { tasks: [{ description: "inspect" }] } },
					{
						type: "toolCall",
						id: "generic-call",
						name: "custom_tool",
						arguments: { visible: { nested: true }, _private: "hidden" },
					},
				]),
			),
			messageEntry("5", toolResult("bash-call", "bash", "ok line 1\nok line 2\nok line 3\nok line 4\nok line 5")),
			messageEntry("6", toolResult("search-call", "search", "bad pattern\nstack line", true)),
			messageEntry("7", toolResult("lsp-call", "lsp", "")),
			messageEntry(
				"8",
				assistantMessage([], {
					stopReason: "error",
					errorMessage: "provider failed\tbadly\nretry later",
				}),
			),
		]);
		const onDone = vi.fn();
		const { registry } = createRegistry([
			session({ id: "main", kind: "main", label: "Main Session", lastUpdate: 1 }),
			session({ id: "alpha", label: "Alpha job", sessionFile: alphaFile, lastUpdate: 10 }),
			session({
				id: "beta",
				label: "Beta job",
				agent: "reviewer",
				sessionFile: betaFile,
				lastUpdate: 20,
				progress: { id: "beta", description: "Beta job", toolCount: 3, tokens: 1250, durationMs: 2300 },
			}),
		]);
		const overlay = new SessionObserverOverlayComponent(registry, onDone, observeKeys);

		const initial = render(overlay);
		expect(initial).toContain("Session Observer > Beta job");
		expect(initial).toContain("Beta job [active] reviewer (2/2) · openai/gpt-test");
		expect(initial).toContain("1.3K tokens");
		expect(initial).toContain("bun   test test/example.test.ts");
		expect(initial).toContain("pattern: TODO, path: src");
		expect(initial).toContain("definition src/a.ts");
		expect(initial).toContain("1 task(s)");
		expect(initial).toContain('visible: {"nested":true}');
		expect(initial).not.toContain("_private");
		expect(initial).toContain("provider failed   badly");

		overlay.handleInput("g");
		overlay.handleInput("\r");
		expect(render(overlay)).toContain("second user line");

		overlay.handleInput("j");
		overlay.handleInput("\r");
		expect(render(overlay)).toContain("second developer line");

		overlay.handleInput("j");
		overlay.handleInput("\r");
		expect(render(overlay)).toContain("extra thought");

		overlay.handleInput("[");
		expect(render(overlay)).toContain("Session Observer > Alpha job");

		overlay.handleInput("]");
		expect(render(overlay)).toContain("Session Observer > Beta job");

		overlay.handleInput("\x13");
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("pages through selectable transcript entries and jumps to top and bottom", async () => {
		const entries = Array.from({ length: 12 }, (_, index) =>
			messageEntry(String(index + 1), { role: "user", content: `message ${index + 1}`, timestamp: index + 1 }),
		);
		const filePath = await createSessionFile("paged", entries);
		const { registry } = createRegistry([
			session({ id: "paged", label: "Paged job", sessionFile: filePath, lastUpdate: 1 }),
		]);
		const overlay = new SessionObserverOverlayComponent(registry, vi.fn(), observeKeys);

		overlay.handleInput("g");
		expect(render(overlay)).toContain("▶ [User] message 1");

		overlay.handleInput("\x1b[6~");
		expect(render(overlay)).toContain("▶ [User] message 6");

		overlay.handleInput("\x1b[5~");
		expect(render(overlay)).toContain("▶ [User] message 1");

		overlay.handleInput("G");
		expect(render(overlay)).toContain("▶ [User] message 12");

		overlay.handleInput("k");
		expect(render(overlay)).toContain("▶ [User] message 11");

		overlay.handleInput("j");
		expect(render(overlay)).toContain("▶ [User] message 12");
	});

	it("refreshes complete transcript lines incrementally and recovers after the file is rewritten", async () => {
		const filePath = await createSessionFile("incremental", [
			messageEntry("1", { role: "user", content: "initial prompt", timestamp: 1 }),
		]);
		const { registry } = createRegistry([
			session({ id: "incremental", label: "Incremental job", sessionFile: filePath, lastUpdate: 1 }),
		]);
		const overlay = new SessionObserverOverlayComponent(registry, vi.fn(), observeKeys);
		expect(render(overlay)).toContain("initial prompt");

		const partialEntry = JSON.stringify(
			messageEntry("2", assistantMessage([{ type: "text", text: "partial response" }], { stopReason: "stop" })),
		);
		await Bun.write(filePath, `${await Bun.file(filePath).text()}${partialEntry}`);
		overlay.refreshFromRegistry();
		expect(render(overlay)).not.toContain("partial response");

		await Bun.write(filePath, `${await Bun.file(filePath).text()}\n`);
		overlay.refreshFromRegistry();
		expect(render(overlay)).toContain("partial response");

		await writeEntries(filePath, [messageEntry("3", { role: "user", content: "rewritten prompt", timestamp: 3 })]);
		overlay.refreshFromRegistry();
		const rewritten = render(overlay);
		expect(rewritten).toContain("rewritten prompt");
		expect(rewritten).not.toContain("initial prompt");
	});

	it("renders unavailable transcript states and closes immediately when there are no subagents", async () => {
		const onEmptyDone = vi.fn();
		new SessionObserverOverlayComponent(createRegistry([]).registry, onEmptyDone, observeKeys);
		await Bun.sleep(0);
		expect(onEmptyDone).toHaveBeenCalledTimes(1);

		const emptyFile = await createSessionFile("empty", []);
		const missingFile = path.join(os.tmpdir(), "missing-session-observer-file.jsonl");
		const { registry, setSessions } = createRegistry([
			session({ id: "empty", label: "Empty file", sessionFile: emptyFile, lastUpdate: 1 }),
		]);
		const overlay = new SessionObserverOverlayComponent(registry, vi.fn(), observeKeys);
		expect(render(overlay)).toContain("No messages yet.");

		setSessions([session({ id: "missing", label: "Missing file", sessionFile: missingFile, lastUpdate: 2 })]);
		overlay.refreshFromRegistry();
		expect(render(overlay)).toContain("Session no longer available.");

		const noFileOverlay = new SessionObserverOverlayComponent(
			createRegistry([session({ id: "nofile", label: "No file yet", lastUpdate: 1 })]).registry,
			vi.fn(),
			observeKeys,
		);
		expect(render(noFileOverlay)).toContain("No session file available yet.");

		const unreadableOverlay = new SessionObserverOverlayComponent(
			createRegistry([session({ id: "unreadable", label: "Unreadable", sessionFile: missingFile, lastUpdate: 1 })])
				.registry,
			vi.fn(),
			observeKeys,
		);
		expect(render(unreadableOverlay)).toContain("Unable to read session file.");
	});
});
