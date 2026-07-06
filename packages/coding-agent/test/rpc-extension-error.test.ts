import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import type { WireExtensionErrorFrameV1 } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/v1";

// rpc-mode emits {type:"extension_error"} when an extension hook throws. It is
// not a WireEventV1 member, so the RpcClient used to silently drop it. It must
// instead reach a diagnostic path (mirroring the Go soft-buffer), never be
// mis-routed as a pending-request response, and never break the read loop —
// including for malformed frames missing fields (gap G22).
describe("RpcClient extension_error diagnostics", () => {
	it("routes extension_error to the diagnostic path while the loop keeps running", async () => {
		const scriptPath = path.join(
			os.tmpdir(),
			`omp-rpc-extension-error-${process.pid}-${Math.trunc(performance.now())}.js`,
		);
		await Bun.write(
			scriptPath,
			`
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
let buffer = "";
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "extension_error", extensionPath: "/ext/foo.js", event: "onPrompt", error: "boom" });
		write({ type: "extension_error" });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		const client = new RpcClient({ cliPath: scriptPath });
		const diagnostics: WireExtensionErrorFrameV1[] = [];
		client.onDiagnostic(frame => diagnostics.push(frame));
		const events: AgentEvent[] = [];
		client.onEvent(event => events.push(event));

		try {
			await client.start();
			// promptAndWait resolves on agent_end: proves the prompt response was
			// correctly correlated (not displaced by extension_error) and the read
			// loop survived two extension_error frames to deliver the later event.
			const collected = await client.promptAndWait("hi");

			expect(diagnostics).toHaveLength(2);
			expect(diagnostics[0]).toEqual({
				type: "extension_error",
				extensionPath: "/ext/foo.js",
				event: "onPrompt",
				error: "boom",
			});
			// A malformed extension_error is normalized, not crashed, not dropped.
			expect(diagnostics[1]).toEqual({ type: "extension_error", extensionPath: "", event: "", error: "" });

			// The frame is never surfaced as an agent event...
			expect(collected.some(event => (event as { type: string }).type === "extension_error")).toBe(false);
			expect(events.some(event => (event as { type: string }).type === "extension_error")).toBe(false);
			// ...but the genuine event after it still arrives (loop alive).
			expect(collected.some(event => event.type === "agent_end")).toBe(true);
		} finally {
			client.stop();
			await Bun.file(scriptPath)
				.delete()
				.catch(() => {});
		}
	});
});
