import { describe, expect, it } from "bun:test";
import { toolPresenters } from "../../src/tools/presenters";

describe("toolPresenters", () => {
	it("registers neutral presenters for built-in tools used by the RPC wire", () => {
		expect(Object.keys(toolPresenters).sort()).toEqual(["apply_patch", "bash", "edit", "read", "recipe"]);

		const bash = toolPresenters.bash.presentCall?.({ command: "printf ok" }, { expanded: false, isPartial: true });
		expect(bash).toEqual({
			type: "status",
			status: { icon: "pending", title: "Bash", description: "$ printf ok" },
		});

		const recipe = toolPresenters.recipe.presentCall?.({ op: "check" }, { expanded: false, isPartial: true });
		expect(recipe?.type).toBe("status");
		if (recipe?.type === "status") {
			expect(recipe.status.title).toBe("Run");
		}

		const readUrl = toolPresenters.read.presentCall?.({ path: "https://example.test" }, { expanded: false });
		expect(readUrl).toBeUndefined();
	});
});
