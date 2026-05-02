import type { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";

export interface ContentArrayContainer {
	content?: unknown;
}

export interface TypedValue {
	type?: unknown;
}

export interface TextLikeContent extends TypedValue {
	text?: unknown;
}

export interface BinaryLikeContent extends TypedValue {
	data?: unknown;
	mimeType?: unknown;
}

export interface PathContainer {
	path?: unknown;
}

export interface OldPathContainer {
	oldPath?: unknown;
}

export interface NewPathContainer {
	newPath?: unknown;
}

export interface CommandContainer {
	command?: unknown;
}

export interface PatternContainer {
	pattern?: unknown;
}

export interface QueryContainer {
	query?: unknown;
}

export interface ErrorMessageContainer {
	errorMessage?: unknown;
}

export interface MessageContainer {
	message?: unknown;
}

export interface ResourceLinkLikeContent extends TypedValue {
	uri?: unknown;
	name?: unknown;
	title?: unknown;
	description?: unknown;
	mimeType?: unknown;
	size?: unknown;
}

export interface BlobResourceLike {
	uri?: unknown;
	blob?: unknown;
	mimeType?: unknown;
}

export interface TextResourceLike {
	uri?: unknown;
	text?: unknown;
	mimeType?: unknown;
}

export interface EmbeddedResourceLikeContent extends TypedValue {
	resource?: unknown;
}

export interface TextMessageLike {
	role?: unknown;
}

const ACP_TEXT_LIMIT = 4_000;

export function isNonEmptyString(value: string | undefined): value is string {
	return value !== null && value !== undefined && value !== "";
}

export function extractStringProperty<T extends object>(value: unknown, key: keyof T): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

export function extractNumberProperty<T extends object>(value: unknown, key: keyof T): number | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

export function isAssistantMessage(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && "role" in value && (value as TextMessageLike).role === "assistant"
	);
}

export function limitText(text: string): string {
	return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text;
}

export function normalizeText(text: string | undefined): string | undefined {
	if (text === null || text === undefined || text === "") {
		return undefined;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? limitText(normalized) : undefined;
}

export function safeJsonStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

export function getContentType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as TypedValue).type;
	return typeof type === "string" ? type : undefined;
}

export function getContentBlocks(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return undefined;
	}
	const content = (value as ContentArrayContainer).content;
	return Array.isArray(content) ? content : undefined;
}

export function extractStructuredText(value: unknown): string | undefined {
	const text = extractStringProperty<TextLikeContent>(value, "text");
	if (text === null || text === undefined || text === "") {
		return undefined;
	}
	return limitText(text);
}

export function textToolCallContent(text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "text",
			text,
		},
	};
}

export function hasEquivalentTextContent(content: ToolCallContent[], text: string): boolean {
	return content.some(item => item.type === "content" && item.content.type === "text" && item.content.text === text);
}

export function extractToolLocations(args: unknown): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const path = extractStringProperty<PathContainer>(args, "path");
	if (isNonEmptyString(path)) {
		locations.push({ path });
	}

	const oldPath = extractStringProperty<OldPathContainer>(args, "oldPath");
	if (isNonEmptyString(oldPath) && oldPath !== path) {
		locations.push({ path: oldPath });
	}

	const newPath = extractStringProperty<NewPathContainer>(args, "newPath");
	if (isNonEmptyString(newPath) && newPath !== path && newPath !== oldPath) {
		locations.push({ path: newPath });
	}

	return locations;
}

function buildBinaryToolCallContent(value: unknown, type: "image" | "audio"): ToolCallContent | undefined {
	const data = extractStringProperty<BinaryLikeContent>(value, "data");
	const mimeType = extractStringProperty<BinaryLikeContent>(value, "mimeType");
	if (!isNonEmptyString(data) || !isNonEmptyString(mimeType)) {
		return undefined;
	}
	return {
		type: "content",
		content: { type, data, mimeType },
	};
}

type ResourceLinkContent = {
	type: "resource_link";
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
};

function applyOptionalStringField<K extends "title" | "description" | "mimeType">(
	target: ResourceLinkContent,
	value: unknown,
	field: K,
): void {
	const extracted = extractStringProperty<ResourceLinkLikeContent>(value, field);
	if (isNonEmptyString(extracted)) {
		target[field] = extracted;
	}
}

