import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai/model-thinking";
import { buildRpcSessionState, type RpcSessionStateSource } from "./rpc-mode";

describe("buildRpcSessionState", () => {
	test("projects one complete backend snapshot for every state receipt", () => {
		const source = {
			model: undefined,
			thinkingLevel: Effort.High,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-42",
			sessionName: "Architecture",
			autoCompactionEnabled: true,
			messages: { length: 2 },
			queuedMessageCount: 3,
			systemPrompt: "System rules",
			todoPhases: [],
			tools: [{ name: "read", description: "Read files", parameters: { path: "string" } }],
		} satisfies RpcSessionStateSource;

		expect(buildRpcSessionState(source)).toEqual({
			model: undefined,
			thinkingLevel: Effort.High,
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-42",
			sessionName: "Architecture",
			autoCompactionEnabled: true,
			messageCount: 2,
			queuedMessageCount: 3,
			todoPhases: [],
			systemPrompt: "System rules",
			dumpTools: [{ name: "read", description: "Read files", parameters: { path: "string" } }],
		});
	});
});
