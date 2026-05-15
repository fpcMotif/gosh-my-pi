import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class TempDir {
	#path: string;
	private constructor(path: string) {
		this.#path = path;
	}

	static createSync(prefix?: string): TempDir {
		return new TempDir(fs.mkdtempSync(normalizePrefix(prefix)));
	}

	static async create(prefix?: string): Promise<TempDir> {
		return new TempDir(await fs.promises.mkdtemp(normalizePrefix(prefix)));
	}

	#removePromise: Promise<void> | null = null;

	path(): string {
		return this.#path;
	}

	absolute(): string {
		return path.resolve(this.#path);
	}

	remove(): Promise<void> {
		if (this.#removePromise) {
			return this.#removePromise;
		}
		const removePromise = fs.promises.rm(this.#path, { recursive: true, force: true });
		this.#removePromise = removePromise;
		return removePromise;
	}

	removeSync(): void {
		// On Windows, `fs.rmSync({ force: true })` can still surface EBUSY
		// when a sibling like bun:sqlite holds the file handle past `close()`
		// return; the kernel releases on its own clock, not ours. We retry
		// briefly, then fall through to `cmd.exe /c rd /s /q` which uses
		// the WIN32 RemoveDirectory APIs (different lock semantics than the
		// libuv path) as the last-resort. Non-Windows uses one rmSync call.
		if (process.platform !== "win32") {
			fs.rmSync(this.#path, { recursive: true, force: true });
			this.#removePromise = Promise.resolve();
			return;
		}
		const maxAttempts = 6;
		let lastError: unknown;
		for (let i = 0; i < maxAttempts; i += 1) {
			try {
				fs.rmSync(this.#path, { recursive: true, force: true });
				this.#removePromise = Promise.resolve();
				return;
			} catch (err) {
				lastError = err;
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
					throw err;
				}
				const deadline = Date.now() + 250;
				while (Date.now() < deadline) {
					// busy-wait: removeSync is called from `using` / `Disposable`
					// contracts where async would change the contract.
				}
			}
		}
		try {
			// `cmd.exe /c rd /s /q` uses WIN32 RemoveDirectoryW / DeleteFileW
			// directly; it has different (more forgiving) lock semantics than
			// the libuv path that fs.rmSync rides on under Bun on Windows.
			execSync(`cmd.exe /c rd /s /q "${this.#path}"`, { stdio: "ignore" });
			this.#removePromise = Promise.resolve();
			return;
		} catch {
			// Fall through to throw the last fs error.
		}
		throw lastError;
	}

	toString(): string {
		return this.#path;
	}

	join(...paths: string[]): string {
		return path.join(this.#path, ...paths);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.remove();
		} catch {
			// Ignore cleanup errors
		}
	}

	[Symbol.dispose](): void {
		try {
			this.removeSync();
		} catch {
			// Ignore cleanup errors
		}
	}
}

const kTempDir = os.tmpdir();

function normalizePrefix(prefix?: string): string {
	if (prefix === null || prefix === undefined || prefix === "") {
		return `${kTempDir}${path.sep}pi-temp-`;
	} else if (prefix.startsWith("@")) {
		return path.join(kTempDir, prefix.slice(1));
	}
	return prefix;
}
