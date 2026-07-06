import { expect, test, describe } from "bun:test";
import { parseSwarmYaml, validateSwarmDefinition } from "../src/swarm/schema";

describe("parseSwarmYaml", () => {
	describe("happy paths", () => {
		test("should parse a valid simple sequential swarm", () => {
			const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    agent1:
      role: tester
      task: run tests
`;
			const def = parseSwarmYaml(yaml);
			expect(def.name).toBe("test-swarm");
			expect(def.workspace).toBe("/tmp/test");
			expect(def.mode).toBe("sequential"); // default
			expect(def.targetCount).toBe(1); // default
			expect(def.agentOrder).toEqual(["agent1"]);
			expect(def.agents.size).toBe(1);
			expect(def.agents.get("agent1")).toEqual({
				name: "agent1",
				role: "tester",
				task: "run tests",
				extraContext: undefined,
				reportsTo: [],
				waitsFor: [],
				model: undefined,
			});
		});

		test("should parse a valid parallel swarm with all fields", () => {
			const yaml = `
swarm:
  name: full-swarm
  workspace: /tmp/workspace
  mode: parallel
  model: gpt-4
  agents:
    agent1:
      role: dev
      task: code
      extra_context: context1
      model: claude-3
    agent2:
      role: reviewer
      task: review
      waits_for: ["agent1"]
      reports_to: ["agent1"]
`;
			const def = parseSwarmYaml(yaml);
			expect(def.name).toBe("full-swarm");
			expect(def.workspace).toBe("/tmp/workspace");
			expect(def.mode).toBe("parallel");
			expect(def.model).toBe("gpt-4");
			expect(def.agents.get("agent1")).toEqual({
				name: "agent1",
				role: "dev",
				task: "code",
				extraContext: "context1",
				reportsTo: [],
				waitsFor: [],
				model: "claude-3",
			});
			expect(def.agents.get("agent2")).toEqual({
				name: "agent2",
				role: "reviewer",
				task: "review",
				extraContext: undefined,
				reportsTo: ["agent1"],
				waitsFor: ["agent1"],
				model: undefined,
			});
		});

		test("should parse target_count in pipeline mode", () => {
			const yaml = `
swarm:
  name: pipeline-swarm
  workspace: /tmp/test
  mode: pipeline
  target_count: 5
  agents:
    agent1:
      role: tester
      task: run tests
`;
			const def = parseSwarmYaml(yaml);
			expect(def.mode).toBe("pipeline");
			expect(def.targetCount).toBe(5);
		});
	});

	describe("edge cases and errors", () => {
		test("should throw if top-level 'swarm' key is missing", () => {
			const yaml = `
not_swarm:
  name: test
`;
			expect(() => parseSwarmYaml(yaml)).toThrow(/YAML must have a top-level 'swarm' key/);
		});

		test("should throw if swarm.name is missing or invalid", () => {
			expect(() => parseSwarmYaml(`swarm:\n  workspace: w\n  agents: {a: {role: r, task: t}}`)).toThrow(
				/swarm.name is required/,
			);
			expect(() => parseSwarmYaml(`swarm:\n  name: 123\n  workspace: w\n  agents: {a: {role: r, task: t}}`)).toThrow(
				/swarm.name is required/,
			); // numbers get parsed as numbers by bun yaml sometimes, but we want string
			expect(() =>
				parseSwarmYaml(`swarm:\n  name: "invalid name !!"\n  workspace: w\n  agents: {a: {role: r, task: t}}`),
			).toThrow(/may only contain letters/);
		});

		test("should throw if swarm.workspace is missing or invalid", () => {
			expect(() => parseSwarmYaml(`swarm:\n  name: test\n  agents: {a: {role: r, task: t}}`)).toThrow(
				/swarm.workspace is required/,
			);
		});

		test("should throw if agents are missing or empty", () => {
			expect(() => parseSwarmYaml(`swarm:\n  name: test\n  workspace: w`)).toThrow(
				/swarm.agents must contain at least one agent/,
			);
			expect(() => parseSwarmYaml(`swarm:\n  name: test\n  workspace: w\n  agents: {}`)).toThrow(
				/swarm.agents must contain at least one agent/,
			);
		});

		test("should throw on invalid mode", () => {
			const yaml = `
swarm:
  name: test
  workspace: w
  mode: invalid_mode
  agents:
    a:
      role: r
      task: t
`;
			expect(() => parseSwarmYaml(yaml)).toThrow(/Invalid mode 'invalid_mode'/);
		});

		test("should throw if agent is missing role or task", () => {
			const yamlNoRole = `
swarm:
  name: test
  workspace: w
  agents:
    a:
      task: t
`;
			expect(() => parseSwarmYaml(yamlNoRole)).toThrow(/Agent 'a': 'role' is required/);

			const yamlNoTask = `
swarm:
  name: test
  workspace: w
  agents:
    a:
      role: r
`;
			expect(() => parseSwarmYaml(yamlNoTask)).toThrow(/Agent 'a': 'task' is required/);
		});
	});
});

describe("validateSwarmDefinition", () => {
	test("should return no errors for a valid definition", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  mode: parallel
  agents:
    a:
      role: r
      task: t
    b:
      role: r
      task: t
      waits_for: ["a"]
      reports_to: ["a"]
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toEqual([]);
	});

	test("should return error if global model is empty", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  model: ""
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("swarm.model must not be empty when provided");
	});

	test("should return error if agent model is empty", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    a:
      role: r
      task: t
      model: ""
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("Agent 'a' model must not be empty when provided");
	});

	test("should return error if agent waits_for unknown agent", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    a:
      role: r
      task: t
      waits_for: ["unknown"]
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("Agent 'a' waits_for unknown agent 'unknown'");
	});

	test("should return error if agent waits_for itself", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    a:
      role: r
      task: t
      waits_for: ["a"]
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("Agent 'a' cannot wait for itself");
	});

	test("should return error if agent reports_to unknown agent", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    a:
      role: r
      task: t
      reports_to: ["unknown"]
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("Agent 'a' reports_to unknown agent 'unknown'");
	});

	test("should return error if agent reports_to itself", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  agents:
    a:
      role: r
      task: t
      reports_to: ["a"]
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("Agent 'a' cannot report to itself");
	});

	test("should return error if target_count < 1", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  mode: pipeline
  target_count: 0
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("target_count must be at least 1");
	});

	test("should return error if target_count !== 1 and mode is not pipeline", () => {
		const yaml = `
swarm:
  name: test-swarm
  workspace: /tmp/test
  mode: parallel
  target_count: 5
  agents:
    a:
      role: r
      task: t
`;
		const def = parseSwarmYaml(yaml);
		const errors = validateSwarmDefinition(def);
		expect(errors).toContain("target_count is only supported in pipeline mode");
	});
});
