import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import type { ToolSession } from "../../src/tools";
import { ToolError } from "../../src/tools/tool-errors";
import { enforcePlanModeWrite, resolvePlanPath } from "../../src/tools/plan-mode-guard";

function makeSession(overrides: {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planFilePath?: string;
}): ToolSession {
	const planFilePath = overrides.planFilePath;
	return fromAny<ToolSession>({
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => "/plans",
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: planFilePath
			? () => ({
					enabled: true,
					planFilePath,
				})
			: undefined,
	});
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join("/tmp/agent-artifacts", "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "omp-local", "session-42", "memo.txt"),
		);
	});
});

describe("enforcePlanModeWrite", () => {
	it("allows writes to the active plan file", () => {
		const session = makeSession({ cwd: "/repo", planFilePath: "/repo/PLAN.md" });

		expect(enforcePlanModeWrite(session, "PLAN.md")).toBeUndefined();
	});

	it("blocks renames, deletes, and writes outside the active plan file", () => {
		const session = makeSession({ cwd: "/repo", planFilePath: "/repo/PLAN.md" });

		expect(() => enforcePlanModeWrite(session, "PLAN.md", { move: "RENAMED.md" })).toThrow(ToolError);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "delete" })).toThrow(ToolError);
		expect(() => enforcePlanModeWrite(session, "src/app.ts")).toThrow(ToolError);
	});
});
