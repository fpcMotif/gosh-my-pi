import { describe, expect, test } from "bun:test";
import { RpcInboundRouter, type RpcCommandEnvelope } from "./rpc-ingress";

async function* lines(...values: string[]): AsyncIterable<Uint8Array> {
	for (const value of values) {
		yield new TextEncoder().encode(value);
	}
}

describe("RpcInboundRouter", () => {
	test("discards startup commands when stdin closes before activation", async () => {
		const commands: string[] = [];
		const router = new RpcInboundRouter({
			input: lines('{"id":"state","type":"get_state"}'),
			onCommand: async command => {
				commands.push(command.type);
			},
			onExtensionUIResponse: () => {},
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onParseError: () => {},
			onQueueFull: () => {},
			onEnd: () => {},
		});

		router.start();
		await router.complete;
		router.activate();
		await Bun.sleep(0);
		expect(commands).toEqual([]);
	});

	test("routes startup dialog replies while commands wait, then runs commands FIFO", async () => {
		const releaseEnd = Promise.withResolvers<void>();
		const responseIds: string[] = [];
		const commands: string[] = [];
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		const input = (async function* (): AsyncIterable<Uint8Array> {
			yield new TextEncoder().encode('{"type":"extension_ui_response","id":"startup-dialog","confirmed":true}');
			yield new TextEncoder().encode('{"id":"state","type":"get_state"}');
			yield new TextEncoder().encode('{"id":"models","type":"models.catalog"}');
			await releaseEnd.promise;
		})();
		const router = new RpcInboundRouter({
			input,
			onCommand: async command => {
				commands.push(command.type);
				commandStarted.resolve();
				await releaseCommand.promise;
			},
			onExtensionUIResponse: response => responseIds.push(response.id),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onParseError: () => {},
			onQueueFull: () => {},
			onEnd: () => {},
		});

		router.start();
		await Bun.sleep(0);
		expect(responseIds).toEqual(["startup-dialog"]);
		expect(commands).toEqual([]);

		router.activate();
		await commandStarted.promise;
		expect(commands).toEqual(["get_state"]);
		releaseCommand.resolve();
		await Bun.sleep(0);
		expect(commands).toEqual(["get_state", "models.catalog"]);
		releaseEnd.resolve();
		await router.finished;
	});

	test("bounds queued commands but keeps control replies live and cancels on EOF", async () => {
		const queueFull: RpcCommandEnvelope[] = [];
		const responseIds: string[] = [];
		const hostResults: string[] = [];
		const hostUpdates: string[] = [];
		let ended = 0;
		const router = new RpcInboundRouter({
			input: lines(
				'{"id":"one","type":"get_state"}',
				'{"id":"two","type":"get_messages"}',
				'{"id":"three","type":"models.catalog"}',
				'{"type":"extension_ui_response","id":"dialog","cancelled":true}',
				'{"type":"host_tool_update","id":"tool-update","partialResult":{"content":[]}}',
				'{"type":"host_tool_result","id":"tool-result","result":{"content":[]}}',
			),
			commandCapacity: 2,
			onCommand: async () => {},
			onExtensionUIResponse: response => responseIds.push(response.id),
			onHostToolResult: result => hostResults.push(result.id),
			onHostToolUpdate: update => hostUpdates.push(update.id),
			onParseError: () => {},
			onQueueFull: command => queueFull.push(command),
			onEnd: () => {
				ended += 1;
			},
		});

		router.start();
		await router.finished;
		expect(queueFull).toEqual([{ id: "three", type: "models.catalog" }]);
		expect(responseIds).toEqual(["dialog"]);
		expect(hostUpdates).toEqual(["tool-update"]);
		expect(hostResults).toEqual(["tool-result"]);
		expect(ended).toBe(1);
		expect(router.closed).toBe(true);
	});

	test("keeps only the in-flight command when stdin closes during execution", async () => {
		const releaseEnd = Promise.withResolvers<void>();
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		const commands: string[] = [];
		const input = (async function* (): AsyncIterable<Uint8Array> {
			yield new TextEncoder().encode('{"id":"first","type":"get_state"}');
			yield new TextEncoder().encode('{"id":"second","type":"get_messages"}');
			await releaseEnd.promise;
		})();
		const router = new RpcInboundRouter({
			input,
			onCommand: async command => {
				commands.push(command.type);
				commandStarted.resolve();
				await releaseCommand.promise;
			},
			onExtensionUIResponse: () => {},
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onParseError: () => {},
			onQueueFull: () => {},
			onEnd: () => {},
		});

		router.start();
		router.activate();
		await commandStarted.promise;
		releaseEnd.resolve();
		await router.finished;
		releaseCommand.resolve();
		await router.complete;
		expect(commands).toEqual(["get_state"]);
	});
});
