import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import {
	buildModelsConfigFromCrushConfig,
	importCrushProviders,
} from "@oh-my-pi/pi-coding-agent/config/import-crush-providers";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("importCrushProviders", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), "pi-crush-provider-import", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("converts importable Crush providers without overwriting existing model config", () => {
		const { config, providers } = buildModelsConfigFromCrushConfig(
			{
				providers: {
					"openai-local": {
						name: "Local OpenAI",
						type: "openai-compatible",
						base_url: " http://127.0.0.1:11434/v1 ",
						api_key: "not-required",
						extra_headers: { "X-Trace": "yes", ignored: 123 },
						models: [
							{
								id: " qwen3 ",
								name: "Qwen 3",
								context_window: "32768",
								default_max_tokens: 4096,
								can_reason: true,
								supports_attachments: true,
							},
						],
					},
					skipped: {
						base_url: "http://127.0.0.1:9999/v1",
						models: [],
					},
				},
			},
			{
				equivalence: { "old/model": "new/model" },
				providers: {
					existing: { baseUrl: "http://existing/v1", auth: "none" },
				},
			},
		);

		expect(providers).toEqual([
			{
				id: "openai-local",
				name: "Local OpenAI",
				baseUrl: "http://127.0.0.1:11434/v1",
				models: ["qwen3"],
				auth: "none",
			},
		]);
		expect(config.equivalence).toEqual({ "old/model": "new/model" });
		expect(config.providers?.existing).toEqual({ baseUrl: "http://existing/v1", auth: "none" });
		expect(config.providers?.["openai-local"]).toEqual({
			baseUrl: "http://127.0.0.1:11434/v1",
			api: "openai-completions",
			auth: "none",
			headers: { "X-Trace": "yes" },
			models: [
				{
					id: "qwen3",
					name: "Qwen 3",
					contextWindow: 32768,
					maxTokens: 4096,
					reasoning: true,
					input: ["text", "image"],
				},
			],
		});
	});

	it("writes a models.yml preview only when requested", async () => {
		const sourcePath = path.join(tempDir, "crush.json");
		const targetPath = path.join(tempDir, "agent", "models.yml");
		await Bun.write(
			sourcePath,
			JSON.stringify({
				providers: [
					{
						id: "anthropic-proxy",
						type: "anthropic",
						baseUrl: "https://proxy.example/v1",
						apiKey: "secret-token",
						models: [{ id: "claude-proxy", maxTokens: "2048", reasoning: false }],
					},
				],
			}),
		);

		const preview = await importCrushProviders({ sourcePath, targetPath });
		expect(preview.wrote).toBe(false);
		expect(await Bun.file(targetPath).exists()).toBe(false);

		const written = await importCrushProviders({ sourcePath, targetPath, write: true });
		expect(written.wrote).toBe(true);
		const parsed = YAML.parse(await Bun.file(targetPath).text()) as {
			providers: Record<string, { api: string; apiKey: string; authHeader: boolean }>;
		};
		expect(parsed.providers["anthropic-proxy"]).toMatchObject({
			api: "anthropic-messages",
			apiKey: "secret-token",
			authHeader: true,
		});
	});

	it("accepts array providers and maps Crush provider api variants", () => {
		const { config, providers } = buildModelsConfigFromCrushConfig({
			providers: [
				{ id: "openai", type: "openai", base_url: "https://openai.example/v1", models: [{ id: "gpt" }] },
				{ id: "gemini", type: "gemini", base_url: "https://gemini.example/v1", models: [{ id: "gemini-pro" }] },
				{ id: "vertex", type: "vertexai", base_url: "https://vertex.example/v1", models: [{ id: "vertex-pro" }] },
				{ type: "openai", base_url: "https://missing-id.example/v1", models: [{ id: "missing-id" }] },
				"not a provider",
			],
		});

		expect(providers.map(provider => provider.id)).toEqual(["openai", "gemini", "vertex"]);
		expect(config.providers?.openai?.api).toBe("openai-completions");
		expect(config.providers?.gemini?.api).toBe("google-generative-ai");
		expect(config.providers?.vertex?.api).toBe("google-vertex");
	});
});
