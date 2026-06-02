import { afterEach, describe, expect, it } from "bun:test";
import { setKeybindings, TUI_KEYBINDINGS, KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "../src/config/keybindings";
import { createCancellationError, getAbortReason, getExecutionCancellationError } from "../src/ipy/cancellation";
import {
	matchesAppExternalEditor,
	matchesAppInterrupt,
	matchesSelectCancel,
} from "../src/modes/utils/keybinding-matchers";
import { clearMermaidCache, resolveMermaidAscii } from "../src/modes/theme/mermaid-cache";
import { hasUi } from "../src/config/settings-schema";
import { getTaskSimpleModeCapabilities } from "../src/task/simple-mode";
import { getThinkingLevelMetadata, parseEffort, ThinkingLevel } from "../src/thinking";
import { formatShortSha } from "../src/tools/gh-format";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "../src/tools/jtd-utils";
import { applyListLimit } from "../src/tools/list-limit";
import { SearchProviderError, isSearchProviderId, isSearchProviderPreference } from "../src/web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../src/web/search/utils";

describe("formatShortSha", () => {
	it("shortens commit identifiers and omits absent commits", () => {
		expect(formatShortSha("1234567890abcdef")).toBe("1234567890ab");
		expect(formatShortSha(undefined)).toBeUndefined();
	});
});

describe("web search utility contracts", () => {
	it("identifies supported provider ids and provider preference values", () => {
		expect(isSearchProviderId("kimi")).toBe(true);
		expect(isSearchProviderId("unknown")).toBe(false);
		expect(isSearchProviderPreference("auto")).toBe(true);
		expect(isSearchProviderPreference("tavily")).toBe(true);
		expect(isSearchProviderPreference("none")).toBe(false);

		const error = new SearchProviderError("zai", "blocked", 403);
		expect(error.name).toBe("SearchProviderError");
		expect(error.provider).toBe("zai");
		expect(error.status).toBe(403);
	});

	it("maps invalid or absent dates to undefined and valid dates to elapsed seconds", () => {
		expect(dateToAgeSeconds(undefined)).toBeUndefined();
		expect(dateToAgeSeconds("")).toBeUndefined();
		expect(dateToAgeSeconds("not-a-date")).toBeUndefined();

		const ageSeconds = dateToAgeSeconds(new Date(Date.now() - 2_500).toISOString());
		expect(ageSeconds).toBeGreaterThanOrEqual(2);
		expect(ageSeconds).toBeLessThan(10);
	});

	it("uses defaults for absent counts while bounding explicit search limits", () => {
		expect(clampNumResults(undefined, 5, 20)).toBe(5);
		expect(clampNumResults(0, 5, 20)).toBe(5);
		expect(clampNumResults(Number.NaN, 5, 20)).toBe(5);
		expect(clampNumResults(-2, 5, 20)).toBe(1);
		expect(clampNumResults(12, 5, 20)).toBe(12);
		expect(clampNumResults(99, 5, 20)).toBe(20);
	});
});

describe("JTD guards", () => {
	it("recognizes discriminator, primitive, enum, properties, and refs", () => {
		expect(isJTDType({ type: "string" })).toBe(true);
		expect(isJTDEnum({ enum: ["a", "b"] })).toBe(true);
		expect(isJTDElements({ elements: { type: "string" } })).toBe(true);
		expect(isJTDValues({ values: { type: "string" } })).toBe(true);
		expect(isJTDProperties({ optionalProperties: {} })).toBe(true);
		expect(isJTDRef({ ref: "node" })).toBe(true);
		expect(isJTDDiscriminator({ discriminator: "kind", mapping: { a: { properties: {} } } })).toBe(true);
		expect(isJTDDiscriminator({ discriminator: "kind", mapping: [] })).toBe(false);
	});
});

describe("list limit metadata", () => {
	it("records result and head limit metadata separately", () => {
		const result = applyListLimit(["a", "b", "c", "d"], { limit: 3, headLimit: 2, limitType: "match" });

		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBe(3);
		expect(result.meta.matchLimit).toEqual({ reached: 3, suggestion: 6 });
		expect(result.meta.headLimit).toEqual({ reached: 2, suggestion: 4 });
	});

	it("uses result limits by default and ignores disabled limits", () => {
		const result = applyListLimit(["a", "b", "c"], { limit: 2, headLimit: 0 });
		const unlimited = applyListLimit(["a", "b"], { limit: 0, headLimit: -1 });

		expect(result.items).toEqual(["a", "b"]);
		expect(result.limitReached).toBe(2);
		expect(result.meta.resultLimit).toEqual({ reached: 2, suggestion: 4 });
		expect(unlimited.items).toEqual(["a", "b"]);
		expect(unlimited.limitReached).toBeUndefined();
		expect(unlimited.meta).toEqual({});
	});
});

describe("cancellation helpers", () => {
	it("prefers abort signal reasons and otherwise classifies timeout and abort errors", () => {
		const controller = new AbortController();
		controller.abort("user stopped");
		const errorController = new AbortController();
		const errorReason = new Error("typed abort");
		errorController.abort(errorReason);
		const abortedController = new AbortController();
		abortedController.abort("aborted by caller");
		expect(getAbortReason(errorController.signal, "fallback")).toBe(errorReason);
		expect(getAbortReason(controller.signal, "fallback").message).toBe("user stopped");
		expect(getAbortReason(undefined, "fallback").message).toBe("fallback");
		expect(createCancellationError("AbortError", "stopped").name).toBe("AbortError");
		expect(getExecutionCancellationError({}, abortedController.signal, "fallback").message).toBe("aborted by caller");
		expect(getExecutionCancellationError({ timedOut: true }, undefined, "deadline").name).toBe("TimeoutError");
		expect(getExecutionCancellationError({}, undefined, "cancelled").name).toBe("AbortError");
	});
});

describe("thinking metadata", () => {
	it("exposes stable labels for selector rendering", () => {
		expect(getThinkingLevelMetadata(ThinkingLevel.Inherit)).toMatchObject({
			value: ThinkingLevel.Inherit,
			label: "inherit",
		});
		expect(getThinkingLevelMetadata(ThinkingLevel.XHigh).description).toContain("Maximum reasoning");
	});

	it("accepts provider-facing effort names and rejects selector-only levels", () => {
		expect(parseEffort("high")).toBe("high");
		expect(parseEffort("xhigh")).toBe("xhigh");
		expect(parseEffort("inherit")).toBeUndefined();
		expect(parseEffort(undefined)).toBeUndefined();
	});
});

describe("settings metadata helpers", () => {
	it("reports which setting paths are exposed in the settings UI", () => {
		expect(hasUi("statusLine.separator")).toBe(true);
		expect(hasUi("statusLine.leftSegments")).toBe(false);
	});
});

describe("task simple-mode capabilities", () => {
	it("maps simple modes to the context and schema capabilities consumed by task tools", () => {
		expect(getTaskSimpleModeCapabilities("default")).toEqual({
			contextEnabled: true,
			customSchemaEnabled: true,
		});
		expect(getTaskSimpleModeCapabilities("schema-free")).toEqual({
			contextEnabled: true,
			customSchemaEnabled: false,
		});
		expect(getTaskSimpleModeCapabilities("independent")).toEqual({
			contextEnabled: false,
			customSchemaEnabled: false,
		});
	});
});

describe("keybinding matcher wrappers", () => {
	afterEach(() => {
		setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
	});

	it("matches the default selection cancel key and rejects ordinary text", () => {
		expect(matchesAppInterrupt("\x1b")).toBe(true);
		expect(matchesAppExternalEditor("\x07")).toBe(true);
		expect(matchesSelectCancel("\x1b")).toBe(true);
		expect(matchesSelectCancel("x")).toBe(false);
	});

	it("honors registered app keybindings before fallback defaults", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"app.interrupt": "ctrl+x",
				"app.editor.external": "ctrl+e",
			}),
		);

		expect(matchesAppInterrupt("\x18")).toBe(true);
		expect(matchesAppInterrupt("\x1b")).toBe(false);
		expect(matchesAppExternalEditor("\x05")).toBe(true);
		expect(matchesAppExternalEditor("\x07")).toBe(false);
	});
});

describe("mermaid ASCII cache", () => {
	it("normalizes empty source to a cached null and supports cache clearing", () => {
		expect(resolveMermaidAscii(" \r\n ")).toBeNull();
		expect(resolveMermaidAscii(" \n ")).toBeNull();
		clearMermaidCache();
		expect(resolveMermaidAscii("")).toBeNull();
	});
});
