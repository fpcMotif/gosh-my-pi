import { describe, expect, it } from "bun:test";
import {
	extractNumberProperty,
	extractReadableText,
	extractStringProperty,
	extractStructuredToolCallContent,
	extractToolCallContent,
	extractToolLocations,
	getContentBlocks,
	getContentType,
	hasEquivalentTextContent,
	isAssistantMessage,
	isNonEmptyString,
	limitText,
	normalizeText,
	safeJsonStringify,
	textToolCallContent,
} from "../../../src/modes/acp/acp-content-helpers";

describe("ACP content helper primitives", () => {
	it("extracts typed properties without accepting empty or non-finite values", () => {
		expect(isNonEmptyString("x")).toBe(true);
		expect(isNonEmptyString("")).toBe(false);
		expect(extractStringProperty<{ name?: unknown }>({ name: "agent" }, "name")).toBe("agent");
		expect(extractStringProperty<{ name?: unknown }>({ name: "" }, "name")).toBeUndefined();
		expect(extractStringProperty<{ name?: unknown }>({ name: 1 }, "name")).toBeUndefined();
		expect(extractNumberProperty<{ size?: unknown }>({ size: 12 }, "size")).toBe(12);
		expect(extractNumberProperty<{ size?: unknown }>({ size: Number.NaN }, "size")).toBeUndefined();
		expect(extractNumberProperty<{ size?: unknown }>("not-object", "size")).toBeUndefined();
	});

	it("normalizes readable strings and safely handles JSON serialization failures", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(normalizeText(undefined)).toBeUndefined();
		expect(normalizeText("")).toBeUndefined();
		expect(normalizeText("  hello  ")).toBe("hello");
		expect(normalizeText("  ")).toBeUndefined();
		expect(limitText("a".repeat(4_010))).toHaveLength(4_000);
		expect(safeJsonStringify({ ok: true })).toBe('{"ok":true}');
		expect(safeJsonStringify(circular)).toBeUndefined();
	});

	it("recognizes assistant messages and content block containers", () => {
		const blocks = [{ type: "text", text: "hello" }];

		expect(isAssistantMessage({ role: "assistant" })).toBe(true);
		expect(isAssistantMessage({ role: "user" })).toBe(false);
		expect(getContentType(undefined)).toBeUndefined();
		expect(getContentType(blocks[0])).toBe("text");
		expect(getContentType({ type: 42 })).toBeUndefined();
		expect(getContentBlocks(blocks)).toBe(blocks);
		expect(getContentBlocks({ content: blocks })).toBe(blocks);
		expect(getContentBlocks({ content: "nope" })).toBeUndefined();
	});
});

describe("ACP tool call content extraction", () => {
	it("extracts all ACP-supported structured content variants", () => {
		const content = extractStructuredToolCallContent({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "image-bytes", mimeType: "image/png" },
				{ type: "audio", data: "audio-bytes", mimeType: "audio/wav" },
				{
					type: "resource_link",
					uri: "file:///tmp/a.txt",
					name: "a.txt",
					title: "A",
					description: "text file",
					mimeType: "text/plain",
					size: 7,
				},
				{ type: "resource", resource: { uri: "file:///tmp/b.txt", text: "body", mimeType: "text/plain" } },
				{
					type: "resource",
					resource: { uri: "file:///tmp/c.bin", blob: "YmluYXJ5", mimeType: "application/octet-stream" },
				},
				{ type: "unknown", text: "ignored" },
			],
		});

		expect(content).toEqual([
			textToolCallContent("hello"),
			{ type: "content", content: { type: "image", data: "image-bytes", mimeType: "image/png" } },
			{ type: "content", content: { type: "audio", data: "audio-bytes", mimeType: "audio/wav" } },
			{
				type: "content",
				content: {
					type: "resource_link",
					uri: "file:///tmp/a.txt",
					name: "a.txt",
					title: "A",
					description: "text file",
					mimeType: "text/plain",
					size: 7,
				},
			},
			{
				type: "content",
				content: { type: "resource", resource: { uri: "file:///tmp/b.txt", text: "body", mimeType: "text/plain" } },
			},
			{
				type: "content",
				content: {
					type: "resource",
					resource: { uri: "file:///tmp/c.bin", blob: "YmluYXJ5", mimeType: "application/octet-stream" },
				},
			},
		]);
	});

	it("ignores malformed structured content instead of inventing ACP blocks", () => {
		expect(extractStructuredToolCallContent(undefined)).toEqual([]);
		expect(
			extractStructuredToolCallContent({
				content: [
					{ text: "missing type" },
					{ type: "text", text: "" },
					{ type: "image", data: "", mimeType: "image/png" },
					{ type: "resource_link", uri: "file:///tmp/a.txt" },
					{ type: "resource" },
					{ type: "resource", resource: null },
					{ type: "resource", resource: { text: "missing uri" } },
					{ type: "resource", resource: { uri: "file:///tmp/empty.bin" } },
				],
			}),
		).toEqual([]);
	});

	it("combines structured content with readable fallback text without duplicating equivalent text", () => {
		const textOnly = extractToolCallContent({ content: [{ type: "text", text: "hello" }] });
		const imageWithMessage = extractToolCallContent({
			message: "see attached",
			content: [{ type: "image", data: "bytes", mimeType: "image/png" }],
		});

		expect(extractToolCallContent(42)).toEqual([]);
		expect(hasEquivalentTextContent(textOnly, "hello")).toBe(true);
		expect(textOnly).toEqual([textToolCallContent("hello")]);
		expect(imageWithMessage).toEqual([
			{ type: "content", content: { type: "image", data: "bytes", mimeType: "image/png" } },
			textToolCallContent("see attached"),
		]);
	});

	it("extracts readable text from errors, direct fields, content blocks, and JSON fallbacks", () => {
		expect(extractReadableText(new Error("failed"))).toBe("failed");
		expect(extractReadableText({ errorMessage: "bad" })).toBe("bad");
		expect(extractReadableText("  direct  ")).toBe("direct");
		expect(
			extractReadableText({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			}),
		).toBe("one\ntwo");
		expect(extractReadableText({ content: [{ type: "text", text: "" }] })).toBe(
			'{"content":[{"type":"text","text":""}]}',
		);
		expect(extractReadableText({ value: 1 })).toBe('{"value":1}');
		expect(extractReadableText(42)).toBeUndefined();
	});

	it("derives unique path locations from tool arguments", () => {
		expect(extractToolLocations({ path: "a.ts", oldPath: "a.ts", newPath: "b.ts" })).toEqual([
			{ path: "a.ts" },
			{ path: "b.ts" },
		]);
		expect(extractToolLocations({ path: "", oldPath: "old.ts", newPath: "old.ts" })).toEqual([{ path: "old.ts" }]);
	});
});
