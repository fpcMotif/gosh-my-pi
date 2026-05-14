// Contracts for the default-on recovery-policy run bridge. Two branches:
//   - enabled: false → forwards directly to `agent.prompt` / `agent.continue`
//     (same byte-for-byte path the codebase used pre-P3).
//   - enabled: true  → routes through AgentRunController + Effect.runPromiseExit
//     and re-throws the typed `AgentRunError` instance (preserving instanceof).

import { describe, expect, it } from "bun:test";
import { type Agent, AgentBusy, AgentBusyError, type AgentMessage, ConfigInvalid } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { fromAny } from "@total-typescript/shoehorn";
import { isRecoveryPolicyEnabled, RECOVERY_POLICY_ENV_VAR, runAgentRequest } from "../src/session/run-bridge";
import type { SessionManager } from "../src/session/session-manager";

interface FakeAgentSpec {
	prompt?: (...args: unknown[]) => Promise<void>;
	continue?: () => Promise<void>;
}

function fakeAgent(spec: FakeAgentSpec = {}): { agent: Agent; calls: { name: string; args: unknown[] }[] } {
	const calls: { name: string; args: unknown[] }[] = [];
	const target = {
		async prompt(...args: unknown[]): Promise<void> {
			calls.push({ name: "prompt", args });
			if (spec.prompt) await spec.prompt(...args);
		},
		async continue(): Promise<void> {
			calls.push({ name: "continue", args: [] });
			if (spec.continue) await spec.continue();
		},
	};
	return { agent: fromAny<Agent>(target), calls };
}

function fakeSessionManager(): SessionManager {
	return fromAny<SessionManager>({
		appendRecoveryMarker: () => "marker-id",
	});
}

function withRecoveryPolicyEnv(value: string | undefined, run: () => void): void {
	const previous = process.env[RECOVERY_POLICY_ENV_VAR];
	try {
		if (value === undefined) {
			delete process.env[RECOVERY_POLICY_ENV_VAR];
		} else {
			process.env[RECOVERY_POLICY_ENV_VAR] = value;
		}
		run();
	} finally {
		if (previous === undefined) {
			delete process.env[RECOVERY_POLICY_ENV_VAR];
		} else {
			process.env[RECOVERY_POLICY_ENV_VAR] = previous;
		}
	}
}

describe("isRecoveryPolicyEnabled", () => {
	it("defaults crash recovery on when OMP_RECOVERY_POLICY is unset", () => {
		withRecoveryPolicyEnv(undefined, () => {
			expect(isRecoveryPolicyEnabled()).toBe(true);
		});
	});

	it("accepts OMP_RECOVERY_POLICY=1 as an explicit enabled value", () => {
		withRecoveryPolicyEnv("1", () => {
			expect(isRecoveryPolicyEnabled()).toBe(true);
		});
	});

	it("treats OMP_RECOVERY_POLICY=0 as the legacy direct-path escape hatch", () => {
		withRecoveryPolicyEnv("0", () => {
			expect(isRecoveryPolicyEnabled()).toBe(false);
		});
	});
});

describe("runAgentRequest (enabled: false — direct path)", () => {
	it("calls agent.prompt with string + options for prompt request", async () => {
		const { agent, calls } = fakeAgent();
		await runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "hello" }, { enabled: false });
		expect(calls.length).toBe(1);
		expect(calls[0]?.name).toBe("prompt");
		expect(calls[0]?.args[0]).toBe("hello");
	});

	it("calls the image overload when a string prompt includes image content", async () => {
		const { agent, calls } = fakeAgent();
		const images: ImageContent[] = [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } }];
		const options = { messageSource: "user" as const };

		await runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "see this", images, options }, { enabled: false });

		expect(calls).toEqual([{ name: "prompt", args: ["see this", images, options] }]);
	});

	it("passes non-string prompt input through the message overload", async () => {
		const { agent, calls } = fakeAgent();
		const message: AgentMessage = { role: "user", content: "hello", timestamp: 123 };
		const options = { messageSource: "synthetic" as const };

		await runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: message, options }, { enabled: false });

		expect(calls).toEqual([{ name: "prompt", args: [message, options] }]);
	});

	it("calls agent.continue for continue request", async () => {
		const { agent, calls } = fakeAgent();
		await runAgentRequest(agent, fakeSessionManager(), { kind: "continue" }, { enabled: false });
		expect(calls).toEqual([{ name: "continue", args: [] }]);
	});

	it("rethrows agent.prompt errors verbatim (no Effect mapping)", async () => {
		const { agent } = fakeAgent({
			prompt: async () => {
				throw new AgentBusyError();
			},
		});
		const promise = runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "x" }, { enabled: false });
		await expect(promise).rejects.toBeInstanceOf(AgentBusyError);
	});
});

describe("runAgentRequest (enabled: true — Effect path)", () => {
	it("resolves successfully when agent.prompt resolves", async () => {
		const { agent, calls } = fakeAgent();
		await runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "hello" }, { enabled: true });
		expect(calls.length).toBe(1);
		expect(calls[0]?.name).toBe("prompt");
	});

	it("resolves successfully when agent.continue resolves", async () => {
		const { agent, calls } = fakeAgent();
		await runAgentRequest(agent, fakeSessionManager(), { kind: "continue" }, { enabled: true });
		expect(calls).toEqual([{ name: "continue", args: [] }]);
	});

	it("rethrows AgentBusy verbatim (instanceof preserved through the Effect channel)", async () => {
		const { agent } = fakeAgent({
			prompt: async () => {
				throw new AgentBusyError();
			},
		});
		const promise = runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "x" }, { enabled: true });
		await expect(promise).rejects.toBeInstanceOf(AgentBusy);
	});

	it("maps a non-tagged Error to ConfigInvalid (per AgentRunController.mapToAgentRunError)", async () => {
		const { agent } = fakeAgent({
			prompt: async () => {
				throw new Error("untagged failure");
			},
		});
		try {
			await runAgentRequest(agent, fakeSessionManager(), { kind: "prompt", input: "x" }, { enabled: true });
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigInvalid);
			if (error instanceof ConfigInvalid) {
				expect(error._tag).toBe("ConfigInvalid");
				expect(error.message).toBe("untagged failure");
			}
		}
	});
});
