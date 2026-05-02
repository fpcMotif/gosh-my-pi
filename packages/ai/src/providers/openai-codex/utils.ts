import type { Tool, ToolChoice, Model } from "../../types";
import type { CodexTransport, CodexWebSocketSessionState } from "./websocket";

const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
const X_REASONING_INCLUDED_HEADER = "x-reasoning-included";
const OPENAI_HEADERS = {
	SESSION_ID: "openai-session-id",
	DEVICE_ID: "openai-device-id",
};
const OPENAI_HEADER_VALUES = {
	"x-openai-is-internal": "true",
};

export function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (state === undefined || state === null || headers === undefined || headers === null) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState !== null && turnState !== undefined && turnState !== "" && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag !== null && modelsEtag !== undefined && modelsEtag !== "" && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
	const reasoningIncluded = resolvedHeaders.get(X_REASONING_INCLUDED_HEADER);
	if (reasoningIncluded !== null) {
		const normalized = reasoningIncluded.trim().toLowerCase();
		state.reasoningIncluded = normalized.length === 0 ? true : normalized !== "false";
	}
}

export function createCodexHeaders(
	requestHeaders: Record<string, string> | undefined,
	accountId: string,
	apiKey: string,
	sessionId: string | undefined,
	transport: CodexTransport,
	state: CodexWebSocketSessionState | undefined,
	version: string,
	hostname: string,
): Headers {
	const headers = new Headers(requestHeaders);
	headers.set("Authorization", `Bearer ${apiKey}`);
	if (accountId !== "") {
		headers.set("ChatGPT-Account-Id", accountId);
	}
	if (sessionId !== undefined && sessionId !== null && sessionId !== "") {
		headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	headers.set("X-OpenAI-Client-Name", "oh-my-pi");
	headers.set("X-OpenAI-Client-Version", version);
	headers.set("X-OpenAI-Transport", transport);

	if (state !== undefined && state !== null) {
		if (state.turnState !== undefined && state.turnState !== null && state.turnState !== "") {
			headers.set(X_CODEX_TURN_STATE_HEADER, state.turnState);
		}
		if (state.modelsEtag !== undefined && state.modelsEtag !== null && state.modelsEtag !== "") {
			headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
		}
	}

	if (headers.has(OPENAI_HEADERS.DEVICE_ID) === false) {
		headers.set(OPENAI_HEADERS.DEVICE_ID, hostname);
	}
	for (const [key, value] of Object.entries(OPENAI_HEADER_VALUES)) {
		if (headers.has(key) === false) {
			headers.set(key, value);
		}
	}

	return headers;
}

export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (choice === undefined || choice === null) return undefined;
	if (typeof choice === "string") return choice;

	const allowFreeform = model !== undefined && model !== null && model.applyPatchToolType === "freeform";
	const mapName = (name: string): Record<string, string> => {
		const customTool = allowFreeform
			? tools.find(
					tool =>
						tool.customFormat !== undefined &&
						tool.customFormat !== null &&
						(tool.name === name || tool.customWireName === name),
				)
			: undefined;
		return customTool !== undefined && customTool !== null
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name };
	};

	if (choice.type === "function") {
		if ("function" in choice && choice.function.name.length > 0) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && (choice as { name: string }).name.length > 0) {
			return mapName((choice as { name: string }).name);
		}
	}
	if (choice.type === "tool" && choice.name.length > 0) {
		return mapName(choice.name);
	}
	return undefined;
}

export function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}
