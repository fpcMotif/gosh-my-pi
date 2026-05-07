import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

type BackendApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "google-vertex";

interface CrushModelDefinition {
	id?: unknown;
	name?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	default_max_tokens?: unknown;
	max_tokens?: unknown;
	maxTokens?: unknown;
	can_reason?: unknown;
	reasoning?: unknown;
	supports_attachments?: unknown;
	supportsImages?: unknown;
}

interface CrushProviderDefinition {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	base_url?: unknown;
	baseUrl?: unknown;
	api_key?: unknown;
	apiKey?: unknown;
	extra_headers?: unknown;
	extraHeaders?: unknown;
	models?: unknown;
}

interface CrushConfig {
	providers?: unknown;
}

interface BackendModelDefinition {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

interface BackendProviderDefinition {
	baseUrl?: string;
	apiKey?: string;
	api?: BackendApi;
	auth?: "apiKey" | "none";
	authHeader?: boolean;
	headers?: Record<string, string>;
	models?: BackendModelDefinition[];
}

interface BackendModelsConfig {
	providers?: Record<string, BackendProviderDefinition>;
	equivalence?: unknown;
}

export interface ImportedCrushProviderPreview {
	id: string;
	name?: string;
	baseUrl?: string;
	models: string[];
	auth: "apiKey" | "none";
}

export interface ImportCrushProvidersResult {
	sourcePath: string;
	targetPath: string;
	wrote: boolean;
	providers: ImportedCrushProviderPreview[];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function boolValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function crushProviderValue(value: unknown): CrushProviderDefinition | undefined {
	const record = objectValue(value);
	return record ? (record as CrushProviderDefinition) : undefined;
}

function crushModelValue(value: unknown): CrushModelDefinition | undefined {
	const record = objectValue(value);
	return record ? (record as CrushModelDefinition) : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
	const record = objectValue(value);
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (typeof raw === "string") out[key] = raw;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function defaultCrushConfigPath(): string {
	return path.join(os.homedir(), ".config", "crush", "crush.json");
}

function defaultModelsConfigPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

function crushProviderEntries(config: CrushConfig): Array<[string, CrushProviderDefinition]> {
	const providers = config.providers;
	if (providers === null || providers === undefined) return [];
	if (Array.isArray(providers)) {
		const entries: Array<[string, CrushProviderDefinition]> = [];
		for (const provider of providers) {
			const parsed = crushProviderValue(provider);
			if (!parsed) continue;
			const id = stringValue(parsed.id);
			if (!id) continue;
			entries.push([id, parsed]);
		}
		return entries;
	}
	const record = objectValue(providers);
	if (!record) return [];
	const entries: Array<[string, CrushProviderDefinition]> = [];
	for (const [id, provider] of Object.entries(record)) {
		const parsed = crushProviderValue(provider);
		if (parsed) entries.push([id, parsed]);
	}
	return entries;
}

function mapCrushProviderType(value: unknown): BackendApi | undefined {
	const providerType = stringValue(value)?.toLowerCase();
	switch (providerType) {
		case "openai":
		case "openai-compat":
		case "openai-compatible":
			return "openai-completions";
		case "anthropic":
			return "anthropic-messages";
		case "gemini":
			return "google-generative-ai";
		case "vertexai":
		case "vertex":
			return "google-vertex";
		default:
			return undefined;
	}
}

function convertModel(model: CrushModelDefinition): BackendModelDefinition | undefined {
	const id = stringValue(model.id);
	if (!id) return undefined;
	const supportsImages = boolValue(model.supports_attachments) ?? boolValue(model.supportsImages);
	return {
		id,
		name: stringValue(model.name),
		contextWindow: positiveNumber(model.context_window) ?? positiveNumber(model.contextWindow),
		maxTokens:
			positiveNumber(model.default_max_tokens) ??
			positiveNumber(model.max_tokens) ??
			positiveNumber(model.maxTokens),
		reasoning: boolValue(model.can_reason) ?? boolValue(model.reasoning),
		input: supportsImages === true ? ["text", "image"] : undefined,
	};
}

function convertProvider(
	id: string,
	provider: CrushProviderDefinition,
): { config: BackendProviderDefinition; preview: ImportedCrushProviderPreview } | undefined {
	const baseUrl = stringValue(provider.base_url) ?? stringValue(provider.baseUrl);
	const modelDefs: BackendModelDefinition[] = [];
	if (Array.isArray(provider.models)) {
		for (const rawModel of provider.models) {
			const parsed = crushModelValue(rawModel);
			if (!parsed) continue;
			const converted = convertModel(parsed);
			if (converted) modelDefs.push(converted);
		}
	}
	if (!baseUrl || modelDefs.length === 0) return undefined;

	const apiKey = stringValue(provider.api_key) ?? stringValue(provider.apiKey);
	const auth = !apiKey || apiKey === "not-required" ? "none" : "apiKey";
	const headers = stringRecordValue(provider.extra_headers) ?? stringRecordValue(provider.extraHeaders);
	const config: BackendProviderDefinition = {
		baseUrl,
		api: mapCrushProviderType(provider.type) ?? "openai-completions",
		auth,
		headers,
		models: modelDefs,
	};
	if (auth === "apiKey" && apiKey) {
		config.apiKey = apiKey;
		config.authHeader = true;
	}

	const name = stringValue(provider.name);
	return {
		config,
		preview: {
			id,
			name,
			baseUrl,
			models: modelDefs.map(model => model.id),
			auth,
		},
	};
}

export function buildModelsConfigFromCrushConfig(
	crushConfig: CrushConfig,
	existing: BackendModelsConfig = {},
): { config: BackendModelsConfig; providers: ImportedCrushProviderPreview[] } {
	const providers: Record<string, BackendProviderDefinition> = { ...existing.providers };
	const previews: ImportedCrushProviderPreview[] = [];

	for (const [id, provider] of crushProviderEntries(crushConfig)) {
		const converted = convertProvider(id, provider);
		if (!converted) continue;
		providers[id] = converted.config;
		previews.push(converted.preview);
	}

	return {
		config: {
			...existing,
			providers,
		},
		providers: previews,
	};
}

async function readYamlConfig(pathname: string): Promise<BackendModelsConfig> {
	try {
		const text = await Bun.file(pathname).text();
		const parsed = YAML.parse(text) as unknown;
		return objectValue(parsed) ?? {};
	} catch (error) {
		if (isEnoent(error)) return {};
		throw error;
	}
}

export async function importCrushProviders(options: {
	sourcePath?: string;
	targetPath?: string;
	write?: boolean;
}): Promise<ImportCrushProvidersResult> {
	const sourcePath = path.resolve(options.sourcePath ?? defaultCrushConfigPath());
	const targetPath = path.resolve(options.targetPath ?? defaultModelsConfigPath());
	const sourceText = await Bun.file(sourcePath).text();
	const crushConfig = Bun.JSON5.parse(sourceText) as CrushConfig;
	const existing = await readYamlConfig(targetPath);
	const { config, providers } = buildModelsConfigFromCrushConfig(crushConfig, existing);

	if (options.write === true) {
		await Bun.write(targetPath, YAML.stringify(config, null, 2));
	}

	return {
		sourcePath,
		targetPath,
		wrote: options.write === true,
		providers,
	};
}
