import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { dispatchRpcAuthoritativeReceiptCommand, dispatchRpcSessionStateCommand } from "./rpc-mode";
import { createLocalAgentSessionHarness } from "../../../test/helpers/agent-session-setup";

describe("authoritative RPC receipts", () => {
	test("set_model returns selected, active, thinking, and default assignment state", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const selected = getBundledModel("openai", "gpt-5");
			const response = await dispatchRpcAuthoritativeReceiptCommand(harness.session, {
				id: "default-model",
				type: "set_model",
				provider: selected.provider,
				modelId: selected.id,
				role: "default",
			});

			expect(response).toMatchObject({
				id: "default-model",
				type: "response",
				command: "set_model",
				success: true,
				data: {
					...selected,
					activeModel: selected,
					thinkingLevel: null,
					assignment: {
						role: "default",
						selector: "openai/gpt-5",
						provider: selected.provider,
						modelId: selected.id,
					},
				},
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("named-role receipt preserves the active model and exposes the exact assignment", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const active = getBundledModel("openai", "gpt-5");
			const selected = getBundledModel("openai", "gpt-4o");
			await harness.session.setModel(active);
			harness.session.settings.setModelRole("smol", "openai/previous-small:xhigh");

			const response = await dispatchRpcAuthoritativeReceiptCommand(harness.session, {
				id: "smol-model",
				type: "set_model",
				provider: selected.provider,
				modelId: selected.id,
				role: "smol",
			});

			expect(response).toMatchObject({
				id: "smol-model",
				type: "response",
				command: "set_model",
				success: true,
				data: {
					...selected,
					activeModel: active,
					thinkingLevel: null,
					assignment: {
						role: "smol",
						selector: "openai/gpt-4o:xhigh",
						provider: selected.provider,
						modelId: selected.id,
					},
				},
			});
			expect(harness.session.model).toBe(active);
		} finally {
			await harness.cleanup();
		}
	});

	test("thinking receipt reports the effective clamped or disabled level", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const reasoning = getBundledModel("openai", "gpt-5");
			await harness.session.setModel(reasoning);

			const clamped = await dispatchRpcAuthoritativeReceiptCommand(harness.session, {
				id: "clamped-thinking",
				type: "set_thinking_level",
				level: ThinkingLevel.XHigh,
			});
			expect(clamped).toEqual({
				id: "clamped-thinking",
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { thinkingLevel: ThinkingLevel.High },
			});

			await harness.session.setModel(getBundledModel("openai", "gpt-4o"));
			const disabled = await dispatchRpcAuthoritativeReceiptCommand(harness.session, {
				id: "disabled-thinking",
				type: "set_thinking_level",
				level: ThinkingLevel.High,
			});
			expect(disabled).toEqual({
				id: "disabled-thinking",
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { thinkingLevel: null },
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("new_session receipt carries the same state projection as get_state", async () => {
		const harness = await createLocalAgentSessionHarness();
		try {
			const created = await dispatchRpcAuthoritativeReceiptCommand(harness.session, {
				id: "new-session",
				type: "new_session",
			});
			const state = dispatchRpcSessionStateCommand(harness.session, { id: "get-state", type: "get_state" });

			expect(created).toMatchObject({
				id: "new-session",
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled: false },
			});
			if (!(created.success && created.command === "new_session" && created.data.cancelled === false)) {
				throw new Error("expected a successful new-session receipt");
			}
			if (!(state.success && state.command === "get_state")) {
				throw new Error("expected a state response");
			}
			expect(created.data.state).toEqual(state.data);
		} finally {
			await harness.cleanup();
		}
	});
});
