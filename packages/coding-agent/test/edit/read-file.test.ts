import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readEditFileText } from "../../src/edit/read-file";

let tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-file-"));
	tempDirs.push(dir);
	return dir;
}

describe("readEditFileText", () => {
	it("reads files as utf8 text", async () => {
		const dir = await makeTempDir();
		const filePath = path.join(dir, "note.txt");
		await Bun.write(filePath, "hello\n");

		await expect(readEditFileText(filePath, "note.txt")).resolves.toBe("hello\n");
	});

	it("maps missing files to a display-path error", async () => {
		const dir = await makeTempDir();

		await expect(readEditFileText(path.join(dir, "missing.txt"), "shown/path.txt")).rejects.toThrow(
			"File not found: shown/path.txt",
		);
	});

	it("rethrows non-missing filesystem errors", async () => {
		const dir = await makeTempDir();

		await expect(readEditFileText(dir, "directory")).rejects.toThrow();
	});
});
