import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface RunCliOptions {
	agentDir?: string;
}

const EMPTY_PROVIDER_ENV = {
	AI_GATEWAY_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	ANTHROPIC_OAUTH_TOKEN: "",
	AWS_ACCESS_KEY_ID: "",
	AWS_PROFILE: "",
	AWS_SECRET_ACCESS_KEY: "",
	AZURE_OPENAI_API_KEY: "",
	CEREBRAS_API_KEY: "",
	COPILOT_GITHUB_TOKEN: "",
	CURSOR_ACCESS_TOKEN: "",
	GEMINI_API_KEY: "",
	GH_TOKEN: "",
	GITHUB_TOKEN: "",
	GOOGLE_APPLICATION_CREDENTIALS: "",
	GOOGLE_CLOUD_PROJECT: "",
	GROQ_API_KEY: "",
	KILO_API_KEY: "",
	MINIMAX_API_KEY: "",
	MISTRAL_API_KEY: "",
	OPENCODE_API_KEY: "",
	OPENAI_API_KEY: "",
	OPENROUTER_API_KEY: "",
	XAI_API_KEY: "",
	ZAI_API_KEY: "",
} as const;

const packageDir = path.join(import.meta.dir, "..");
const cliPath = path.join(packageDir, "src", "cli.ts");
const nativeAddonDir = path.join(packageDir, "..", "natives", "native");
const nativeAddonTag = `${process.platform}-${process.arch}`;
const nativeAddonPaths = [
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}.node`),
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}-baseline.node`),
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}-modern.node`),
];

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

async function hasNativeAddon(): Promise<boolean> {
	for (const nativeAddonPath of nativeAddonPaths) {
		try {
			await fs.stat(nativeAddonPath);
			return true;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	return false;
}

const nativeAddonAvailable = await hasNativeAddon();

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cli-e2e-"));
	try {
		return await fn(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
	const run = async (agentDir: string): Promise<CliResult> => {
		const proc = Bun.spawn([process.execPath, cliPath, ...args], {
			cwd: packageDir,
			env: {
				...Bun.env,
				...EMPTY_PROVIDER_ENV,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { exitCode, stdout, stderr };
	};

	if (options.agentDir !== null && options.agentDir !== undefined && options.agentDir !== "") {
		return await run(options.agentDir);
	}
	return await withTempAgentDir(run);
}

function parseJson<T>(result: CliResult): T {
	return JSON.parse(result.stdout) as T;
}

describe("CLI e2e", () => {
	test("--version prints the package version without starting a session", async () => {
		const result = await runCli(["--version"]);
		const binaryName = Object.keys(packageJson.bin)[0] ?? "gmp";

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(`${binaryName}/${packageJson.version}`);
		expect(result.stderr).toBe("");
	});
});

describe.skipIf(!nativeAddonAvailable)("CLI help e2e", () => {
	test("--help renders root help and provider setup guidance", async () => {
		const result = await runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Environment Variables:");
		expect(result.stdout).toContain("ANTHROPIC_API_KEY");
		expect(result.stdout).toContain("OPENAI_API_KEY");
		expect(result.stderr).toBe("");
	});

	test("subcommand help loads without provider credentials", async () => {
		const result = await runCli(["stats", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("View usage statistics");
		expect(result.stdout).toContain("--summary");
		expect(result.stderr).toBe("");
	});
});

describe.skipIf(!nativeAddonAvailable)("CLI config e2e", () => {
	test("config path respects PI_CODING_AGENT_DIR isolation", async () => {
		await withTempAgentDir(async agentDir => {
			const result = await runCli(["config", "path"], { agentDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(agentDir);
			expect(result.stderr).toBe("");
		});
	});

	test("config list --json exposes schema-backed settings without credentials", async () => {
		const result = await runCli(["config", "list", "--json"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const parsed = parseJson<Record<string, { value: unknown; type: string; description: string }>>(result);
		expect(parsed.enabledModels.type).toBe("array");
		expect(parsed.modelRoles.type).toBe("record");
		expect(parsed["compaction.enabled"].type).toBe("boolean");
	});

	test("config set/get persists across separate CLI processes", async () => {
		await withTempAgentDir(async agentDir => {
			const setResult = await runCli(["config", "set", "compaction.enabled", "off", "--json"], { agentDir });
			const getResult = await runCli(["config", "get", "compaction.enabled", "--json"], { agentDir });

			expect(setResult.exitCode).toBe(0);
			expect(setResult.stderr).toBe("");
			expect(getResult.exitCode).toBe(0);
			expect(getResult.stderr).toBe("");
			expect(parseJson<{ key: string; value: unknown; type: string }>(getResult)).toMatchObject({
				key: "compaction.enabled",
				type: "boolean",
				value: false,
			});
		});
	});

	test("config reset restores schema defaults through the full CLI", async () => {
		await withTempAgentDir(async agentDir => {
			const setResult = await runCli(["config", "set", "compaction.enabled", "false", "--json"], { agentDir });
			const resetResult = await runCli(["config", "reset", "compaction.enabled", "--json"], { agentDir });
			const getResult = await runCli(["config", "get", "compaction.enabled", "--json"], { agentDir });

			expect(setResult.exitCode).toBe(0);
			expect(resetResult.exitCode).toBe(0);
			expect(resetResult.stderr).toBe("");
			expect(getResult.exitCode).toBe(0);
			expect(parseJson<{ key: string; value: unknown }>(resetResult)).toEqual({
				key: "compaction.enabled",
				value: true,
			});
			expect(parseJson<{ value: unknown }>(getResult).value).toBe(true);
		});
	});

	test("config set rejects invalid enum values without overwriting the previous value", async () => {
		await withTempAgentDir(async agentDir => {
			const validResult = await runCli(["config", "set", "compaction.strategy", "handoff", "--json"], { agentDir });
			const invalidResult = await runCli(["config", "set", "compaction.strategy", "bogus", "--json"], { agentDir });
			const getResult = await runCli(["config", "get", "compaction.strategy", "--json"], { agentDir });

			expect(validResult.exitCode).toBe(0);
			expect(invalidResult.exitCode).not.toBe(0);
			expect(invalidResult.stdout).toBe("");
			expect(invalidResult.stderr).toContain("Invalid value: bogus");
			expect(invalidResult.stderr).toContain("context-full, handoff, off");
			expect(getResult.exitCode).toBe(0);
			expect(parseJson<{ value: unknown }>(getResult).value).toBe("handoff");
		});
	});
});
