import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { fromAny } from "@total-typescript/shoehorn";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AgentDashboard } from "../../../src/modes/components/agent-dashboard";
import { initTheme } from "../../../src/modes/theme/theme";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:10531/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function registryFor(models: Model<Api>[]): ModelRegistry {
	return fromAny<ModelRegistry>({
		authStorage: {},
		refresh: vi.fn(async () => undefined),
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find(item => item.provider === provider && item.id === id),
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
	});
}

function render(dashboard: AgentDashboard, width = 160): string {
	return sanitizeText(Bun.stripANSI(dashboard.render(width).join("\n")));
}

async function withTempProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-dashboard-"));
	try {
		await fs.mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
		return await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

async function writeProjectAgent(cwd: string, name: string, description: string, systemPrompt: string): Promise<void> {
	await Bun.write(
		path.join(cwd, ".omp", "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\nmodel: openai/gpt-5.4\n---\n\n${systemPrompt}\n`,
	);
}

function typeChars(dashboard: AgentDashboard, text: string): void {
	for (const char of text) {
		dashboard.handleInput(char);
	}
}

describe("AgentDashboard", () => {
	beforeEach(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders discovered agents and handles search, toggles, model overrides, create flow, reload, and close", async () => {
		await withTempProject(async cwd => {
			await writeProjectAgent(
				cwd,
				"project-reviewer",
				"Use this agent when reviewing code changes",
				"Review code carefully.\nReport concrete risks.",
			);
			await writeProjectAgent(
				cwd,
				"zz-helper-agent",
				"Use this agent when helping with deterministic tests",
				"Write focused tests.",
			);

			const settings = Settings.isolated({
				modelRoles: { default: "openai/gpt-5.4" },
			});
			settings.set("task.agentModelOverrides", { "project-reviewer": "anthropic/claude-sonnet-4:high" });
			settings.set("task.disabledAgents", []);
			const registry = registryFor([model("openai", "gpt-5.4"), model("anthropic", "claude-sonnet-4")]);
			const dashboard = await AgentDashboard.create(cwd, settings, 24, {
				modelRegistry: registry,
				defaultModelPattern: "openai/gpt-5.4",
			});
			const onClose = vi.fn();
			const onRender = vi.fn();
			dashboard.onClose = onClose;
			dashboard.onRequestRender = onRender;

			const initial = render(dashboard);
			expect(initial).toContain("Agent Control Center");
			expect(initial).toContain("project-reviewer");
			expect(initial).toContain("(override)");
			expect(initial).toContain("Use this agent when reviewing code changes");
			expect(initial).toContain("Default resolves:");
			expect(initial).toContain("Effective:");

			typeChars(dashboard, "review");
			expect(render(dashboard)).toContain("Search: review");
			expect(render(dashboard)).toContain("project-reviewer");
			dashboard.handleInput("\x1b");
			expect(onClose).not.toHaveBeenCalled();

			typeChars(dashboard, "zz");
			expect(render(dashboard)).toContain("zz-helper-agent");
			dashboard.handleInput(" ");
			expect(settings.get("task.disabledAgents")).toContain("zz-helper-agent");

			dashboard.handleInput("\r");
			expect(render(dashboard)).toContain("Model override: zz-helper-agent");
			dashboard.handleInput("openai/gpt-5.4");
			expect(render(dashboard)).toContain("Suggestions:");
			dashboard.handleInput("\r");
			expect(settings.get("task.agentModelOverrides")["zz-helper-agent"]).toBe("openai/gpt-5.4");
			expect(render(dashboard)).toContain("Updated model override for zz-helper-agent");

			dashboard.handleInput("n");
			expect(render(dashboard)).toContain("Create New Agent");
			expect(render(dashboard)).toContain("Scope: project");
			dashboard.handleInput("\t");
			expect(render(dashboard)).toContain("Scope: user");
			dashboard.handleInput("\r");
			expect(render(dashboard)).toContain("Description is required.");
			dashboard.handleInput("\x1b");
			expect(render(dashboard)).toContain("Agent Control Center");

			dashboard.handleInput(String.fromCharCode("r".charCodeAt(0) & 31));
			await Bun.sleep(20);
			expect(onRender).toHaveBeenCalled();

			dashboard.handleInput("\t");
			expect(render(dashboard)).toContain("Project (");
			dashboard.handleInput("\x1b[Z");
			expect(render(dashboard)).toContain("All (");

			dashboard.handleInput("\x1b");
			dashboard.handleInput("\x1b");
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	it("surfaces agent creation generation errors through the create flow", async () => {
		await withTempProject(async cwd => {
			await writeProjectAgent(
				cwd,
				"project-reviewer",
				"Use this agent when reviewing code changes",
				"Review code carefully.",
			);
			const dashboard = await AgentDashboard.create(cwd, Settings.isolated(), 20);
			const onRender = vi.fn();
			dashboard.onRequestRender = onRender;

			dashboard.handleInput("n");
			typeChars(dashboard, "make a focused reviewer");
			dashboard.handleInput("\r");
			await Bun.sleep(20);

			expect(render(dashboard)).toContain("Model registry unavailable in current session.");
			expect(onRender).toHaveBeenCalled();
		});
	});
});
