import { describe, expect, test } from "bun:test";
import { readLines } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type RpcResponseFrame = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: object;
};

type RpcExtensionInputFrame = {
	type: "extension_ui_request";
	id: string;
	method: "input";
};

const packageDir = path.resolve(import.meta.dir, "..", "..", "..");
const cliPath = path.join(packageDir, "src", "cli.ts");
const nativeAddonDir = path.join(packageDir, "..", "natives", "native");
const nativeAddonTag = `${process.platform}-${process.arch}`;
const nativeAddonPaths = [
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}.node`),
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}-baseline.node`),
	path.join(nativeAddonDir, `pi_natives.${nativeAddonTag}-modern.node`),
];

function isResponseFrame(value: unknown): value is RpcResponseFrame {
	if (value === null || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	return (
		frame.type === "response" &&
		typeof frame.command === "string" &&
		typeof frame.success === "boolean" &&
		(frame.id === undefined || typeof frame.id === "string")
	);
}

function isExtensionInputFrame(value: unknown): value is RpcExtensionInputFrame {
	if (value === null || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	return frame.type === "extension_ui_request" && frame.method === "input" && typeof frame.id === "string";
}

async function waitForFrame<T>(frames: readonly unknown[], guard: (frame: unknown) => frame is T): Promise<T> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const frame = frames.find(guard);
		if (frame !== undefined) return frame;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for RPC frame");
}

async function waitForResponseCount(frames: readonly unknown[], expected: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (frames.filter(isResponseFrame).length >= expected) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for RPC responses");
}

async function hasNativeAddon(): Promise<boolean> {
	for (const nativeAddonPath of nativeAddonPaths) {
		try {
			await fs.stat(nativeAddonPath);
			return true;
		} catch (error) {
			if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue;
			throw error;
		}
	}
	return false;
}

const nativeAddonAvailable = await hasNativeAddon();

async function runRpc(commands: readonly object[]): Promise<{ exitCode: number; stderr: string; frames: unknown[] }> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rpc-transport-"));
	try {
		const child = Bun.spawn([process.execPath, cliPath, "--mode", "rpc"], {
			cwd: packageDir,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "",
				NO_COLOR: "1",
				OPENAI_API_KEY: "test-key",
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const frames: unknown[] = [];
		const stdoutDone = (async (): Promise<void> => {
			for await (const line of readLines(child.stdout as ReadableStream<Uint8Array>)) {
				frames.push(JSON.parse(new TextDecoder().decode(line)));
			}
		})();
		const stderr = new Response(child.stderr).text();
		let stdinClosed = false;
		try {
			for (const command of commands) {
				child.stdin.write(`${JSON.stringify(command)}\n`);
			}
			await waitForResponseCount(frames, commands.length);
			child.stdin.end();
			stdinClosed = true;
			const [stderrText, exitCode] = await Promise.all([stderr, child.exited]);
			await stdoutDone;
			return { exitCode, stderr: stderrText, frames };
		} finally {
			if (!stdinClosed) child.stdin.end();
			await Promise.all([child.exited, stdoutDone, stderr]);
		}
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe.skipIf(!nativeAddonAvailable)("RPC stdin dispatcher", () => {
	test("routes a startup dialog reply before executing queued commands", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rpc-startup-duplex-"));
		const extensionPath = path.join(agentDir, "startup-input.ts");
		await Bun.write(
			extensionPath,
			`export default function(pi) {
	pi.on("session_start", async (_event, ctx) => {
		const name = await ctx.ui.input("Name");
		if (name !== undefined) await pi.setSessionName(name);
	});
}
`,
		);

		const child = Bun.spawn([process.execPath, cliPath, "--mode", "rpc", "--extension", extensionPath], {
			cwd: packageDir,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "",
				NO_COLOR: "1",
				OPENAI_API_KEY: "test-key",
				PI_CODING_AGENT_DIR: agentDir,
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const frames: unknown[] = [];
		const stdoutDone = (async (): Promise<void> => {
			for await (const line of readLines(child.stdout as ReadableStream<Uint8Array>)) {
				frames.push(JSON.parse(new TextDecoder().decode(line)));
			}
		})();
		const stderr = new Response(child.stderr).text();
		let stdinClosed = false;

		try {
			const inputRequest = await waitForFrame(frames, isExtensionInputFrame);
			child.stdin.write(`${JSON.stringify({ id: "queued-state", type: "get_state" })}\n`);

			child.stdin.write(
				`${JSON.stringify({ type: "extension_ui_response", id: inputRequest.id, value: "duplex-name" })}\n`,
			);
			const stateResponse = await waitForFrame(
				frames,
				(frame): frame is RpcResponseFrame => isResponseFrame(frame) && frame.id === "queued-state",
			);
			expect(stateResponse.success).toBe(true);
			expect(stateResponse.data).toMatchObject({ sessionName: "duplex-name" });

			child.stdin.end();
			stdinClosed = true;
			const [exitCode, stderrText] = await Promise.all([child.exited, stderr]);
			await stdoutDone;
			expect(exitCode).toBe(0);
			expect(stderrText).toBe("");
		} finally {
			if (!stdinClosed) child.stdin.end();
			await Promise.all([child.exited, stdoutDone, stderr]);
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("reports malformed envelopes without losing the next valid command", async () => {
		const result = await runRpc([
			{ id: 19, type: "get_state" },
			{ id: "valid-state", type: "get_state" },
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const responses = result.frames.filter(isResponseFrame);
		expect(responses).toContainEqual({
			type: "response",
			command: "parse",
			success: false,
			error: "Failed to parse command: expected object with string type and optional string id",
		});
		expect(responses.find(response => response.id === "valid-state")).toMatchObject({
			id: "valid-state",
			type: "response",
			command: "get_state",
			success: true,
		});
	});

	test("correlates known handler failures but preserves v1 unknown-command behavior", async () => {
		const result = await runRpc([
			{
				id: "handler-failure",
				type: "set_host_tools",
				tools: [{ name: "", description: "invalid", parameters: {} }],
			},
			{ id: "unknown-command", type: "future.command" },
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const responses = result.frames.filter(isResponseFrame);
		expect(responses).toContainEqual({
			id: "handler-failure",
			type: "response",
			command: "set_host_tools",
			success: false,
			error: "Command execution failed: Host tool at index 0 must provide a non-empty name",
		});
		expect(responses).toContainEqual({
			type: "response",
			command: "future.command",
			success: false,
			error: "Unknown command: future.command",
		});
	});
});
