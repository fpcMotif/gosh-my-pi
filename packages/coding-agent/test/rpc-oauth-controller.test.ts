import { describe, expect, it } from "bun:test";
import { RequestCorrelator } from "@oh-my-pi/pi-coding-agent/modes/rpc/request-correlator";
import { RpcOAuthController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-oauth-controller";
import type { WireFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/v1";

interface CapturedFrame {
	type: string;
	[key: string]: unknown;
}

function setup(overrides: { provider?: string; timeoutMs?: number } = {}) {
	const correlator = new RequestCorrelator();
	const frames: CapturedFrame[] = [];
	const controller = new RpcOAuthController({
		provider: overrides.provider ?? "openai-codex",
		correlator,
		output: (frame: WireFrame) => {
			frames.push(frame as CapturedFrame);
		},
		timeoutMs: overrides.timeoutMs ?? 200,
	});
	return { controller, correlator, frames };
}

describe("RpcOAuthController", () => {
	it("emits auth.show_login_url for onAuth", () => {
		const { controller, frames } = setup();
		controller.onAuth({ url: "https://chatgpt.com/auth", instructions: "Use the URL" });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "extension_ui_request",
			method: "auth.show_login_url",
			provider: "openai-codex",
			url: "https://chatgpt.com/auth",
			instructions: "Use the URL",
		});
		expect(typeof frames[0].id).toBe("string");
	});

	it("emits auth.show_progress for onProgress", () => {
		const { controller, frames } = setup();
		controller.onProgress("exchanging code");
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "extension_ui_request",
			method: "auth.show_progress",
			provider: "openai-codex",
			message: "exchanging code",
		});
	});

	it("resolves onPrompt with the response value", async () => {
		const { controller, correlator, frames } = setup();
		const promise = controller.onPrompt({ message: "Paste your key", placeholder: "sk-..." });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "extension_ui_request",
			method: "auth.prompt_code",
			provider: "openai-codex",
			placeholder: "sk-...",
		});

		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			value: "secret-key",
		});

		const result = await promise;
		expect(result).toBe("secret-key");
	});

	it("resolves onManualCodeInput with the response value", async () => {
		const { controller, correlator, frames } = setup();
		const promise = controller.onManualCodeInput();

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			method: "auth.prompt_manual_redirect",
			provider: "openai-codex",
		});

		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			value: "https://localhost:54545/callback?code=xyz",
		});

		const result = await promise;
		expect(result).toBe("https://localhost:54545/callback?code=xyz");
	});

	it("rejects onPrompt when the response is cancelled", async () => {
		const { controller, correlator, frames } = setup();
		const promise = controller.onPrompt({ message: "Paste" });

		correlator.resolve(frames[0].id as string, {
			type: "extension_ui_response",
			id: frames[0].id as string,
			cancelled: true,
		});

		await expect(promise).rejects.toThrow(/cancelled/);
	});

	it("rejects onPrompt when the response times out", async () => {
		const { controller } = setup({ timeoutMs: 25 });
		const promise = controller.onPrompt({ message: "Paste" });
		await expect(promise).rejects.toThrow(/cancelled/);
	});

	it("emits auth.show_result via emitResult", () => {
		const { controller, frames } = setup();
		controller.emitResult(true);
		controller.emitResult(false, "invalid grant");

		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({
			method: "auth.show_result",
			provider: "openai-codex",
			success: true,
		});
		expect(frames[1]).toMatchObject({
			method: "auth.show_result",
			provider: "openai-codex",
			success: false,
			error: "invalid grant",
		});
	});

	it("scopes provider per controller instance", () => {
		const a = setup({ provider: "kimi-code" });
		const b = setup({ provider: "openai-codex" });
		a.controller.onProgress("hello");
		b.controller.onProgress("world");
		expect(a.frames[0].provider).toBe("kimi-code");
		expect(b.frames[0].provider).toBe("openai-codex");
	});
});
