import { describe, expect, test } from "bun:test";
import { coalesce, isAborted, withTimeout } from "../src/async";

describe("coalesce", () => {
	test("deduplicates concurrent calls", async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			await new Promise(r => setTimeout(r, 10));
			return calls;
		};
		const coalesced = coalesce(fn);
		const results = await Promise.all([coalesced(), coalesced(), coalesced()]);
		expect(results).toEqual([1, 1, 1]);
		expect(calls).toBe(1);

		const result2 = await coalesced();
		expect(result2).toBe(2);
		expect(calls).toBe(2);
	});
});
