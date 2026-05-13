import { describe, expect, it } from "bun:test";
import { toolkitFromPiAiTools } from "@oh-my-pi/pi-ai/effect-ai-toolkit-bridge";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { Type } from "@sinclair/typebox";

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get current weather for a city",
	parameters: Type.Object({ city: Type.String() }),
};

const listFilesTool: Tool = {
	name: "list_files",
	description: "List files in a directory",
	parameters: Type.Object({ path: Type.String() }),
};

describe("toolkitFromPiAiTools — pi-ai Tool[] -> Effect 4 Toolkit", () => {
	it("returns undefined when the input is undefined (callers can omit the toolkit option)", () => {
		expect(toolkitFromPiAiTools(undefined)).toBeUndefined();
	});

	it("returns undefined when the input is an empty array (no tools to register)", () => {
		expect(toolkitFromPiAiTools([])).toBeUndefined();
	});

	it("produces a Toolkit instance when the input has at least one tool", () => {
		const kit = toolkitFromPiAiTools([weatherTool]);
		expect(kit).toBeDefined();
	});

	it("registers each input tool's name as a key on the toolkit's tools record", () => {
		const kit = toolkitFromPiAiTools([weatherTool, listFilesTool]);
		expect(kit).toBeDefined();
		if (kit === undefined) return;
		expect(Object.keys(kit.tools).sort()).toEqual(["get_weather", "list_files"]);
	});

	it("preserves each tool's description for the LLM-facing definition", () => {
		const kit = toolkitFromPiAiTools([weatherTool]);
		expect(kit).toBeDefined();
		if (kit === undefined) return;
		const registered = kit.tools.get_weather;
		expect(registered?.description).toBe("Get current weather for a city");
	});
});
