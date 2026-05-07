/**
 * Contract tests for `resolveAuthLoginProvider` — the empty-provider
 * picker choreography for `auth.login` (ADR 0002).
 *
 * The bug class these tests catch is _wire contract drift_, not
 * function-level bugs: each side of the wire passed its own tests
 * before this lived; what failed was the agreement between them. So
 * the assertions here probe the wire shape (the
 * `auth.pick_provider` extension_ui_request frame) and the typed
 * error responses on cancel / empty / malformed reply, rather than
 * any internal state.
 */

import { describe, expect, test } from "bun:test";
import { RequestCorrelator } from "./request-correlator";
import { resolveAuthLoginProvider } from "./rpc-mode";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types";
import type { WireFrame } from "./wire/v1";

type Sink = {
	frames: WireFrame[];
	output: (frame: WireFrame) => void;
};

function newSink(): Sink {
	const frames: WireFrame[] = [];
	return { frames, output: f => frames.push(f) };
}

describe("resolveAuthLoginProvider", () => {
	test("non-empty provider passes through unchanged — no picker emit", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const result = await resolveAuthLoginProvider("openai-codex", correlator, sink.output, () => {
			throw new Error("listAvailable must not be called when provider is supplied");
		});
		expect(result).toEqual({ ok: true, provider: "openai-codex" });
		expect(sink.frames).toHaveLength(0);
		expect(correlator.pendingCount).toBe(0);
	});

	test("empty provider + reply with picked id resolves to that id", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => ["openai-codex", "kimi-code"]);

		// One picker frame should land on the wire.
		await Promise.resolve();
		expect(sink.frames).toHaveLength(1);
		const frame = sink.frames[0] as RpcExtensionUIRequest & { method: "auth.pick_provider" };
		expect(frame.type).toBe("extension_ui_request");
		expect(frame.method).toBe("auth.pick_provider");
		expect(frame.options).toEqual(["openai-codex", "kimi-code"]);
		expect(frame.defaultId).toBe("openai-codex");

		// Reply with the picked id.
		const reply: RpcExtensionUIResponse = { type: "extension_ui_response", id: frame.id, value: "kimi-code" };
		correlator.resolve(frame.id, reply);

		expect(await promise).toEqual({ ok: true, provider: "kimi-code" });
		expect(correlator.pendingCount).toBe(0);
	});

	test("undefined provider behaves the same as empty string", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider(undefined, correlator, sink.output, () => ["zai"]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest & { method: "auth.pick_provider" };
		correlator.resolve(frame.id, { type: "extension_ui_response", id: frame.id, value: "zai" });
		expect(await promise).toEqual({ ok: true, provider: "zai" });
	});

	test("empty provider + zero available providers returns typed error", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const result = await resolveAuthLoginProvider("", correlator, sink.output, () => []);
		expect(result).toEqual({ ok: false, error: "no providers available" });
		expect(sink.frames).toHaveLength(0);
	});

	test("empty provider + cancelled picker returns auth.login cancelled error", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => ["openai-codex"]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest;
		correlator.resolve(frame.id, { type: "extension_ui_response", id: frame.id, cancelled: true });
		expect(await promise).toEqual({ ok: false, error: "auth.login cancelled" });
	});

	test("empty provider + correlator-undefined reply returns auth.login cancelled", async () => {
		// This branch fires when the host never replies and the correlator
		// resolves with `defaultValue: undefined` (e.g. shutdown / abort path).
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => ["openai-codex"]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest;
		correlator.resolve(frame.id, undefined);
		expect(await promise).toEqual({ ok: false, error: "auth.login cancelled" });
	});

	test("empty provider + reply with empty value string returns invalid response error", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => ["openai-codex"]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest;
		correlator.resolve(frame.id, { type: "extension_ui_response", id: frame.id, value: "" });
		expect(await promise).toEqual({ ok: false, error: "auth.login picker returned invalid response" });
	});

	test("empty provider + reply missing value/cancelled returns invalid response error", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => ["openai-codex"]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest;
		// Bogus reply — neither `value` nor `cancelled`.
		correlator.resolve(frame.id, { type: "extension_ui_response", id: frame.id } as RpcExtensionUIResponse);
		expect(await promise).toEqual({ ok: false, error: "auth.login picker returned invalid response" });
	});

	test("picker frame defaultId is the first option even when many are listed", async () => {
		const correlator = new RequestCorrelator();
		const sink = newSink();
		const promise = resolveAuthLoginProvider("", correlator, sink.output, () => [
			"openai-codex",
			"kimi-code",
			"zai",
			"kagi",
		]);
		await Promise.resolve();
		const frame = sink.frames[0] as RpcExtensionUIRequest & { method: "auth.pick_provider" };
		expect(frame.defaultId).toBe("openai-codex");
		expect(frame.options).toHaveLength(4);
		correlator.resolve(frame.id, { type: "extension_ui_response", id: frame.id, value: "zai" });
		await promise;
	});
});