function buildResourceLinkToolCallContent(value: unknown): ToolCallContent | undefined {
	const uri = extractStringProperty<ResourceLinkLikeContent>(value, "uri");
	const name = extractStringProperty<ResourceLinkLikeContent>(value, "name");
	if (!isNonEmptyString(uri) || !isNonEmptyString(name)) {
		return undefined;
	}
	const resourceLinkContent: ResourceLinkContent = { type: "resource_link", uri, name };
	applyOptionalStringField(resourceLinkContent, value, "title");
	applyOptionalStringField(resourceLinkContent, value, "description");
	applyOptionalStringField(resourceLinkContent, value, "mimeType");
	const size = extractNumberProperty<ResourceLinkLikeContent>(value, "size");
	if (size !== undefined) {
		resourceLinkContent.size = size;
	}
	return { type: "content", content: resourceLinkContent };
}

function buildTextResource(
	uri: string,
	text: string,
	mimeType: string | undefined,
): { uri: string; text: string; mimeType?: string } {
	return isNonEmptyString(mimeType) ? { uri, text, mimeType } : { uri, text };
}

function buildBlobResource(
	uri: string,
	blob: string,
	mimeType: string | undefined,
): { uri: string; blob: string; mimeType?: string } {
	return isNonEmptyString(mimeType) ? { uri, blob, mimeType } : { uri, blob };
}

function extractEmbeddedResource(
	value: unknown,
): { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } | undefined {
	if (typeof value !== "object" || value === null || !("resource" in value)) {
		return undefined;
	}

	const resource = (value as EmbeddedResourceLikeContent).resource;
	if (typeof resource !== "object" || resource === null) {
		return undefined;
	}

	const uri = extractStringProperty<TextResourceLike>(resource, "uri");
	if (!isNonEmptyString(uri)) {
		return undefined;
	}

	const text = extractStringProperty<TextResourceLike>(resource, "text");
	if (isNonEmptyString(text)) {
		const mimeType = extractStringProperty<TextResourceLike>(resource, "mimeType");
		return buildTextResource(uri, text, mimeType);
	}

	const blob = extractStringProperty<BlobResourceLike>(resource, "blob");
	if (!isNonEmptyString(blob)) {
		return undefined;
	}
	const mimeType = extractStringProperty<BlobResourceLike>(resource, "mimeType");
	return buildBlobResource(uri, blob, mimeType);
}

function buildResourceToolCallContent(value: unknown): ToolCallContent | undefined {
	const resource = extractEmbeddedResource(value);
	if (!resource) {
		return undefined;
	}
	return {
		type: "content",
		content: { type: "resource", resource },
	};
}

function toToolCallContent(value: unknown): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!isNonEmptyString(type)) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStructuredText(value);
			return isNonEmptyString(text) ? textToolCallContent(text) : undefined;
		}
		case "image":
		case "audio":
			return buildBinaryToolCallContent(value, type);
		case "resource_link":
			return buildResourceLinkToolCallContent(value);
		case "resource":
			return buildResourceToolCallContent(value);
		default:
			return undefined;
	}
}

export function extractStructuredToolCallContent(value: unknown): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block);
		if (toolCallContent) {
			content.push(toolCallContent);
		}
	}
	return content;
}

export function extractReadableText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeText(value);
	}
	if (value instanceof Error) {
		return normalizeText(value.message);
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	if (isNonEmptyString(directText)) {
		return normalizeText(directText);
	}

	const contentBlocks = getContentBlocks(value);
	if (contentBlocks) {
		const text = contentBlocks
			.map(block => extractStructuredText(block))
			.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
			.join("\n");
		if (text.length > 0) {
			return normalizeText(text);
		}
	}

	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

export function extractToolCallContent(value: unknown): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value);
	const fallbackText = extractReadableText(value);
	if (!isNonEmptyString(fallbackText)) {
		return richContent;
	}
	if (hasEquivalentTextContent(richContent, fallbackText)) {
		return richContent;
	}
	return [...richContent, textToolCallContent(fallbackText)];
}
