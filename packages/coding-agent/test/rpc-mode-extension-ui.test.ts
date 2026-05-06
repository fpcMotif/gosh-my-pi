import { describe, expect, it } from "bun:test";
import { requestRpcEditor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RequestCorrelator } from "@oh-my-pi/pi-coding-agent/modes/rpc/request-correlator";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function isExtensionUiRequest(obj: { type?: unknown }): obj is RpcExtensionUIRequest {
	return obj.type === "extension_ui_request";
}

describe("requestRpcEditor", () => {
	it("serializes promptStyle on editor requests", async () => {
		const correlator = new RequestCorrelator();
		const requests: RpcExtensionUIRequest[] = [];

		const promise = requestRpcEditor(
			correlator,
			obj => {
				if (isExtensionUiRequest(obj)) {
					requests.push(obj);
				}
			},
			"Enter your response:",
			"draft",
			undefined,
			{ promptStyle: true },
		);

		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request || request.method !== "editor") {
			throw new Error("Expected an editor request");
		}
		expect(request.promptStyle).toBe(true);
		expect(request.prefill).toBe("draft");
		expect(correlator.has(request.id)).toBe(true);

		correlator.resolve(request.id, { type: "extension_ui_response", id: request.id, value: "custom response" });

		expect(promise).resolves.toBe("custom response");
		expect(correlator.has(request.id)).toBe(false);
	});

	it("resolves editor requests on abort and clears pending state", async () => {
		const correlator = new RequestCorrelator();
		const requests: RpcExtensionUIRequest[] = [];
		const controller = new AbortController();

		const promise = requestRpcEditor(
			correlator,
			obj => {
				if (isExtensionUiRequest(obj)) {
					requests.push(obj);
				}
			},
			"Enter your response:",
			undefined,
			{ signal: controller.signal },
			{ promptStyle: true },
		);

		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request || request.method !== "editor") {
			throw new Error("Expected an editor request");
		}
		expect(request.promptStyle).toBe(true);
		expect(correlator.has(request.id)).toBe(true);

		controller.abort();

		expect(requests).toHaveLength(2);
		const cancelRequest = requests[1];
		if (!cancelRequest || cancelRequest.method !== "cancel") {
			throw new Error("Expected a cancel request");
		}
		expect(cancelRequest.targetId).toBe(request.id);
		expect(promise).resolves.toBeUndefined();
		expect(correlator.has(request.id)).toBe(false);
	});
});
