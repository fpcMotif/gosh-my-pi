import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { fromAny } from "@total-typescript/shoehorn";
import * as bashExecutor from "../../src/exec/bash-executor";
import type { BashExecutorOptions, BashResult } from "../../src/exec/bash-executor";
import * as pythonExecutor from "../../src/ipy/executor";
import type { PythonResult } from "../../src/ipy/executor";
import { BashController, type BashControllerContext } from "../../src/session/bash-controller";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../src/session/messages";
import { PythonController, type PythonControllerContext } from "../../src/session/python-controller";

function bashResult(overrides: Partial<BashResult> = {}): BashResult {
	return {
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: 2,
		outputLines: 1,
		outputBytes: 2,
		...overrides,
	};
}

function pythonResult(overrides: Partial<PythonResult> = {}): PythonResult {
	return {
		output: "py-ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		totalLines: 1,
		totalBytes: 5,
		outputLines: 1,
		outputBytes: 5,
		displayOutputs: [],
		stdinRequested: false,
		...overrides,
	};
}

function createBashController(
	streaming: () => boolean,
	extensionRunner: BashControllerContext["extensionRunner"] = undefined,
	options: { saveArtifact?: BashControllerContext["sessionManager"]["saveArtifact"] } = {},
) {
	const agentMessages: AgentMessage[] = [];
	const sessionMessages: BashExecutionMessage[] = [];
	const ctx: BashControllerContext = {
		sessionId: "session-1",
		agent: {
			appendMessage: entry => {
				agentMessages.push(entry);
			},
		},
		sessionManager: {
			getCwd: () => "/tmp",
			saveArtifact: options.saveArtifact ?? vi.fn(async () => "artifact-1"),
			appendMessage: entry => {
				sessionMessages.push(entry);
				return `stored-${sessionMessages.length}`;
			},
		},
		isStreaming: streaming,
		extensionRunner,
	};
	return { agentMessages, controller: new BashController(ctx), sessionMessages };
}

function createPythonController(
	streaming: () => boolean,
	extensionRunner: PythonControllerContext["extensionRunner"] = undefined,
) {
	const agentMessages: AgentMessage[] = [];
	const sessionMessages: PythonExecutionMessage[] = [];
	const ctx: PythonControllerContext = {
		kernelOwnerId: "kernel-owner-1",
		agent: {
			appendMessage: entry => {
				agentMessages.push(entry);
			},
		},
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionFile: () => null,
			appendMessage: entry => {
				sessionMessages.push(entry);
				return `stored-${sessionMessages.length}`;
			},
		},
		settings: fromAny({ get: () => undefined }),
		isStreaming: streaming,
		extensionRunner,
	};
	return { agentMessages, controller: new PythonController(ctx), sessionMessages };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BashController", () => {
	it("records idle results immediately and defers streaming results until flush", () => {
		let streaming = false;
		const { agentMessages, controller, sessionMessages } = createBashController(() => streaming);

		controller.recordResult("printf ok", bashResult(), { excludeFromContext: true });
		expect(agentMessages).toHaveLength(1);
		expect(sessionMessages).toHaveLength(1);
		expect(sessionMessages[0]).toMatchObject({
			role: "bashExecution",
			command: "printf ok",
			output: "ok",
			exitCode: 0,
			excludeFromContext: true,
		});
		expect(controller.hasPending).toBe(false);

		streaming = true;
		controller.recordResult("printf later", bashResult({ output: "later" }));
		expect(controller.hasPending).toBe(true);
		expect(agentMessages).toHaveLength(1);
		expect(sessionMessages).toHaveLength(1);

		controller.flushPending();
		expect(controller.hasPending).toBe(false);
		expect(sessionMessages.map(entry => entry.command)).toEqual(["printf ok", "printf later"]);
		expect(agentMessages.map(entry => entry.role)).toEqual(["bashExecution", "bashExecution"]);
	});

	it("uses a user_bash extension result without spawning the shell executor", async () => {
		const hookResult = bashResult({ output: "hooked" });
		const emitUserBash = vi.fn(async () => ({ result: hookResult }));
		const extensionRunner = fromAny<BashControllerContext["extensionRunner"]>({
			hasHandlers: (name: string) => name === "user_bash",
			emitUserBash,
		});
		const { controller, sessionMessages } = createBashController(() => false, extensionRunner);

		await expect(controller.execute("printf hooked", undefined, { excludeFromContext: true })).resolves.toBe(
			hookResult,
		);

		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "printf hooked",
			excludeFromContext: true,
			cwd: "/tmp",
		});
		expect(sessionMessages[0]).toMatchObject({
			role: "bashExecution",
			command: "printf hooked",
			output: "hooked",
			excludeFromContext: true,
		});
	});

	it("falls through to shell execution when the user_bash hook does not return a result", async () => {
		const result = bashResult({ output: "fallback" });
		const started = Promise.withResolvers<BashExecutorOptions>();
		const release = Promise.withResolvers<BashResult>();
		const onChunk = vi.fn();
		const saveArtifact = vi
			.fn(async () => "artifact-1")
			.mockRejectedValueOnce(new Error("artifact store unavailable"))
			.mockResolvedValueOnce("artifact-2");
		const emitUserBash = vi.fn(async () => ({}));
		const executeBash = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			started.resolve(options ?? {});
			expect(
				await options?.onMinimizedSave?.("first original", { filter: "head", inputBytes: 10, outputBytes: 4 }),
			).toBeUndefined();
			expect(
				await options?.onMinimizedSave?.("second original", { filter: "head", inputBytes: 10, outputBytes: 4 }),
			).toBe("artifact-2");
			await release.promise;
			return result;
		});
		const extensionRunner = fromAny<BashControllerContext["extensionRunner"]>({
			hasHandlers: (name: string) => name === "user_bash",
			emitUserBash,
		});
		const { controller, sessionMessages } = createBashController(() => false, extensionRunner, { saveArtifact });

		const execution = controller.execute("printf fallback", onChunk);
		const options = await started.promise;
		expect(controller.isRunning).toBe(true);
		controller.abort();
		expect(options.signal?.aborted).toBe(true);
		release.resolve(result);

		await expect(execution).resolves.toBe(result);
		expect(executeBash).toHaveBeenCalledWith(
			"printf fallback",
			expect.objectContaining({
				onChunk,
				sessionKey: "session-1",
				timeout: expect.any(Number),
			}),
		);
		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "printf fallback",
			excludeFromContext: false,
			cwd: "/tmp",
		});
		expect(saveArtifact).toHaveBeenCalledTimes(2);
		expect(sessionMessages[0]).toMatchObject({
			role: "bashExecution",
			command: "printf fallback",
			output: "fallback",
		});
		expect(controller.isRunning).toBe(false);
	});
});

