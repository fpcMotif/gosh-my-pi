/**
 * TempDir lifecycle / leak coverage.
 *
 * Defends:
 *  - Repeated remove() returns the same promise (no new fs.rm() invoked).
 *  - removeSync() is idempotent and tolerates already-deleted directories.
 *  - Symbol.dispose / Symbol.asyncDispose hooks behave the same as remove().
 *  - Many rapid create/remove cycles complete without throwing.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

type SpawnSyncForTest = (
	cmd: string[],
	options?: Bun.SpawnOptions.SpawnSyncOptions<"ignore", "ignore", "ignore">,
) => Bun.SyncSubprocess<"ignore", "ignore">;

function replaceProcessPlatform(platform: NodeJS.Platform): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	return () => {
		if (descriptor) {
			Object.defineProperty(process, "platform", descriptor);
		}
	};
}

describe("TempDir lifecycle", () => {
	it("creates a real directory and removes it", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		expect(fs.existsSync(dir.path())).toBe(true);
		await dir.remove();
		expect(fs.existsSync(dir.path())).toBe(false);
	});

	it("remove() is memoized — repeated invocations return the same promise", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		const first = dir.remove();
		const second = dir.remove();
		expect(first).toBe(second);
		await first;
		expect(fs.existsSync(dir.path())).toBe(false);
	});

	it("removeSync() is idempotent on already-removed directories", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		dir.removeSync();
		expect(() => dir.removeSync()).not.toThrow();
		expect(fs.existsSync(dir.path())).toBe(false);
	});

	it("removeSync() rethrows the original Windows cleanup error", async () => {
		const dir = TempDir.createSync("@pi-temp-e2e-");
		const restorePlatform = replaceProcessPlatform("win32");
		try {
			const rmError = Object.assign(new Error("access denied"), { code: "EACCES" });
			vi.spyOn(fs, "rmSync").mockImplementation(() => {
				throw rmError;
			});

			let thrown: unknown;
			try {
				dir.removeSync();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBe(rmError);
		} finally {
			restorePlatform();
			vi.restoreAllMocks();
			fs.rmSync(dir.path(), { recursive: true, force: true });
		}
	});

	it("removeSync() uses an argv fallback after retryable Windows cleanup errors", async () => {
		const dir = TempDir.createSync("@pi-temp-e2e-");
		const restorePlatform = replaceProcessPlatform("win32");
		try {
			let now = 0;
			vi.spyOn(Date, "now").mockImplementation(() => {
				now += 300;
				return now;
			});
			let rmCalls = 0;
			const rmError = Object.assign(new Error("busy"), { code: "EBUSY" });
			vi.spyOn(fs, "rmSync").mockImplementation(() => {
				rmCalls += 1;
				throw rmError;
			});

			const spawnCalls: string[][] = [];
			const originalSpawnSync: SpawnSyncForTest = (cmd, options) => Bun.spawnSync(cmd, options);
			const bunForTest = Bun as { spawnSync: SpawnSyncForTest };
			vi.spyOn(bunForTest, "spawnSync").mockImplementation((cmd, options) => {
				spawnCalls.push([...cmd]);
				return originalSpawnSync(["true"], options);
			});

			dir.removeSync();

			expect(rmCalls).toBe(6);
			expect(spawnCalls).toEqual([["cmd.exe", "/c", "rd", "/s", "/q", dir.path()]]);
		} finally {
			restorePlatform();
			vi.restoreAllMocks();
			fs.rmSync(dir.path(), { recursive: true, force: true });
		}
	});

	it("Symbol.asyncDispose tears down the directory", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		const path = dir.path();
		await dir[Symbol.asyncDispose]();
		expect(fs.existsSync(path)).toBe(false);
	});

	it("Symbol.dispose tears down the directory synchronously", async () => {
		const dir = TempDir.createSync("@pi-temp-e2e-");
		const path = dir.path();
		dir[Symbol.dispose]();
		expect(fs.existsSync(path)).toBe(false);
	});

	it("100 rapid create + remove cycles complete cleanly", async () => {
		async function cycle(remaining: number): Promise<void> {
			if (remaining <= 0) return;
			const dir = await TempDir.create("@pi-temp-e2e-rapid-");
			await dir.remove();
			await cycle(remaining - 1);
		}
		await cycle(100);
	});

	it("path() and absolute() return consistent strings during the directory's lifetime", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		try {
			expect(dir.path().length).toBeGreaterThan(0);
			expect(dir.absolute().endsWith(dir.path().split("/").pop() ?? "")).toBe(true);
			expect(`${String(dir)}`).toBe(dir.path());
		} finally {
			await dir.remove();
		}
	});

	it("join() composes paths under the temp directory without escaping", async () => {
		const dir = await TempDir.create("@pi-temp-e2e-");
		try {
			const inside = dir.join("a", "b", "c.txt");
			expect(inside.startsWith(dir.path())).toBe(true);
		} finally {
			await dir.remove();
		}
	});
});
