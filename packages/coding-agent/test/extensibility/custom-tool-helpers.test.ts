import { describe, expect, it, vi } from "bun:test";
import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { fromAny } from "@total-typescript/shoehorn";
import { runExtensionCompact, runExtensionSetModel } from "../../src/extensibility/extensions/compact-handler";
import type { CompactOptions, ExtensionUIContext } from "../../src/extensibility/extensions/types";
import type { CustomTool, CustomToolContext } from "../../src/extensibility/custom-tools/types";
import { CustomToolAdapter } from "../../src/extensibility/custom-tools/wrapper";
import { ToolContextStore } from "../../src/tools/context";

describe("CustomToolAdapter", () => {
	it("proxies tool metadata and forwards execution context, updates, and abort signal", async () => {
		const parameters = Type.Object({ value: Type.String() });
		type Params = Static<typeof parameters>;
		interface Details {
			ok: boolean;
		}
		const defaultContext = fromAny<CustomToolContext>({ id: "default" });
		const explicitContext = fromAny<CustomToolContext>({ id: "explicit" });
		const calls: Array<{ id: string; params: Params; ctx: CustomToolContext; signal?: AbortSignal }> = [];
		const tool: CustomTool<typeof parameters, Details> = {
			name: "echo_custom",
			label: "Echo Custom",
			description: "Echoes a value",
			parameters,
			strict: true,
			execute: async (toolCallId, params, onUpdate, ctx, signal) => {
				calls.push({ id: toolCallId, params, ctx, signal });
				onUpdate?.({
					content: [{ type: "text", text: params.value }],
					details: { ok: true },
				});
				return { content: [{ type: "text", text: params.value }], details: { ok: true } };
			},
		};
		const adapter = new CustomToolAdapter(tool, () => defaultContext);
		const updates: unknown[] = [];
		const signal = new AbortController().signal;

		const result = await adapter.execute("call-1", { value: "hello" }, signal, update => updates.push(update));
		await adapter.execute("call-2", { value: "bye" }, undefined, undefined, explicitContext);

		expect(adapter.name).toBe("echo_custom");
		expect(adapter.label).toBe("Echo Custom");
		expect(adapter.description).toBe("Echoes a value");
		expect(adapter.parameters).toBe(parameters);
		expect(adapter.strict).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(updates).toHaveLength(1);
		expect(calls[0]).toMatchObject({ id: "call-1", params: { value: "hello" }, ctx: defaultContext, signal });
		expect(calls[1]).toMatchObject({ id: "call-2", params: { value: "bye" }, ctx: explicitContext });

		const wrapped = CustomToolAdapter.wrap(tool, () => defaultContext);
		expect(wrapped.name).toBe("echo_custom");
	});
});

describe("extension compact and model helpers", () => {
	it("splits compact instructions from compact options", async () => {
		const compact = vi.fn(async (_instructions?: string, _options?: CompactOptions) => undefined);
		const session = { compact };
		const options = fromAny<CompactOptions>({ strategy: "handoff" });

		await runExtensionCompact(session, "keep the summary terse");
		await runExtensionCompact(session, options);
		await runExtensionCompact(session, undefined);

		expect(compact.mock.calls).toEqual([
			["keep the summary terse", undefined],
			[undefined, options],
			[undefined, undefined],
		]);
	});

	it("sets extension-selected models only when an API key is available", async () => {
		const model = fromAny<Model>({ provider: "openai", id: "gpt-4o" });
		const setModel = vi.fn(async (_model: Model) => undefined);
		const withKey = {
			modelRegistry: { getApiKey: async (_model: Model) => "key" },
			setModel,
		};
		const withoutKey = {
			modelRegistry: { getApiKey: async (_model: Model) => "" },
			setModel,
		};

		expect(await runExtensionSetModel(withoutKey, model)).toBe(false);
		expect(await runExtensionSetModel(withKey, model)).toBe(true);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel).toHaveBeenCalledWith(model);
	});
});

describe("ToolContextStore", () => {
	it("combines base context with UI, tool names, and current tool call", () => {
		const baseContext = fromAny<CustomToolContext>({ cwd: "/repo" });
		const ui = fromAny<ExtensionUIContext>({ notify: vi.fn() });
		const toolCall = fromAny<ToolCallContext>({ id: "tool-call-1", name: "read" });
		const store = new ToolContextStore(() => baseContext);

		store.setUIContext(ui, true);
		store.setToolNames(["read", "write"]);
		const context = store.getContext(toolCall);

		expect(context.ui).toBe(ui);
		expect(context.hasUI).toBe(true);
		expect(context.toolNames).toEqual(["read", "write"]);
		expect(context.toolCall).toBe(toolCall);
	});
});
