import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveOpenAiAuth } from "@oh-my-pi/pi-ai/effect-ai-auth";
import type { Model } from "@oh-my-pi/pi-ai/types";

const baseModel: Model<"openai-responses"> = {
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
};

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

afterEach(() => {
	if (ORIGINAL_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
});

describe("resolveOpenAiAuth — pi-ai Model + overrides -> OpenAiClient inputs", () => {
	beforeEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("apiKey override wins over the env var", () => {
		process.env.OPENAI_API_KEY = "env-key";
		const out = resolveOpenAiAuth(baseModel, { apiKey: "override-key" });
		expect(out.apiKey).toBe("override-key");
	});

	it("falls back to <PROVIDER>_API_KEY env var when no override is given", () => {
		process.env.OPENAI_API_KEY = "env-key";
		const out = resolveOpenAiAuth(baseModel, undefined);
		expect(out.apiKey).toBe("env-key");
	});

	it("leaves apiKey undefined when neither override nor env var is set", () => {
		const out = resolveOpenAiAuth(baseModel, undefined);
		expect(out.apiKey).toBeUndefined();
	});

	it("normalises provider names to UPPER_SNAKE_CASE for env-var lookup", () => {
		const customModel: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			provider: "openai-codex",
			baseUrl: "https://codex.example/v1",
		};
		process.env.OPENAI_CODEX_API_KEY = "codex-key";
		try {
			const out = resolveOpenAiAuth(customModel, undefined);
			expect(out.apiKey).toBe("codex-key");
		} finally {
			delete process.env.OPENAI_CODEX_API_KEY;
		}
	});

	it("baseUrl override wins over model.baseUrl", () => {
		const out = resolveOpenAiAuth(baseModel, { baseUrl: "https://custom.example/v1" });
		expect(out.baseUrl).toBe("https://custom.example/v1");
	});

	it("falls back to model.baseUrl when no override is given", () => {
		const out = resolveOpenAiAuth(baseModel, undefined);
		expect(out.baseUrl).toBe("https://api.openai.com/v1");
	});

	it("passes organizationId and projectId through unchanged", () => {
		const out = resolveOpenAiAuth(baseModel, {
			organizationId: "org-abc",
			projectId: "proj-123",
		});
		expect(out.organizationId).toBe("org-abc");
		expect(out.projectId).toBe("proj-123");
	});

	it("returns undefined for organizationId / projectId when no override is given (no env fallback in this slice)", () => {
		const out = resolveOpenAiAuth(baseModel, undefined);
		expect(out.organizationId).toBeUndefined();
		expect(out.projectId).toBeUndefined();
	});
});
