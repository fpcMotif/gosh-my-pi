import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage, getBundledModel, type Model, type ProviderSessionState } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createAgentSession, type ExtensionFactory } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { type CompactionEntry, SessionManager } from "../src/session/session-manager";
import { type TodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "../src/tools/todo-write";

function appendCompactableTurn(sessionManager: SessionManager, model: Model, marker: string): void {
	const timestamp = Date.now();
	sessionManager.appendMessage({
		role: "user",
		content: `Request to summarize: ${marker}`,
		timestamp: timestamp - 2,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `Response to summarize: ${marker}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 1_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: timestamp - 1,
	});
	sessionManager.appendMessage({
		role: "user",
		content: `Recent request to keep: ${marker}`,
		timestamp,
	});
}

async function triggerAutoCompaction(session: Pick<AgentSession, "agent" | "subscribe">, model: Model): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "auto_compaction_end") {
			unsubscribe();
			resolve();
		}
	});
	const assistantMessage = {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop" as const,
		usage: {
			input: model.contextWindow,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: model.contextWindow,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};

	session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
	await promise;
}

async function applyCompaction(mode: "manual" | "automatic", session: AgentSession, model: Model): Promise<void> {
	if (mode === "manual") {
		await session.compact();
		return;
	}
	await triggerAutoCompaction(session, model);
}

describe("AgentSession compaction application", () => {
	it.each(["manual", "automatic"] as const)(
		"emits the exact newest compaction entry when %s summaries repeat",
		async mode => {
			const model = getBundledModel("openai", "gpt-4o-mini");
			if (!model) {
				throw new Error("Expected bundled openai/gpt-4o-mini model");
			}

			const tempDir = TempDir.createSync("@pi-compaction-application-");
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey(model.provider, "test-key");
			const sessionManager = SessionManager.inMemory();
			appendCompactableTurn(sessionManager, model, "first turn");

			const emittedCompactionIds: string[] = [];
			const extension: ExtensionFactory = pi => {
				pi.on("session_before_compact", event => ({
					compaction: {
						summary: "Repeated compaction summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				pi.on("session_compact", event => {
					emittedCompactionIds.push(event.compactionEntry.id);
				});
			};

			let session: AgentSession | undefined;
			try {
				({ session } = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					authStorage,
					model,
					sessionManager,
					settings: Settings.isolated({
						"compaction.autoContinue": false,
						"compaction.keepRecentTokens": 1,
					}),
					disableExtensionDiscovery: true,
					extensions: [extension],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				}));

				if (mode === "manual") {
					await session.compact();
				} else {
					await triggerAutoCompaction(session, model);
				}
				appendCompactableTurn(sessionManager, model, "second turn");
				if (mode === "manual") {
					await session.compact();
				} else {
					await triggerAutoCompaction(session, model);
				}

				expect(emittedCompactionIds).toHaveLength(2);
				const newestCompactionId = emittedCompactionIds[1];
				if (!newestCompactionId) {
					throw new Error("Expected newest compaction entry ID");
				}
				expect(newestCompactionId).not.toBe(emittedCompactionIds[0]);
				expect(sessionManager.getLeafId()).toBe(newestCompactionId);
			} finally {
				await session?.dispose();
				authStorage.close();
				await Bun.sleep(200);
				tempDir.removeSync();
			}
		},
	);

	it.each(["manual", "automatic"] as const)("reconciles live state before %s compaction notification", async mode => {
		const model = getBundledModel("openai-codex", "gpt-5.2-codex");
		if (!model) {
			throw new Error("Expected bundled openai-codex/gpt-5.2-codex model");
		}

		const tempDir = TempDir.createSync("@pi-compaction-application-order-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const sessionManager = SessionManager.inMemory();
		appendCompactableTurn(sessionManager, model, "ordered turn");

		const expectedTodoPhases: TodoPhase[] = [
			{
				name: "Verification",
				tasks: [{ content: "Check compaction application", status: "in_progress" }],
			},
		];
		sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: expectedTodoPhases });

		let session: AgentSession | undefined;
		let expectedFirstKeptEntryId = "";
		let expectedTokensBefore = 0;
		let compactionEntry: CompactionEntry | undefined;
		let fromExtensionAtHook = false;
		let liveMessagesAtHook: string | undefined;
		let displayMessagesAtHook: string | undefined;
		let todoPhasesAtHook: TodoPhase[] | undefined;
		let providerClosedAtHook = false;
		let leafIdAtHook: string | null = null;
		let providerCloseCalled = false;

		const extension: ExtensionFactory = pi => {
			pi.on("session_before_compact", event => {
				expectedFirstKeptEntryId = event.preparation.firstKeptEntryId;
				expectedTokensBefore = event.preparation.tokensBefore;
				return {
					compaction: {
						summary: "Accepted summary",
						shortSummary: "Accepted short summary",
						firstKeptEntryId: expectedFirstKeptEntryId,
						tokensBefore: expectedTokensBefore,
						details: { source: "test-extension" },
						preserveData: { marker: "preserved" },
					},
				};
			});
			pi.on("session_compact", event => {
				const activeSession = session;
				if (!activeSession) return;
				compactionEntry = structuredClone(event.compactionEntry);
				fromExtensionAtHook = event.fromExtension;
				liveMessagesAtHook = JSON.stringify(activeSession.messages);
				displayMessagesAtHook = JSON.stringify(activeSession.buildDisplaySessionContext().messages);
				todoPhasesAtHook = activeSession.getTodoPhases();
				providerClosedAtHook =
					providerCloseCalled && !activeSession.providerSessionState.has("openai-codex-responses");
				leafIdAtHook = sessionManager.getLeafId();
			});
		};

		try {
			({ session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				model,
				sessionManager,
				settings: Settings.isolated({
					"compaction.autoContinue": false,
					"compaction.keepRecentTokens": 1,
				}),
				disableExtensionDiscovery: true,
				extensions: [extension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}));
			session.setTodoPhases([]);
			session.providerSessionState.set("openai-codex-responses", {
				close: () => {
					providerCloseCalled = true;
				},
			} satisfies ProviderSessionState);

			await applyCompaction(mode, session, model);

			if (!compactionEntry || leafIdAtHook === null) {
				throw new Error("Expected session_compact observation");
			}
			expect(compactionEntry).toMatchObject({
				type: "compaction",
				summary: "Accepted summary",
				shortSummary: "Accepted short summary",
				firstKeptEntryId: expectedFirstKeptEntryId,
				tokensBefore: expectedTokensBefore,
				details: { source: "test-extension" },
				preserveData: { marker: "preserved" },
				fromExtension: true,
			});
			expect(fromExtensionAtHook).toBe(true);
			expect(compactionEntry.id).toBe(leafIdAtHook);
			expect(liveMessagesAtHook).toBe(displayMessagesAtHook);
			expect(todoPhasesAtHook).toEqual(expectedTodoPhases);
			expect(providerClosedAtHook).toBe(true);
		} finally {
			await session?.dispose();
			authStorage.close();
			await Bun.sleep(200);
			tempDir.removeSync();
		}
	});
});
