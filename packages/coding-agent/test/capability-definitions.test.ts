import { describe, expect, it } from "bun:test";
import { contextFileCapability, type ContextFile } from "../src/capability/context-file";
import { extensionModuleCapability, type ExtensionModule } from "../src/capability/extension-module";
import { extensionCapability } from "../src/capability/extension";
import { hookCapability, type Hook } from "../src/capability/hook";
import { instructionCapability, type Instruction } from "../src/capability/instruction";
import { mcpCapability, type MCPServer } from "../src/capability/mcp";
import { promptCapability, type Prompt } from "../src/capability/prompt";
import { skillCapability, type Skill } from "../src/capability/skill";
import { slashCommandCapability, type SlashCommand } from "../src/capability/slash-command";
import { sshCapability, type SSHHost } from "../src/capability/ssh";
import { systemPromptCapability, type SystemPrompt } from "../src/capability/system-prompt";
import { toolCapability, type CustomTool } from "../src/capability/tool";
import type { SourceMeta } from "../src/capability/types";

const source: SourceMeta = {
	provider: "unit",
	providerName: "Unit",
	path: "/tmp/source",
	level: "project",
};

describe("capability definitions", () => {
	it("validates extension metadata and derives extension keys", () => {
		const valid = { name: "docs", path: "/tmp/docs", manifest: {}, level: "project", _source: source };

		expect(extensionCapability.key(valid)).toBe("docs");
		expect(extensionCapability.validate?.(valid)).toBeUndefined();
		expect(extensionCapability.validate?.({ ...valid, name: "" })).toBe("Missing extension name");
		expect(extensionCapability.validate?.({ ...valid, path: "" })).toBe("Missing extension path");
	});

	it("validates extension module entries and extension ids", () => {
		const valid: ExtensionModule = { name: "review", path: "/tmp/review.ts", level: "project", _source: source };

		expect(extensionModuleCapability.key(valid)).toBe("review");
		expect(extensionModuleCapability.toExtensionId?.(valid)).toBe("extension-module:review");
		expect(extensionModuleCapability.validate?.(valid)).toBeUndefined();
		expect(extensionModuleCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(extensionModuleCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
	});

	it("validates SSH host entries", () => {
		const valid: SSHHost = { name: "prod", host: "prod.example.com", _source: source };

		expect(sshCapability.key(valid)).toBe("prod");
		expect(sshCapability.validate?.(valid)).toBeUndefined();
		expect(sshCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(sshCapability.validate?.({ ...valid, host: "" })).toBe("Missing host");
	});

	it("validates system prompt files", () => {
		const valid: SystemPrompt = { path: "/tmp/SYSTEM.md", content: "Be precise", level: "project", _source: source };

		expect(systemPromptCapability.key(valid)).toBe("project");
		expect(systemPromptCapability.validate?.(valid)).toBeUndefined();
		expect(systemPromptCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
		expect(systemPromptCapability.validate?.({ ...valid, content: undefined as unknown as string })).toBe(
			"Missing content",
		);
	});

	it("deduplicates context files by source scope and validates content", () => {
		const project: ContextFile = {
			path: "/repo/AGENTS.md",
			content: "Project rules",
			level: "project",
			depth: 2,
			_source: source,
		};
		const user: ContextFile = {
			...project,
			path: "/home/user/AGENTS.md",
			level: "user",
			depth: undefined,
		};

		expect(contextFileCapability.key(project)).toBe("project:2");
		expect(contextFileCapability.key({ ...project, depth: -1 })).toBe("project:0");
		expect(contextFileCapability.key(user)).toBe("user");
		expect(contextFileCapability.toExtensionId?.(project)).toBe("context-file:project:AGENTS.md");
		expect(contextFileCapability.validate?.(project)).toBeUndefined();
		expect(contextFileCapability.validate?.({ ...project, path: "" })).toBe("Missing path");
		expect(contextFileCapability.validate?.({ ...project, content: undefined as unknown as string })).toBe(
			"Missing content",
		);
		expect(contextFileCapability.validate?.({ ...project, level: "workspace" as "project" })).toBe(
			"Invalid level: must be 'user' or 'project'",
		);
	});

	it("validates custom tool entries and extension ids", () => {
		const valid: CustomTool = {
			name: "deploy",
			path: "/tmp/deploy.json",
			description: "Deploy service",
			level: "project",
			_source: source,
		};

		expect(toolCapability.key(valid)).toBe("deploy");
		expect(toolCapability.toExtensionId?.(valid)).toBe("tool:deploy");
		expect(toolCapability.validate?.(valid)).toBeUndefined();
		expect(toolCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(toolCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
	});

	it("validates skill entries and extension ids", () => {
		const valid: Skill = {
			name: "diagnose",
			path: "/tmp/diagnose/SKILL.md",
			content: "Diagnose failures",
			level: "project",
			_source: source,
		};

		expect(skillCapability.key(valid)).toBe("diagnose");
		expect(skillCapability.toExtensionId?.(valid)).toBe("skill:diagnose");
		expect(skillCapability.validate?.(valid)).toBeUndefined();
		expect(skillCapability.validate?.({ ...valid, name: "" })).toBe("Missing skill name");
		expect(skillCapability.validate?.({ ...valid, path: "" })).toBe("Missing skill path");
	});

	it("validates hook entries and extension ids", () => {
		const valid: Hook = {
			name: "audit",
			path: "/tmp/audit.sh",
			type: "pre",
			tool: "*",
			level: "project",
			_source: source,
		};

		expect(hookCapability.key(valid)).toBe("pre:*:audit");
		expect(hookCapability.toExtensionId?.(valid)).toBe("hook:pre:*:audit");
		expect(hookCapability.validate?.(valid)).toBeUndefined();
		expect(hookCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(hookCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
		expect(hookCapability.validate?.({ ...valid, type: "during" })).toBe("Invalid type (must be 'pre' or 'post')");
		expect(hookCapability.validate?.({ ...valid, tool: "" })).toBe("Missing tool");
	});

	it("validates instruction entries and extension ids", () => {
		const valid: Instruction = { name: "style", path: "/tmp/style.md", content: "Use tabs", _source: source };

		expect(instructionCapability.key(valid)).toBe("style");
		expect(instructionCapability.toExtensionId?.(valid)).toBe("instruction:style");
		expect(instructionCapability.validate?.(valid)).toBeUndefined();
		expect(instructionCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(instructionCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
		expect(instructionCapability.validate?.({ ...valid, content: undefined })).toBe("Missing content");
	});

	it("validates prompt entries and extension ids", () => {
		const valid: Prompt = { name: "review", path: "/tmp/review.md", content: "Review this", _source: source };

		expect(promptCapability.key(valid)).toBe("review");
		expect(promptCapability.toExtensionId?.(valid)).toBe("prompt:review");
		expect(promptCapability.validate?.(valid)).toBeUndefined();
		expect(promptCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(promptCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
		expect(promptCapability.validate?.({ ...valid, content: undefined })).toBe("Missing content");
	});

	it("validates slash command entries and extension ids", () => {
		const valid: SlashCommand = {
			name: "audit",
			path: "/tmp/audit.md",
			content: "Audit this",
			level: "project",
			_source: source,
		};

		expect(slashCommandCapability.key(valid)).toBe("audit");
		expect(slashCommandCapability.toExtensionId?.(valid)).toBe("slash-command:audit");
		expect(slashCommandCapability.validate?.(valid)).toBeUndefined();
		expect(slashCommandCapability.validate?.({ ...valid, name: "" })).toBe("Missing name");
		expect(slashCommandCapability.validate?.({ ...valid, path: "" })).toBe("Missing path");
		expect(slashCommandCapability.validate?.({ ...valid, content: undefined })).toBe("Missing content");
		expect(slashCommandCapability.validate?.({ ...valid, level: "workspace" as "project" })).toBe(
			"Invalid level: must be 'user', 'project', or 'native'",
		);
	});

	it("validates MCP endpoint requirements by transport", () => {
		const stdio: MCPServer = { name: "local", command: "tool-server", transport: "stdio", _source: source };
		const http: MCPServer = { name: "remote", url: "https://example.com/mcp", transport: "http", _source: source };

		expect(mcpCapability.key(stdio)).toBe("local");
		expect(mcpCapability.toExtensionId?.(stdio)).toBe("mcp:local");
		expect(mcpCapability.validate?.(stdio)).toBeUndefined();
		expect(mcpCapability.validate?.(http)).toBeUndefined();
		expect(mcpCapability.validate?.({ ...stdio, name: "" })).toBe("Missing server name");
		expect(mcpCapability.validate?.({ ...stdio, command: "" })).toBe("Must have command or url");
		expect(mcpCapability.validate?.({ ...http, transport: "sse", url: "" })).toBe("Must have command or url");
		expect(mcpCapability.validate?.({ ...http, transport: "stdio" })).toBe("stdio transport requires command field");
		expect(mcpCapability.validate?.({ ...stdio, transport: "http" })).toBe("http/sse transport requires url field");
	});
});
