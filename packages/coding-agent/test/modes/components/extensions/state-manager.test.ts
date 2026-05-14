import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDisabledProviders, isProviderEnabled, setDisabledProviders } from "../../../../src/discovery";
import {
	applyFilter,
	buildProviderTabs,
	buildSidebarTree,
	createInitialState,
	filterByProvider,
	flattenTree,
	loadAllExtensions,
	refreshState,
	toggleProvider,
} from "../../../../src/modes/components/extensions/state-manager";
import type {
	DashboardState,
	Extension,
	ExtensionKind,
} from "../../../../src/modes/components/extensions/types";

let disabledProvidersBefore: string[];
let tempRoot: string;

function extension(
	name: string,
	kind: ExtensionKind,
	provider: string,
	overrides: Partial<Extension> = {},
): Extension {
	return {
		id: `${kind}:${name}`,
		kind,
		name,
		displayName: name,
		description: undefined,
		trigger: undefined,
		path: `/tmp/${provider}/${kind}/${name}`,
		source: {
			provider,
			providerName: provider === "codex" ? "Codex" : provider === "opencode" ? "OpenCode" : "OMP",
			level: provider === "native" ? "native" : "project",
		},
		state: "active",
		raw: { name },
		...overrides,
	};
}

async function writeProjectFile(cwd: string, relativePath: string, content: string): Promise<void> {
	await Bun.write(path.join(cwd, relativePath), content);
}

async function createNativeProject(): Promise<string> {
	const cwd = path.join(tempRoot, "project");
	await fs.mkdir(cwd, { recursive: true });
	await writeProjectFile(cwd, ".omp/commands/review.md", "Review the current diff.");
	await writeProjectFile(cwd, ".omp/prompts/brief.md", "Create a brief.");
	await writeProjectFile(
		cwd,
		".omp/tools/echo.json",
		JSON.stringify({ name: "echoer", description: "Echo input" }),
	);
	await writeProjectFile(
		cwd,
		".omp/mcp.json",
		JSON.stringify({ mcpServers: { local: { command: "bunx", args: ["local-mcp"] } } }),
	);
	await writeProjectFile(
		cwd,
		".omp/skills/demo/SKILL.md",
		"---\ndescription: Demo skill\nglobs:\n  - '*.ts'\n---\n# Demo\n",
	);
	await writeProjectFile(cwd, ".omp/hooks/pre/bash.sh", "#!/usr/bin/env bash\n");
	await writeProjectFile(cwd, ".omp/AGENTS.md", "Project context");
	await writeProjectFile(cwd, ".codex/commands/codex-review.md", "Codex review command");
	await writeProjectFile(cwd, "mcp.json", JSON.stringify({ mcpServers: { fallback: { command: "bunx" } } }));
	return cwd;
}

