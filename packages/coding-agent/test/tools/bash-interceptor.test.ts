import { describe, expect, it } from "bun:test";
import { checkBashInterception } from "../../src/tools/bash-interceptor";

describe("checkBashInterception", () => {
	it("allows non-matching commands after compiling an available rule", () => {
		const result = checkBashInterception(
			"echo ok",
			["read"],
			[{ pattern: "^cat\\s+", tool: "read", message: "Use read instead." }],
		);

		expect(result).toEqual({ block: false });
	});
});
