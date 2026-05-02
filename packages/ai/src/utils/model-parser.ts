export type SemVer = {
	major: number;
	minor: number;
	patch: number;
};

export type GeminiKind = "pro" | "flash";
export type AnthropicKind = "opus" | "sonnet";
export type OpenAIVariant = "base" | "codex" | "codex-spark" | "codex-mini" | "codex-max" | "max" | "nano";

export interface GeminiModel {
	family: "gemini";
	kind: GeminiKind;
	version: SemVer;
}

export interface AnthropicModel {
	family: "anthropic";
	kind: AnthropicKind;
	version: SemVer;
}

export interface OpenAIModel {
	family: "openai";
	variant: OpenAIVariant;
	version: SemVer;
}

export interface UnknownModel {
	family: "unknown";
	id: string;
}

export type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;

export function parseKnownModel(modelId: string): ParsedModel {
	const canonicalId = getCanonicalModelId(modelId);
	return (
		parseGeminiModel(canonicalId) ??
		parseAnthropicModel(canonicalId) ??
		parseOpenAIModel(canonicalId) ?? { family: "unknown", id: canonicalId }
	);
}

function parseGeminiModel(modelId: string): GeminiModel | null {
	const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "gemini", kind: match[2] as GeminiKind, version };
}

function parseAnthropicModel(modelId: string): AnthropicModel | null {
	const match = /claude-(opus|sonnet)-(\d+(?:[.-]\d+){0,2})\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[2]);
	if (!version) {
		return null;
	}
	return { family: "anthropic", kind: match[1] as AnthropicKind, version };
}

function parseOpenAIModel(modelId: string): OpenAIModel | null {
	const match = /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|max|nano))?\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "openai", variant: (match[2] as OpenAIVariant | undefined) ?? "base", version };
}

function getCanonicalModelId(modelId: string): string {
	const p = modelId.lastIndexOf("/");
	return p !== -1 ? modelId.slice(p + 1) : modelId;
}

export function semverGte(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) >= 0;
}

export function semverEqual(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) === 0;
}

function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number {
	const l = typeof left === "string" ? parseSemVer(left) : left;
	const r = typeof right === "string" ? parseSemVer(right) : right;
	if (!l || !r) return (l ? 1 : 0) - (r ? 1 : 0);

	if (l.major !== r.major) {
		return l.major - r.major;
	}
	if (l.minor !== r.minor) {
		return l.minor - r.minor;
	}
	return l.patch - r.patch;
}

// extend this table if we need anything more than 9.10
const precomputeTable: Record<string, SemVer> = {};
for (let major = 0; major <= 9; major++) {
	for (let minor = 0; minor <= 10; minor++) {
		const version = { major, minor, patch: 0 };
		precomputeTable[`${major}.${minor}`] = version;
		precomputeTable[`${major}-${minor}`] = version;
	}
	precomputeTable[`${major}`] = { major, minor: 0, patch: 0 };
}

export function parseSemVer(version: string): SemVer | null {
	return precomputeTable[version] ?? null;
}
