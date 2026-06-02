import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readEditFileText } from "../../src/edit/read-file";

describe("readEditFileText", () => {
	it("reads UTF-8 text and maps missing files to the display path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-file-"));
		const file = path.join(dir, "sample.txt");
		await Bun.write(file, "hello");

		await expect(readEditFileText(file, "sample.txt")).resolves.toBe("hello");
		await expect(readEditFileText(path.join(dir, "missing.txt"), "shown/missing.txt")).rejects.toThrow(
			"File not found: shown/missing.txt",
		);
	});

	it("rethrows non-missing read errors without remapping them to a not-found message", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-dir-"));

		await expect(readEditFileText(dir, "shown/dir")).rejects.not.toThrow("File not found: shown/dir");
	});
});