describe("PythonController", () => {
	it("records results through the shared queue and blocks execution after disposal starts", () => {
		let streaming = true;
		const { agentMessages, controller, sessionMessages } = createPythonController(() => streaming);

		controller.recordResult("print('queued')", pythonResult(), { excludeFromContext: true });
		expect(controller.hasPending).toBe(true);
		expect(agentMessages).toEqual([]);
		expect(sessionMessages).toEqual([]);

		streaming = false;
		controller.flushPending();
		expect(sessionMessages[0]).toMatchObject({
			role: "pythonExecution",
			code: "print('queued')",
			output: "py-ok",
			exitCode: 0,
			excludeFromContext: true,
		});

		controller.markDisposing();
		expect(() => controller.assertAllowed()).toThrow("Python execution is unavailable");
	});

	it("tracks external Python executions so dispose can await and abort them", async () => {
		const { controller } = createPythonController(() => false);
		const abortController = new AbortController();
		const release = Promise.withResolvers<void>();

		const tracked = controller.track(release.promise, abortController);
		expect(controller.isRunning).toBe(true);
		controller.abort();
		expect(abortController.signal.aborted).toBe(true);

		const disposeReady = controller.prepareForDispose();
		release.resolve();
		await tracked;
		expect(await disposeReady).toBe(true);
		expect(controller.isRunning).toBe(false);
	});

	it("tracks user_python extension execution and records its result", async () => {
		const release = Promise.withResolvers<void>();
		const hookResult = pythonResult({ output: "py-hooked" });
		const emitUserPython = vi.fn(async () => {
			await release.promise;
			return { result: hookResult };
		});
		const extensionRunner = fromAny<PythonControllerContext["extensionRunner"]>({
			hasHandlers: (name: string) => name === "user_python",
			emitUserPython,
		});
		const { controller, sessionMessages } = createPythonController(() => false, extensionRunner);

		const execution = controller.execute("print('hooked')", undefined, { excludeFromContext: true });
		expect(controller.isRunning).toBe(true);
		release.resolve();

		await expect(execution).resolves.toBe(hookResult);
		expect(emitUserPython).toHaveBeenCalledWith({
			type: "user_python",
			code: "print('hooked')",
			excludeFromContext: true,
			cwd: "/tmp",
		});
		expect(sessionMessages[0]).toMatchObject({
			role: "pythonExecution",
			code: "print('hooked')",
			output: "py-hooked",
			excludeFromContext: true,
		});
		expect(controller.isRunning).toBe(false);
	});

	it("detaches retained kernel ownership during disposal", async () => {
		const disposeKernelSessionsByOwner = vi
			.spyOn(pythonExecutor, "disposeKernelSessionsByOwner")
			.mockResolvedValue(undefined);
		const { controller } = createPythonController(() => false);

		await controller.disposeKernel();

		expect(disposeKernelSessionsByOwner).toHaveBeenCalledWith("kernel-owner-1");
	});
});
