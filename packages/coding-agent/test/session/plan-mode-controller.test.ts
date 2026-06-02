import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLocalUrlToPath, type LocalProtocolOptions } from "../../src/internal-urls";
import { PlanModeController } from "../../src/session/plan-mode-controller";

describe("PlanModeController", () => {
	let tempDir = "";
	let localOptions: LocalProtocolOptions;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-controller-"));
		localOptions = {
			getArtifactsDir: () => tempDir,
			getSessionId: () => "session-1",
		};
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function controller(cwd = tempDir): PlanModeController {
		return new PlanModeController({
			getLocalProtocolOptions: () => localOptions,
			getCwd: () => cwd,
		});
	}

	it("builds a one-shot reference message when plan mode is off and the plan exists", async () => {
		const planPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await Bun.write(planPath, "1. Build the thing\n");
		const mode = controller();

		const message = await mode.buildReferenceMessage();

		expect(message?.customType).toBe("plan-mode-reference");
		expect(message?.display).toBe(false);
		expect(message?.content).toContain("Build the thing");
		expect(await mode.buildReferenceMessage()).toBeNull();
	});

	it("builds an active message for relative plan paths and resets stateful reference tracking", async () => {
		const cwd = path.join(tempDir, "repo");
		await fs.mkdir(cwd, { recursive: true });
		const mode = controller(cwd);
		mode.setState({ enabled: true, planFilePath: "docs/PLAN.md", workflow: "iterative", reentry: true });

		const active = await mode.buildActiveMessage();

		expect(mode.isEnabled).toBe(true);
		expect(active?.customType).toBe("plan-mode-context");
		expect(active?.content).toContain("docs/PLAN.md");
		expect(active?.content).toContain("Iterative Planning");

		mode.reset();
		mode.setState(undefined);
		expect(mode.isEnabled).toBe(false);
		expect(await mode.buildActiveMessage()).toBeNull();
	});

	it("returns null for missing reference plans and while plan mode is active", async () => {
		const mode = controller();
		expect(await mode.buildReferenceMessage()).toBeNull();

		mode.setState({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(await mode.buildReferenceMessage()).toBeNull();
	});
});