describe("extension state manager", () => {
	beforeEach(async () => {
		disabledProvidersBefore = getDisabledProviders();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "extension-state-manager-"));
	});

	afterEach(async () => {
		setDisabledProviders(disabledProvidersBefore);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("builds provider trees and flattens only expanded nodes", () => {
		const extensions = [
			extension("review", "skill", "codex"),
			extension("run-tests", "tool", "codex"),
			extension("module", "extension-module", "codex"),
			extension("server", "mcp", "codex"),
			extension("brief", "prompt", "codex"),
			extension("guide", "instruction", "codex"),
			extension("context", "context-file", "codex"),
			extension("hook", "hook", "codex"),
			extension("cmd", "slash-command", "codex"),
			extension("style", "rule", "opencode", { state: "disabled", disabledReason: "provider-disabled" }),
			extension("native-skill", "skill", "native"),
		];

		const tree = buildSidebarTree(extensions);
		const codex = tree.find(node => node.id === "codex");
		const opencode = tree.find(node => node.id === "opencode");

		expect(tree.some(node => node.id === "native")).toBe(false);
		expect(codex?.count).toBe(9);
		expect(codex?.children.map(child => child.label).sort()).toEqual([
			"Context Files",
			"Extension Modules",
			"Hooks",
			"Instructions",
			"MCP Servers",
			"Prompts",
			"Skills",
			"Slash Commands",
			"Tools",
		]);
		expect(opencode?.children[0]?.label).toBe("Rules");

		const flat = flattenTree(tree);
		expect(flat.some(item => item.node.id === "codex:skill")).toBe(true);
		expect(flat.every((item, index) => item.index === index)).toBe(true);

		if (codex) codex.collapsed = true;
		const collapsed = flattenTree(tree);
		expect(collapsed.some(item => item.node.id === "codex:skill")).toBe(false);
	});

	it("filters extensions by search tokens and provider tabs", () => {
		const extensions = [
			extension("review", "slash-command", "codex", {
				description: "Review pull requests",
				trigger: "/review",
			}),
			extension("planner", "prompt", "opencode", {
				description: "Plan work",
				trigger: "/prompts:planner",
			}),
			extension("native-tool", "tool", "native"),
		];

		expect(applyFilter(extensions, "")).toBe(extensions);
		expect(applyFilter(extensions, "review codex").map(item => item.id)).toEqual(["slash-command:review"]);
		expect(applyFilter(extensions, "prompt planner").map(item => item.id)).toEqual(["prompt:planner"]);
		expect(applyFilter(extensions, "missing")).toEqual([]);

		expect(filterByProvider(extensions, "all")).toBe(extensions);
		expect(filterByProvider(extensions, "codex").map(item => item.name)).toEqual(["review"]);

		const tabs = buildProviderTabs(extensions);
		expect(tabs[0]).toEqual({ id: "all", label: "ALL", enabled: true, count: 3 });
		expect(tabs.find(tab => tab.id === "codex")?.count).toBe(1);
		expect(tabs.find(tab => tab.id === "opencode")?.count).toBe(1);
	});

	it("toggles provider enabled state and reports the resulting state", () => {
		const original = isProviderEnabled("codex");

		const first = toggleProvider("codex");
		expect(first).toBe(!original);
		expect(isProviderEnabled("codex")).toBe(!original);

		const second = toggleProvider("codex");
		expect(second).toBe(original);
		expect(isProviderEnabled("codex")).toBe(original);
	});

	it("loads native project extensions and refreshes dashboard selection", async () => {
		const cwd = await createNativeProject();
		const disabledIds = ["slash-command:review", "mcp:local"];

		const extensions = await loadAllExtensions(cwd, disabledIds);
		const review = extensions.find(item => item.id === "slash-command:review");
		const mcp = extensions.find(item => item.id === "mcp:local");
		const prompt = extensions.find(item => item.id === "prompt:brief");
		const tool = extensions.find(item => item.id === "tool:echoer");
		const skill = extensions.find(item => item.id === "skill:demo");
		const hook = extensions.find(item => item.id === "hook:pre:bash:bash.sh");
		const contextFile = extensions.find(item => item.id === "context-file:project:AGENTS.md");

		expect(review?.state).toBe("disabled");
		expect(review?.disabledReason).toBe("item-disabled");
		expect(review?.trigger).toBe("/review");
		expect(mcp?.state).toBe("disabled");
		expect(mcp?.description).toBe("bunx");
		expect(mcp?.trigger).toBe("stdio");
		expect(prompt?.trigger).toBe("/prompts:brief");
		expect(tool?.description).toBe("Echo input");
		expect(skill?.description).toBe("Demo skill");
		expect(skill?.trigger).toBe("*.ts");
		expect(hook?.description).toBe("pre-bash");
		expect(hook?.trigger).toBe("pre:bash");
		expect(contextFile?.description).toBe("Project-level context");
		expect(contextFile?.trigger).toBe("project");

		const initial = await createInitialState(cwd, disabledIds);
		expect(initial.tabs[0]?.id).toBe("all");
		expect(initial.extensions.some(item => item.id === "slash-command:review")).toBe(true);

		const state: DashboardState = {
			...initial,
			searchQuery: "review",
			selected: review ?? null,
			listIndex: 99,
		};
		const refreshed = await refreshState(state, cwd, disabledIds);

		expect(refreshed.searchFiltered.some(item => item.id === "slash-command:review")).toBe(true);
		expect(refreshed.selected?.id).toBe("slash-command:review");
		expect(refreshed.listIndex).toBe(refreshed.searchFiltered.findIndex(item => item.id === "slash-command:review"));

		const fallback = await refreshState(
			{ ...initial, selected: null, searchQuery: "", listIndex: 999 },
			cwd,
			disabledIds,
		);
		expect(fallback.selected).not.toBeNull();
		expect(fallback.listIndex).toBe(fallback.searchFiltered.length - 1);
	});
});
