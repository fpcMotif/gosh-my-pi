import { describe, expect, it, spyOn } from "bun:test";
import { type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { applyRpcModelSelection, applyRpcThinkingLevel } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SessionStorageWriter, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage, createLocalAgentSessionHarness } from "./helpers/agent-session-setup";

class FailingSessionStorageWriter implements SessionStorageWriter {
	readonly #error = new Error("persistence write failed");

	async writeLine(): Promise<void> {
		throw this.#error;
	}

	async flush(): Promise<void> {}

	async fsync(): Promise<void> {}

	async close(): Promise<void> {}

	getError(): Error {
		return this.#error;
	}
}

class FailingMemorySessionStorage extends MemorySessionStorage {
	override openWriter(): SessionStorageWriter {
		return new FailingSessionStorageWriter();
	}
}

describe("AgentSession.assignModelRole", () => {
	it("latches a real writer failure before model, thinking, or branch state can change", async () => {
		const storage = new FailingMemorySessionStorage();
		const sessionManager = SessionManager.create("/workspace", "/sessions", storage);
		const userMessage = { role: "user", content: "first", timestamp: Date.now() } satisfies ai.UserMessage;
		const userEntryId = sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(createAssistantMessage("first reply"));
		await expect(sessionManager.flush()).rejects.toThrow("persistence write failed");

		const model = ai.getBundledModel("openai", "gpt-5");
		const harness = await createLocalAgentSessionHarness({ model, sessionManager });
		try {
			const branch = sessionManager.getBranch().map(entry => entry.id);
			const thinkingLevel = harness.session.thinkingLevel;

			await expect(harness.session.setModel(ai.getBundledModel("openai", "gpt-4o"))).rejects.toThrow(
				"persistence write failed",
			);
			expect(() => harness.session.setThinkingLevel(ThinkingLevel.High)).toThrow("persistence write failed");
			await expect(harness.session.branch(userEntryId)).rejects.toThrow("persistence write failed");

			expect(harness.session.model).toBe(model);
			expect(harness.session.thinkingLevel).toBe(thinkingLevel);
			expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(branch);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the RPC model receipt when prompt refresh fails after the commit", async () => {
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({}),
			strict: true,
			async execute() {
				return { content: [{ type: "text", text: "edited" }] };
			},
		};
		let rebuildCount = 0;
		const harness = await createLocalAgentSessionHarness({
			tools: [editTool],
			toolRegistry: new Map([[editTool.name, editTool]]),
			rebuildSystemPrompt: async () => {
				rebuildCount += 1;
				if (rebuildCount === 1) throw new Error("prompt rebuild failed");
				return "rebuilt";
			},
		});
		try {
			let promptSystemPrompt: string | undefined;
			const prompt = spyOn(harness.agent, "prompt").mockImplementation(async () => {
				promptSystemPrompt = harness.agent.state.systemPrompt;
			});
			try {
				const model = ai.getBundledModel("openai", "gpt-4o");
				const selection = await applyRpcModelSelection(harness.session, {
					type: "set_model",
					provider: model.provider,
					modelId: model.id,
					role: "default",
				});

				expect(selection).toMatchObject({
					ok: true,
					receipt: { activeModel: model },
				});
				expect(rebuildCount).toBe(1);
				await harness.session.sendCustomMessage(
					{
						customType: "prompt-retry-test",
						content: "retry",
						display: false,
						details: {},
						attribution: "agent",
					},
					{ triggerTurn: true },
				);
				expect(rebuildCount).toBe(2);
				expect(promptSystemPrompt).toBe("rebuilt");
			} finally {
				prompt.mockRestore();
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("retries a failed model-change prompt rebuild before manual compaction", async () => {
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({}),
			strict: true,
			async execute() {
				return { content: [{ type: "text", text: "edited" }] };
			},
		};
		let rebuildCount = 0;
		const harness = await createLocalAgentSessionHarness({
			tools: [editTool],
			toolRegistry: new Map([[editTool.name, editTool]]),
			rebuildSystemPrompt: async () => {
				rebuildCount += 1;
				if (rebuildCount === 1) throw new Error("prompt rebuild failed");
				return "rebuilt compact system prompt";
			},
		});
		let promptDuringCompaction: string | undefined;
		const completeSimple = spyOn(ai, "completeSimple").mockImplementation(async model => {
			promptDuringCompaction = harness.agent.state.systemPrompt;
			return createAssistantMessage("local compact summary", { model }) as never;
		});
		try {
			harness.session.settings.override("compaction.keepRecentTokens", 1);
			harness.session.settings.override("compaction.remoteEnabled", false);
			harness.sessionManager.appendMessage({
				role: "user",
				content: "first request",
				timestamp: Date.now() - 2,
			});
			const assistant = createAssistantMessage("first reply", { model: harness.model });
			assistant.usage = {
				input: 120_000,
				output: 2_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 122_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			harness.sessionManager.appendMessage(assistant);
			harness.sessionManager.appendMessage({ role: "user", content: "latest request", timestamp: Date.now() });

			const model = ai.getBundledModel("openai", "gpt-4o");
			await harness.session.setModel(model);
			expect(rebuildCount).toBe(1);

			await expect(harness.session.compact()).resolves.toMatchObject({ summary: "local compact summary" });
			expect(rebuildCount).toBe(2);
			expect(harness.agent.state.systemPrompt).toBe("rebuilt compact system prompt");
			expect(promptDuringCompaction).toBe("rebuilt compact system prompt");
		} finally {
			completeSimple.mockRestore();
			await harness.cleanup();
		}
	});

	it("stores a role model without changing the active model", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const smol = ai.getBundledModel("openai", "gpt-4o");
			harness.session.settings.setModelRole("smol", "openai/previous-small:xhigh");

			await harness.session.assignModelRole(smol, "smol");

			expect(harness.session.model).toBe(harness.model);
			expect(harness.session.settings.getModelRole("smol")).toBe("openai/gpt-4o:xhigh");
		} finally {
			await harness.cleanup();
		}
	});

	it("returns backend-clamped model and thinking receipts", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const nonReasoning = ai.getBundledModel("openai", "gpt-4o");
			const selection = await applyRpcModelSelection(harness.session, {
				type: "set_model",
				provider: nonReasoning.provider,
				modelId: nonReasoning.id,
				role: "default",
			});

			expect(selection).toMatchObject({
				ok: true,
				receipt: {
					provider: nonReasoning.provider,
					id: nonReasoning.id,
					activeModel: nonReasoning,
					thinkingLevel: null,
					assignment: {
						role: "default",
						selector: "openai/gpt-4o",
						provider: nonReasoning.provider,
						modelId: nonReasoning.id,
					},
				},
			});
			expect(applyRpcThinkingLevel(harness.session, ThinkingLevel.High)).toEqual({ thinkingLevel: null });
		} finally {
			await harness.cleanup();
		}
	});

	it("reports the model's maximum effective thinking level", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const gpt5 = ai.getBundledModel("openai", "gpt-5");
			await applyRpcModelSelection(harness.session, {
				type: "set_model",
				provider: gpt5.provider,
				modelId: gpt5.id,
				role: "default",
			});

			expect(applyRpcThinkingLevel(harness.session, ThinkingLevel.XHigh)).toEqual({
				thinkingLevel: ThinkingLevel.High,
			});
			expect(harness.session.thinkingLevel).toBe(ThinkingLevel.High);
		} finally {
			await harness.cleanup();
		}
	});
});
