import * as fs from "node:fs";
import path from "node:path";
import * as timers from "node:timers";
import type { Subprocess } from "bun";
import { $env } from "./env";
import { $which } from "./which";

export interface ShellConfig {
	shell: string;
	args: string[];
	env: Record<string, string>;
	prefix: string | undefined;
}

let cachedShellConfig: ShellConfig | null = null;

const IS_WINDOWS = process.platform === "win32";
const TERM_SIGNAL = IS_WINDOWS ? undefined : "SIGTERM";

/**
 * Check if a shell binary is executable.
 */
function isExecutable(path: string): boolean {
	try {
		fs.accessSync(path, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the spawn environment (cached).
 */
function buildSpawnEnv(shell: string): Record<string, string> {
	const noCI = $env.PI_BASH_NO_CI || $env.CLAUDE_BASH_NO_CI;
	return {
		...Bun.env,
		SHELL: shell,
		GIT_EDITOR: "true",
		GPG_TTY: "not a tty",
		OMPCODE: "1",
		CLAUDECODE: "1",
		...(noCI ? {} : { CI: "true" }),
	};
}

/**
 * Get shell args, optionally including login shell flag.
 * Supports PI_BASH_NO_LOGIN and CLAUDE_BASH_NO_LOGIN to skip -l.
 */
function getShellArgs(): string[] {
	const noLogin = $env.PI_BASH_NO_LOGIN || $env.CLAUDE_BASH_NO_LOGIN;
	return noLogin ? ["-c"] : ["-l", "-c"];
}

/**
 * Get shell prefix for wrapping commands (profilers, strace, etc.).
 */
function getShellPrefix(): string | undefined {
	return $env.PI_SHELL_PREFIX || $env.CLAUDE_CODE_SHELL_PREFIX;
}

/**
 * Build full shell config from a shell path.
 */
function buildConfig(shell: string): ShellConfig {
	return {
		shell,
		args: getShellArgs(),
		env: buildSpawnEnv(shell),
		prefix: getShellPrefix(),
	};
}

/**
 * Resolve a basic shell (bash or sh) as fallback.
 */
export function resolveBasicShell(): string | undefined {
	for (const name of ["bash", "bash.exe", "sh", "sh.exe"]) {
		const resolved = $which(name);
		if (resolved !== null && resolved !== undefined && resolved !== "") return resolved;
	}

	if (process.platform !== "win32") {
		const searchPaths = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
		const candidates = ["bash", "sh"];

		for (const name of candidates) {
			for (const dir of searchPaths) {
				const fullPath = path.join(dir, name);
				if (fs.existsSync(fullPath)) return fullPath;
			}
		}
	}

	return undefined;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: $SHELL if bash/zsh, then fallback paths
 * 4. Fallback: sh
 */
function isStringSet(s: string | null | undefined): s is string {
	return s !== null && s !== undefined && s !== "";
}

function tryCustomShellPath(customShellPath: string | undefined): ShellConfig | undefined {
	if (!isStringSet(customShellPath)) return undefined;
	if (fs.existsSync(customShellPath)) return buildConfig(customShellPath);
	throw new Error(
		`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ~/.omp/agent/settings.json`,
	);
}

function resolveWindowsShell(): ShellConfig {
	const paths: string[] = [];
	if (isStringSet(Bun.env.ProgramFiles)) paths.push(`${Bun.env.ProgramFiles}\\Git\\bin\\bash.exe`);
	if (isStringSet(Bun.env["ProgramFiles(x86)"])) paths.push(`${Bun.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);

	for (const path of paths) {
		if (fs.existsSync(path)) return buildConfig(path);
	}

	const bashOnPath = $which("bash.exe");
	if (isStringSet(bashOnPath)) return buildConfig(bashOnPath);

	throw new Error(
		`No bash shell found. Options:\n` +
			`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
			`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
			`  3. Set shellPath in ~/.omp/agent/settings.json\n\n` +
			`Searched Git Bash in:\n${paths.map(p => `  ${p}`).join("\n")}`,
	);
}

function resolveUnixShell(): ShellConfig {
	const userShell = Bun.env.SHELL;
	if (isStringSet(userShell) && (userShell.includes("bash") || userShell.includes("zsh")) && isExecutable(userShell)) {
		return buildConfig(userShell);
	}
	const basicShell = resolveBasicShell();
	if (isStringSet(basicShell)) return buildConfig(basicShell);
	return buildConfig("sh");
}

export function getShellConfig(customShellPath?: string): ShellConfig {
	if (cachedShellConfig) return cachedShellConfig;

	const custom = tryCustomShellPath(customShellPath);
	if (custom !== undefined) {
		cachedShellConfig = custom;
		return cachedShellConfig;
	}

	cachedShellConfig = process.platform === "win32" ? resolveWindowsShell() : resolveUnixShell();
	return cachedShellConfig;
}

/**
 * Function signature for native process tree killing.
 * Returns the number of processes killed.
 */
export type KillTreeFn = (pid: number, signal: number) => number;

/**
 * Global native kill tree function, injected by pi-natives when loaded.
 * Falls back to platform-specific behavior if not set.
 */
export let nativeKillTree: KillTreeFn | undefined;

/**
 * Set the native kill tree function. Called by pi-natives on load.
 */
export function setNativeKillTree(fn: KillTreeFn): void {
	nativeKillTree = fn;
}

/**
 * Options for terminating a process and all its descendants.
 */
export interface TerminateOptions {
	/** The process to terminate */
	target: Subprocess | number;
	/** Whether to terminate the process tree (all descendants) */
	group?: boolean;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Abort signal */
	signal?: AbortSignal;
}

/**
 * Check if a process is running.
 */
export function isPidRunning(pid: number | Subprocess): boolean {
	try {
		if (typeof pid === "number") {
			process.kill(pid, 0);
		} else {
			if (pid.killed) return false;
			if (pid.exitCode !== null) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function joinSignals(...sigs: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
	const nn = sigs.filter(Boolean) as AbortSignal[];
	if (nn.length === 0) return undefined;
	if (nn.length === 1) return nn[0];
	return AbortSignal.any(nn);
}

export function onProcessExit(proc: Subprocess | number, abortSignal?: AbortSignal): Promise<boolean> {
	if (typeof proc !== "number") {
		return proc.exited.then(
			() => true,
			() => true,
		);
	}

	if (!isPidRunning(proc)) {
		return Promise.resolve(true);
	}

	const { promise, resolve, reject } = Promise.withResolvers<boolean>();
	const localAbortController = new AbortController();

	const timer = timers.promises.setInterval(300, null, {
		signal: joinSignals(abortSignal, localAbortController.signal),
	});
	void (async () => {
		try {
			for await (const _ of timer) {
				if (!isPidRunning(proc)) {
					resolve(true);
					break;
				}
			}
		} catch (error) {
			return reject(error);
		} finally {
			localAbortController.abort();
		}
		resolve(false);
	})();

	return promise;
}

/**
 * Terminate a process and all its descendants.
 */
function sendTerminationSignal(target: TerminateOptions["target"], sig: NodeJS.Signals | number): void {
	try {
		if (typeof target === "number") {
			process.kill(target, sig);
		} else {
			target.kill(sig);
		}
	} catch {}
}

function killProcessTree(target: TerminateOptions["target"], pid: number | undefined, group: boolean): void {
	if (nativeKillTree && pid !== undefined) {
		nativeKillTree(pid, 9);
		return;
	}
	if (group && !IS_WINDOWS && pid !== undefined) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
	sendTerminationSignal(target, "SIGKILL");
}

export async function terminate(options: TerminateOptions): Promise<boolean> {
	const { target, group = false, timeout = 5000, signal } = options;

	const abortController = new AbortController();
	try {
		const abortSignal = joinSignals(signal, abortController.signal);
		const exitPromise = onProcessExit(target, abortSignal);

		const pid = typeof target === "number" ? target : target.pid;
		if (typeof target !== "number" && target.killed) return true;

		// Give it a moment to exit gracefully first.
		sendTerminationSignal(target, TERM_SIGNAL);
		if (exitPromise !== undefined) {
			const exited = await Promise.race([Bun.sleep(1000).then(() => false), exitPromise]);
			if (exited) return true;
		}

		killProcessTree(target, pid, group);

		return await Promise.race([Bun.sleep(timeout).then(() => false), exitPromise]);
	} finally {
		abortController.abort();
	}
}
