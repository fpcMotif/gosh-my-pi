import { describe, expect, it } from "bun:test";
import { subprocessToolRegistry } from "../../src/task/subprocess-tool-registry";

describe("subprocessToolRegistry", () => {
	it("reports registered handlers by tool name", () => {
		const toolName = "unit_registry_probe";
		const handler = {
			extractData: () => ({ ok: true }),
		};

		subprocessToolRegistry.register(toolName, handler);

		expect(subprocessToolRegistry.hasHandler(toolName)).toBe(true);
		expect(subprocessToolRegistry.getHandler(toolName)).toBe(handler);
		expect(subprocessToolRegistry.getRegisteredTools()).toContain(toolName);
	});
});
