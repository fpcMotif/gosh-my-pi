import { describe, expect, test } from "bun:test";
import { executeRpcCommand, isRpcCommandEnvelope } from "./rpc-mode";
import type { RpcCommand, RpcResponse } from "./rpc-types";

describe("RPC command execution", () => {
	test("returns a correlated command failure when a validated handler throws", async () => {
		const command = { id: "go-call-17", type: "set_session_name", name: "build" } satisfies RpcCommand;
		const response = await executeRpcCommand(command, async () => {
			throw new Error("storage unavailable");
		});

		expect(response).toEqual({
			id: "go-call-17",
			type: "response",
			command: "set_session_name",
			success: false,
			error: "Command execution failed: storage unavailable",
		} satisfies RpcResponse);
	});

	test("passes normal command responses through unchanged", async () => {
		const command = { id: "go-call-18", type: "abort" } satisfies RpcCommand;
		const expected = { id: "go-call-18", type: "response", command: "abort", success: true } satisfies RpcResponse;

		expect(await executeRpcCommand(command, async () => expected)).toEqual(expected);
	});

	test("accepts command envelopes but rejects malformed correlation", () => {
		expect(isRpcCommandEnvelope({ id: "go-call-19", type: "get_state" })).toBe(true);
		expect(isRpcCommandEnvelope({ id: "go-call-unknown", type: "future.command" })).toBe(true);
		expect(isRpcCommandEnvelope({ id: 19, type: "get_state" })).toBe(false);
		expect(isRpcCommandEnvelope({ id: "go-call-20" })).toBe(false);
		expect(isRpcCommandEnvelope(null)).toBe(false);
	});
});
