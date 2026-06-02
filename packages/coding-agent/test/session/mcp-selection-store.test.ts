import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { MCPSelectionStore, type MCPSelectionContext } from "../../src/session/mcp-selection-store";

type TestMCPTool = AgentTool & {
	mcpServerName: string;
	mcpToolName: string;
};

function createMCPTool(name: string, serverName: string, toolName: string): TestMCPTool {
	return {
		name,
		label: toolName,
		description: `${serverName} ${toolName}`,
		parameters: Type.Object({}),
		mcpServerName: serverName,
		mcpToolName: toolName,
		execute: async () => ({ content: [] }),
	};
}

function createStore(tools: TestMCPTool[]): MCPSelectionStore {
	const toolRegistry = new Map<string, AgentTool>(tools.map(tool => [tool.name, tool]));
	const ctx: MCPSelectionContext = {
		toolRegistry,
		sessionManager: { appendMCPToolSelection: () => {} },
		getActiveToolNames: () => [],
	};
	const store = new MCPSelectionStore(ctx, {
		enabled: true,
		initialSelected: ["mcp__search__query"],
		defaultServerNames: [],
		defaultToolNames: [],
	});
	store.setDiscoverableFromRegistry();
	return store;
}

describe("MCPSelectionStore snapshots", () => {
	it("restores a captured selection after tentative activation", () => {
		const store = createStore([
			createMCPTool("mcp__search__query", "search", "query"),
			createMCPTool("mcp__search__fetch", "search", "fetch"),
		]);
		const snapshot = store.captureSelectedSnapshot();

		expect(store.collectActivatable(["mcp__search__fetch"])).toEqual(["mcp__search__fetch"]);
		expect(store.getSelectedSnapshot()).toEqual(["mcp__search__query", "mcp__search__fetch"]);

		store.restoreSelectedSnapshot(snapshot);

		expect(store.getSelectedSnapshot()).toEqual(["mcp__search__query"]);
	});
});
