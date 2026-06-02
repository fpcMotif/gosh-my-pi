import { afterEach, describe, expect, it, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../src/tools/fs-cache-invalidation";

describe("filesystem scan cache invalidation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("invalidates writes, deletes, and both sides of real renames", () => {
		const invalidate = vi.spyOn(natives, "invalidateFsScanCache").mockImplementation(() => {});

		invalidateFsScanAfterWrite("/repo/file.txt");
		invalidateFsScanAfterDelete("/repo/old.txt");
		invalidateFsScanAfterRename("/repo/a.txt", "/repo/b.txt");
		invalidateFsScanAfterRename("/repo/same.txt", "/repo/same.txt");

		expect(invalidate.mock.calls).toEqual([
			["/repo/file.txt"],
			["/repo/old.txt"],
			["/repo/a.txt"],
			["/repo/b.txt"],
			["/repo/same.txt"],
		]);
	});
});
