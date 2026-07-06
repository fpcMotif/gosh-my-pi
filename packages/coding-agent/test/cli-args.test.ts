import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai/model-thinking";
import { expandInlineFlagValues, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("CLI argument parsing", () => {
	test("parses inline flag values without mutating argv", () => {
		const argv = ["--model=gpt-4o", "--tools=Read,Search", "explain this"];

		const result = parseArgs(argv);

		expect(result.model).toBe("gpt-4o");
		expect(result.tools).toEqual(["read", "search"]);
		expect(result.messages).toEqual(["explain this"]);
		expect(argv).toEqual(["--model=gpt-4o", "--tools=Read,Search", "explain this"]);
	});

	test("parses registered extension flags with inline values", () => {
		const extensionFlags = new Map<string, { type: "boolean" | "string" }>([
			["dry-run", { type: "boolean" }],
			["label", { type: "string" }],
		]);

		const result = parseArgs(["--dry-run", "--label=regression"], extensionFlags);

		expect(result.unknownFlags.get("dry-run")).toBe(true);
		expect(result.unknownFlags.get("label")).toBe("regression");
	});

	test("does not treat file mentions or flags as list-models search text", () => {
		const fileResult = parseArgs(["--list-models", "@prompt.md"]);
		const flagResult = parseArgs(["--list-models", "--print"]);

		expect(fileResult.listModels).toBe(true);
		expect(fileResult.fileArgs).toEqual(["prompt.md"]);
		expect(flagResult.listModels).toBe(true);
		expect(flagResult.print).toBe(true);
	});

	test("parses thinking level through the public effort enum", () => {
		const result = parseArgs(["--thinking", "high"]);

		expect(result.thinking).toBe(Effort.High);
	});

	test("normalizes inline flag values as a pure helper", () => {
		const argv = ["--model=gpt-4o", "--tools=read,bash", "prompt"] as const;

		expect(expandInlineFlagValues(argv)).toEqual(["--model", "gpt-4o", "--tools", "read,bash", "prompt"]);
		expect(argv).toEqual(["--model=gpt-4o", "--tools=read,bash", "prompt"]);
	});
});
