import { describe, expect, it } from "bun:test";
import { detectCompat } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { resolveOpenAICompat } from "@oh-my-pi/pi-ai/providers/openai-completions-compat";
import type { Model } from "@oh-my-pi/pi-ai/types";

function makeModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "kimi-for-coding",
		name: "Kimi For Coding",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_000,
		reasoning: true,
		...overrides,
	};
}

describe("Kimi K2.7 Code thinking-disable gating", () => {
	it("omits disabled thinking for the native kimi-for-coding alias", () => {
		const compat = detectCompat(makeModel());
		expect(compat.reasoningDisableMode).toBe("omit");
	});

	it("omits disabled thinking for native Moonshot Kimi K2.7 Code id variants", () => {
		for (const id of ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2p7-code"]) {
			const compat = detectCompat(
				makeModel({ id, name: id, provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1" }),
			);
			expect(compat.reasoningDisableMode).toBe("omit");
		}
	});

	it("keeps explicit disabled thinking for Kimi K2.6", () => {
		const compat = detectCompat(
			makeModel({ id: "kimi-k2.6", name: "Kimi K2.6", provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1" }),
		);
		expect(compat.reasoningDisableMode).toBe("disabled");
	});

	it("does not gate K2.7 Code ids on non-native hosts (Fireworks/OpenRouter dialects)", () => {
		const fireworks = detectCompat(
			makeModel({
				id: "accounts/fireworks/models/kimi-k2.7-code",
				name: "Kimi K2.7 Code",
				provider: "fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
			}),
		);
		expect(fireworks.reasoningDisableMode).toBe("disabled");

		const openrouter = detectCompat(
			makeModel({
				id: "moonshotai/kimi-k2.7-code",
				name: "Kimi K2.7 Code",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		);
		expect(openrouter.reasoningDisableMode).toBe("disabled");
	});

	it("model.compat.reasoningDisableMode override wins over detection", () => {
		const compat = resolveOpenAICompat(makeModel({ compat: { reasoningDisableMode: "disabled" } }));
		expect(compat.reasoningDisableMode).toBe("disabled");
	});

	it("dynamically-discovered kimi-code models (kimiCodeModelManagerOptions mapper shape) still resolve to omit", () => {
		// Mirrors the compat object kimiCodeModelManagerOptions' mapModel sets per
		// discovered model — it doesn't set reasoningDisableMode explicitly, so
		// resolution must fall back to the auto-detected native-host gate.
		const compat = resolveOpenAICompat(
			makeModel({
				compat: {
					thinkingFormat: "zai",
					reasoningContentField: "reasoning_content",
					supportsDeveloperRole: false,
				},
			}),
		);
		expect(compat.reasoningDisableMode).toBe("omit");
	});
});

describe("supportsForcedToolChoice compat resolution", () => {
	it("defaults to true when not overridden", () => {
		const compat = detectCompat(makeModel({ provider: "openai", baseUrl: "https://api.openai.com/v1" }));
		expect(compat.supportsForcedToolChoice).toBe(true);
	});

	it("model.compat override downgrades to false", () => {
		const compat = resolveOpenAICompat(makeModel({ compat: { supportsForcedToolChoice: false } }));
		expect(compat.supportsForcedToolChoice).toBe(false);
	});
});
