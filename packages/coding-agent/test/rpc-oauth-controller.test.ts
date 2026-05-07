import { describe, expect, it } from "bun:test";
import { RequestCorrelator } from "@oh-my-pi/pi-coding-agent/modes/rpc/request-correlator";
import { RpcOAuthController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-oauth-controller";
import { AuthMethod, type AuthRequestPayload } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
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
		controller.emitResult(true, undefined, ["openai-codex", "kimi-code"]);
		controller.emitResult(false, "invalid grant");

		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({
			method: "auth.show_result",
			provider: "openai-codex",
			success: true,
			providers: ["openai-codex", "kimi-code"],
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

/**
 * Contract test for the auth.* wire vocabulary. The runtime assertions count
 * methods and confirm each is reachable; the load-bearing checks are at compile
 * time via `// @ts-expect-error`. Together they enforce that `AuthMethod` and
 * `AuthRequestPayload` stay in lock-step. A drift fails this file at type-check.
 *
 * Pair-locked with `gmp_workspace_auth_test.go::TestAuthDecoderParity` on the
 * Go side. Deleting either test makes the seam bypassable.
 */
describe("AuthRequestPayload type contract", () => {
	it("AuthMethod constants are 1:1 with AuthRequestPayload methods", () => {
		const methods = Object.values(AuthMethod);
		// Six wire methods today: show_login_url, show_progress, prompt_code,
		// prompt_manual_redirect, show_result, pick_provider.
		expect(methods).toHaveLength(6);
		for (const m of methods) expect(m).toMatch(/^auth\./);
	});

	it("show_login_url requires provider + url, instructions optional", () => {
		const valid: AuthRequestPayload = {
			method: AuthMethod.ShowLoginURL,
			provider: "openai-codex",
			url: "https://example.com",
			instructions: "Open this URL",
		};
		expect(valid.method).toBe(AuthMethod.ShowLoginURL);

		// @ts-expect-error - missing required `url` for show_login_url
		const missingUrl: AuthRequestPayload = { method: AuthMethod.ShowLoginURL, provider: "openai-codex" };
		expect(missingUrl.method).toBe(AuthMethod.ShowLoginURL);
	});

	it("show_progress requires provider + message", () => {
		const valid: AuthRequestPayload = {
			method: AuthMethod.ShowProgress,
			provider: "openai-codex",
			message: "exchanging",
		};
		expect(valid.method).toBe(AuthMethod.ShowProgress);

		// @ts-expect-error - missing required `message` for show_progress
		const missingMessage: AuthRequestPayload = { method: AuthMethod.ShowProgress, provider: "openai-codex" };
		expect(missingMessage.method).toBe(AuthMethod.ShowProgress);
	});

	it("prompt_code requires provider; placeholder + allowEmpty optional", () => {
		const withOpts: AuthRequestPayload = {
			method: AuthMethod.PromptCode,
			provider: "openai-codex",
			placeholder: "Paste",
			allowEmpty: false,
		};
		const bare: AuthRequestPayload = {
			method: AuthMethod.PromptCode,
			provider: "openai-codex",
		};
		expect(withOpts.method).toBe(AuthMethod.PromptCode);
		expect(bare.method).toBe(AuthMethod.PromptCode);
	});

	it("prompt_manual_redirect requires provider + instructions", () => {
		const valid: AuthRequestPayload = {
			method: AuthMethod.PromptManualRedirect,
			provider: "openai-codex",
			instructions: "Paste callback URL",
		};
		expect(valid.method).toBe(AuthMethod.PromptManualRedirect);

		// @ts-expect-error - missing required `instructions` for prompt_manual_redirect
		const missingInstructions: AuthRequestPayload = {
			method: AuthMethod.PromptManualRedirect,
			provider: "openai-codex",
		};
		expect(missingInstructions.method).toBe(AuthMethod.PromptManualRedirect);
	});

	it("show_result requires provider + success; error + providers optional", () => {
		const success: AuthRequestPayload = {
			method: AuthMethod.ShowResult,
			provider: "openai-codex",
			success: true,
			providers: ["openai-codex"],
		};
		const failure: AuthRequestPayload = {
			method: AuthMethod.ShowResult,
			provider: "openai-codex",
			success: false,
			error: "invalid grant",
		};
		expect(success.success).toBe(true);
		expect(failure.success).toBe(false);

		// @ts-expect-error - missing required `success` for show_result
		const missingSuccess: AuthRequestPayload = { method: AuthMethod.ShowResult, provider: "openai-codex" };
		expect(missingSuccess.method).toBe(AuthMethod.ShowResult);
	});

	it("pick_provider requires options (no provider field on this variant)", () => {
		const valid: AuthRequestPayload = {
			method: AuthMethod.PickProvider,
			options: ["openai-codex", "kimi-code"],
			defaultId: "openai-codex",
		};
		expect(valid.options).toHaveLength(2);

		// @ts-expect-error - missing required `options` for pick_provider
		const missingOptions: AuthRequestPayload = { method: AuthMethod.PickProvider };
		expect(missingOptions.method).toBe(AuthMethod.PickProvider);
	});

	it("rejects unknown auth.* methods at compile time", () => {
		// @ts-expect-error - "auth.bogus" is not a member of AuthRequestPayload's method union
		const bogus: AuthRequestPayload = { method: "auth.bogus", provider: "openai-codex" };
		// Runtime side is only an anchor; type-level error above is the real check.
		expect(typeof bogus.method).toBe("string");
	});
});
