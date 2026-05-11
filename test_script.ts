import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const packageDir = path.join(import.meta.dir, "packages/coding-agent");
const cliPath = path.join(packageDir, "src", "cli.ts");

async function withTempAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cli-stream-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function runCli(args: string[], agentDir: string): Promise<CliResult> {
	const proc = Bun.spawn([process.execPath, cliPath, ...args], {
		cwd: packageDir,
		env: {
			...Bun.env,
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
}

const outputs = await runCli(["--version"], "dummy");
console.log(outputs);
