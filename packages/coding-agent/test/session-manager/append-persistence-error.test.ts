import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const RENAME_FAILURE = "atomic rename failed";

class RenameFailStorage extends MemorySessionStorage {
	override rename(_path: string, _nextPath: string): Promise<void> {
		return Promise.reject(new Error(RENAME_FAILURE));
	}
}

describe("SessionManager append persistence preflight", () => {
	it("keeps entries and leaf unchanged after a latched persistence failure", async () => {
		const storage = new RenameFailStorage();
		const session = SessionManager.create("/workspace", "/sessions", storage);
		const branchFromId = session.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		const originalLeafId = session.appendMessage({ role: "user", content: "current leaf", timestamp: 2 });

		await expect(session.rewriteEntries()).rejects.toThrow(RENAME_FAILURE);
		await expect(session.flush()).rejects.toThrow(RENAME_FAILURE);

		const entriesBefore = structuredClone(session.getEntries());
		expect(session.getLeafId()).toBe(originalLeafId);

		expect(() => session.appendMessage({ role: "user", content: "rejected append", timestamp: 3 })).toThrow(
			RENAME_FAILURE,
		);
		expect(session.getEntries()).toEqual(entriesBefore);
		expect(session.getLeafId()).toBe(originalLeafId);

		expect(() => session.branchWithSummary(branchFromId, "rejected summary")).toThrow(RENAME_FAILURE);
		expect(session.getEntries()).toEqual(entriesBefore);
		expect(session.getLeafId()).toBe(originalLeafId);
	});
});
