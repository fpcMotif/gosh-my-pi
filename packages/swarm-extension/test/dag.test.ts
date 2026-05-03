import { expect, test, describe } from "bun:test";
import { buildExecutionWaves } from "../src/swarm/dag";

describe("buildExecutionWaves", () => {
	test("should handle empty graph", () => {
		const deps = new Map<string, Set<string>>();
		expect(buildExecutionWaves(deps)).toEqual([]);
	});

	test("should handle no dependencies (all in one wave, sorted)", () => {
		const deps = new Map([
			["C", new Set<string>()],
			["A", new Set<string>()],
			["B", new Set<string>()],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["A", "B", "C"]]);
	});

	test("should handle linear dependencies", () => {
		const deps = new Map([
			["A", new Set<string>()],
			["B", new Set(["A"])],
			["C", new Set(["B"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["A"], ["B"], ["C"]]);
	});

	test("should handle parallel dependencies", () => {
		const deps = new Map([
			["A", new Set<string>()],
			["B", new Set<string>()],
			["C", new Set(["A", "B"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["A", "B"], ["C"]]);
	});

	test("should handle diamond dependencies", () => {
		const deps = new Map([
			["A", new Set<string>()],
			["B", new Set(["A"])],
			["C", new Set(["A"])],
			["D", new Set(["B", "C"])],
		]);
		expect(buildExecutionWaves(deps)).toEqual([["A"], ["B", "C"], ["D"]]);
	});

	test("should handle complex mixed dependencies", () => {
		const deps = new Map([
			["A", new Set<string>()],
			["B", new Set(["A"])],
			["C", new Set<string>()],
			["D", new Set(["B", "C"])],
			["E", new Set(["D"])],
		]);
		// Wave 1: A, C
		// Wave 2: B
		// Wave 3: D
		// Wave 4: E
		expect(buildExecutionWaves(deps)).toEqual([["A", "C"], ["B"], ["D"], ["E"]]);
	});

	test("should throw error on cycles (deadlock)", () => {
		const deps = new Map([
			["A", new Set(["B"])],
			["B", new Set(["A"])],
		]);
		expect(() => buildExecutionWaves(deps)).toThrow(/Deadlock/);
	});

	test("should throw error on partial cycles", () => {
		const deps = new Map([
			["A", new Set<string>()],
			["B", new Set(["A", "C"])],
			["C", new Set(["B"])],
		]);
		// A is ready, then deadlock on B and C
		expect(() => buildExecutionWaves(deps)).toThrow(/Deadlock: agents \[B, C\]/);
	});
});
