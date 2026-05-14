import { beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import type { TUI } from "@oh-my-pi/pi-tui";
import { fromAny } from "@total-typescript/shoehorn";
import type { CanonicalModelRecord, ModelRegistry, ProviderDiscoveryState } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { ModelSelectorComponent } from "../../../src/modes/components/model-selector";
import { initTheme } from "../../../src/modes/theme/theme";

function model(provider: string, id: string, name = id, priority?: number): Model<Api> {
	return {
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:10531/v1",
		reasoning: id.startsWith("gpt-5") || id.includes("claude"),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		priority,
	};
}

function render(component: ModelSelectorComponent, width = 160): string {
	return sanitizeText(Bun.stripANSI(component.render(width).join("\n")));
}

async function flushModelLoad(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function tuiStub() {
	const requestRender = vi.fn();
	return { tui: fromAny<TUI>({ requestRender }), requestRender };
}

function registryStub(options: {
	all: Model<Api>[];
	available?: Model<Api>[];
	discoverable?: string[];
	states?: Record<string, ProviderDiscoveryState>;
	error?: unknown;
	getAvailableError?: unknown;
	refreshProviderError?: unknown;
}) {
	const canonical: CanonicalModelRecord[] = options.all.length
		? [
				{
					id: "smart-model",
					name: "Smart Model",
					variants: options.all.map(item => ({
						canonicalId: "smart-model",
						selector: `${item.provider}/${item.id}`,
						model: item,
						source: "bundled",
					})),
				},
			]
		: [];
	const raw = {
		refresh: vi.fn(async (_strategy: string) => undefined),
		refreshProvider: vi.fn(async (_provider: string) => {
			if (options.refreshProviderError) throw options.refreshProviderError;
		}),
		getError: () => options.error,
		getAll: () => options.all,
		getAvailable: () => {
			if (options.getAvailableError) throw options.getAvailableError;
			return options.available ?? options.all;
		},
		getCanonicalModels: () => canonical,
		resolveCanonicalModel: (id: string) => (id === "smart-model" ? options.all[0] : undefined),
		getDiscoverableProviders: () => options.discoverable ?? [],
		getProviderDiscoveryState: (provider: string) => options.states?.[provider],
	};
	return { registry: fromAny<ModelRegistry>(raw), raw };
}

describe("ModelSelectorComponent", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("loads models, filters search input, opens the role menu, and selects thinking level", async () => {
		const gpt54 = model("openai", "gpt-5.4", "GPT 5.4", 0);
		const gpt4o = model("openai", "gpt-4o", "GPT 4o", 10);
		const claude = model("anthropic", "claude-sonnet-4-20251001", "Claude Sonnet 4", 0);
		const settings = Settings.isolated({
			modelRoles: {
				default: "openai/gpt-5.4:high",
				smol: "openai/gpt-4o",
			},
			cycleOrder: ["research"],
			modelTags: { research: { name: "Research", color: "accent" } },
		});
		const { tui, requestRender } = tuiStub();
		const { registry } = registryStub({ all: [gpt54, gpt4o, claude] });
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(tui, undefined, settings, registry, [], onSelect, vi.fn());

		await flushModelLoad();
		expect(requestRender).toHaveBeenCalled();
		const initial = render(selector);
		expect(initial).toContain("Only showing models with configured API keys");
		expect(initial).toContain("openai/gpt-5.4");
		expect(initial).toContain("DEFAULT");
		expect(initial).toContain("SMOL");

		selector.handleInput("claude");
		const filtered = render(selector);
		expect(filtered).toContain("anthropic/claude-sonnet-4-20251001");
		expect(filtered).not.toContain("openai/gpt-4o");

		selector.handleInput("\r");
		expect(render(selector)).toContain("Action for: claude-sonnet-4-20251001");
		selector.handleInput("\r");
		expect(render(selector)).toContain("Thinking for: Default");
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith(
			claude,
			"default",
			ThinkingLevel.Inherit,
			"anthropic/claude-sonnet-4-20251001",
		);
	});

	it("selects scoped models directly in temporary mode without refreshing the registry", async () => {
		const scoped = model("local", "qwen-2.5", "Qwen Local");
		const settings = Settings.isolated();
		const { tui } = tuiStub();
		const { registry, raw } = registryStub({ all: [scoped] });
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			tui,
			undefined,
			settings,
			registry,
			[{ model: scoped }],
			onSelect,
			vi.fn(),
			{ temporaryOnly: true, initialSearchInput: "qwen" },
		);

		await flushModelLoad();
		const text = render(selector);
		expect(text).toContain("Showing models from --models scope");
		expect(text).toContain("local/qwen-2.5");

		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith(scoped, null, undefined, "local/qwen-2.5");
		expect(raw.refresh).not.toHaveBeenCalled();
	});

	it("switches provider tabs, renders canonical models, and reports provider empty states", async () => {
		const gpt = model("openai", "gpt-5.4", "GPT 5.4");
		const claude = model("anthropic", "claude-sonnet-4", "Claude Sonnet 4");
		const settings = Settings.isolated();
		const { tui } = tuiStub();
		const { registry, raw } = registryStub({
			all: [gpt, claude],
			discoverable: ["empty"],
			states: {
				empty: {
					provider: "empty",
					status: "cached",
					optional: false,
					stale: true,
					fetchedAt: Date.now(),
					models: [],
				},
			},
		});
		const selector = new ModelSelectorComponent(tui, undefined, settings, registry, [], vi.fn(), vi.fn());

		await flushModelLoad();
		selector.handleInput("\t");
		expect(render(selector)).toContain("smart-model [2] -> openai/gpt-5.4");

		selector.handleInput("\t");
		await flushModelLoad();
		expect(render(selector)).toContain("claude-sonnet-4");

		selector.handleInput("\t");
		await flushModelLoad();
		expect(render(selector)).toContain("Using cached model list from less than a minute ago");
		expect(raw.refreshProvider).toHaveBeenCalledWith("anthropic");
		expect(raw.refreshProvider).toHaveBeenCalledWith("empty");
	});

	it("renders registry load errors and provider refresh failures", async () => {
		const settings = Settings.isolated();
		const broken = model("openai", "broken", "Broken");
		const { tui: errorTui } = tuiStub();
		const loadErrorRegistry = registryStub({
			all: [broken],
			getAvailableError: new Error("catalog unavailable"),
		}).registry;
		const loadErrorSelector = new ModelSelectorComponent(
			errorTui,
			undefined,
			settings,
			loadErrorRegistry,
			[],
			vi.fn(),
			vi.fn(),
		);

		await flushModelLoad();
		expect(render(loadErrorSelector)).toContain("catalog unavailable");

		const { tui: refreshTui } = tuiStub();
		const { registry } = registryStub({
			all: [broken],
			discoverable: ["openai"],
			refreshProviderError: new Error("live refresh failed"),
		});
		const refreshSelector = new ModelSelectorComponent(
			refreshTui,
			undefined,
			settings,
			registry,
			[],
			vi.fn(),
			vi.fn(),
		);

		await flushModelLoad();
		refreshSelector.handleInput("\t");
		refreshSelector.handleInput("\t");
		await flushModelLoad();
		expect(render(refreshSelector)).toContain("live refresh failed");
	});
});
