import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createAssistantMessage,
	createLocalAgentSessionHarness,
	type LocalAgentSessionHarness,
	MockAssistantStream,
} from "./helpers/agent-session-setup";

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for condition");
}

function textFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (
				part !== null &&
				part !== undefined &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part
			) {
				return typeof part.text === "string" ? part.text : "";
			}
			return "";
		})
		.join("");
}

function textFromAgentMessage(message: unknown): string {
	if (message === null || message === undefined || typeof message !== "object" || !("content" in message)) return "";
	return textFromMessageContent(message.content);
}

describe("AgentSession local e2e", () => {
	const harnesses: LocalAgentSessionHarness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0).reverse()) {
			await harness.cleanup();
		}
	});

	it("persists prompt lifecycle messages and emits session events", async () => {
		const harness = await createLocalAgentSessionHarness({
			streamFn: model => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("local reply", { model }),
					});
				});
				return stream;
			},
		});
		harnesses.push(harness);
		const events: AgentSessionEvent[] = [];
		harness.session.subscribe(event => events.push(event));

		await harness.session.prompt("hello local session");
		await harness.session.waitForIdle();
		await harness.sessionManager.flush();

		const messages = harness.sessionManager.getBranch().filter(entry => entry.type === "message");
		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant"]);
		expect(textFromAgentMessage(messages[0]?.message)).toContain("hello local session");
		expect(textFromAgentMessage(messages[1]?.message)).toContain("local reply");
		expect(events.some(event => event.type === "turn_start")).toBe(true);
		expect(events.some(event => event.type === "turn_end")).toBe(true);
		expect(
			events.some(
				event =>
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					textFromAgentMessage(event.message).includes("local reply"),
			),
		).toBe(true);
	});

	it("delivers follow-up queued while streaming and clears visible queue state", async () => {
		let firstStream: MockAssistantStream | undefined;
		const promptsSeen: string[] = [];
		const harness = await createLocalAgentSessionHarness({
			streamFn: (model, context) => {
				const lastMessage = context.messages.at(-1);
				promptsSeen.push(textFromMessageContent(lastMessage?.content));
				const stream = new MockAssistantStream();
				if (!firstStream) {
					firstStream = stream;
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					});
					return stream;
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("follow-up reply", { model }),
					});
				});
				return stream;
			},
		});
		harnesses.push(harness);

		const firstPrompt = harness.session.prompt("first prompt");
		await waitFor(() => harness.session.isStreaming && firstStream !== undefined);

		await harness.session.followUp("second prompt");
		expect(harness.session.queuedMessageCount).toBe(1);

		firstStream?.push({
			type: "done",
			reason: "stop",
			message: createAssistantMessage("first reply", { model: harness.model }),
		});
		await firstPrompt;
		await harness.session.waitForIdle();

		expect(promptsSeen).toEqual(["first prompt", "second prompt"]);
		expect(harness.session.queuedMessageCount).toBe(0);
		expect(harness.session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(textFromMessageContent(harness.session.getLastAssistantMessage()?.content)).toContain("follow-up reply");
	});

	it("aborts an in-flight local stream and accepts the next prompt", async () => {
		let callCount = 0;
		const harness = await createLocalAgentSessionHarness({
			streamFn: (model, _context, options) => {
				callCount += 1;
				const currentCall = callCount;
				const stream = new MockAssistantStream();
				if (currentCall === 1) {
					const emitAbort = () => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: createAssistantMessage("aborted", { model, stopReason: "aborted" }),
						});
					};
					options?.signal?.addEventListener("abort", emitAbort, { once: true });
					if (options?.signal?.aborted === true) emitAbort();
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					if (currentCall === 1) return;
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("after abort reply", { model }),
					});
				});
				return stream;
			},
		});
		harnesses.push(harness);

		const inFlight = harness.session.prompt("will abort").catch(() => undefined);
		await waitFor(() => harness.session.isStreaming);
		await harness.session.abort();
		await inFlight;

		await harness.session.prompt("after abort");
		await harness.session.waitForIdle();

		expect(callCount).toBe(2);
		expect(textFromMessageContent(harness.session.getLastAssistantMessage()?.content)).toContain("after abort reply");
	});

	it("reloads a persisted local prompt into AgentSession display context", async () => {
		const harness = await createLocalAgentSessionHarness({
			streamFn: model => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("persisted reply", { model }),
					});
				});
				return stream;
			},
		});
		harnesses.push(harness);

		await harness.session.prompt("persist me");
		await harness.session.waitForIdle();
		await harness.sessionManager.flush();
		const sessionFile = harness.sessionManager.getSessionFile();
		if (sessionFile === null || sessionFile === undefined || sessionFile === "")
			throw new Error("Expected persisted session file");

		const reopenedManager = await SessionManager.open(sessionFile, path.join(harness.tempDir.path(), "sessions"));
		const reopenedHarness = await createLocalAgentSessionHarness({
			streamFn: model => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("", { model }) });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("unused", { model }) });
				});
				return stream;
			},
			sessionManager: reopenedManager,
		});
		harnesses.push(reopenedHarness);

		const contextMessages = reopenedHarness.session.buildDisplaySessionContext().messages;
		expect(contextMessages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(textFromAgentMessage(contextMessages[0])).toContain("persist me");
		expect(textFromAgentMessage(contextMessages[1])).toContain("persisted reply");
	});
});
