/**
 * Marketplace catalog fetcher.
 *
 * Classifies a source string, resolves it, and loads the catalog.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import * as git from "../../../utils/git";

import type { MarketplaceCatalog, MarketplaceSourceType } from "./types";
import { isValidNameSegment } from "./types";

// ── Types ─────────────────────────────────────────────────────────────

export interface FetchResult {
	catalog: MarketplaceCatalog;
	/** For git sources: path to the cloned marketplace directory. */
	clonePath?: string;
}

// ── classifySource ────────────────────────────────────────────────────

/**
 * Detects Windows-style absolute paths cross-platform:
 *   C:\path, C:/path  → drive-letter + colon + separator
 *   \\server\share    → UNC path
 *
 * Needed because path.isAbsolute("C:\...") returns false on POSIX.
 */
const WIN_ABS_RE = /^[A-Za-z]:[/\\]|^\\\\/;

/**
 * GitHub owner/repo shorthand: lowercase alphanumeric + hyphens/dots, one slash.
 * Must NOT start with a protocol — that is ruled out by earlier checks.
 */
const GITHUB_SHORTHAND_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/**
 * Classify a marketplace source string into one of the four source types.
 */
export function classifySource(source: string): MarketplaceSourceType {
	if (source.startsWith("https://") || source.startsWith("http://")) {
		try {
			const { pathname } = new URL(source);
			return pathname.endsWith(".json") ? "url" : "git";
		} catch {
			return "git";
		}
	}
	if (source.startsWith("git@") || source.startsWith("ssh://")) return "git";
	if (GITHUB_SHORTHAND_RE.test(source)) return "github";
	if (source.startsWith("./") || source.startsWith("~/")) return "local";
	if (path.isAbsolute(source) || WIN_ABS_RE.test(source)) return "local";

	throw new Error(`Unrecognized source format. Did you mean './${source}' (local) or 'owner/repo' (GitHub)?`);
}

// ── parseMarketplaceCatalog ───────────────────────────────────────────

function assertField(condition: boolean, field: string, filePath: string): void {
	if (!condition) {
		throw new Error(`Missing or invalid field "${field}" in catalog: ${filePath}`);
	}
}

/** Validate a single plugin entry from the catalog. */
function validatePluginEntry(entry: unknown, i: number, filePath: string): void {
	assertField(typeof entry === "object" && entry !== null && !Array.isArray(entry), `plugins[${i}]`, filePath);
	const p = entry as Record<string, unknown>;
	assertField(typeof p.name === "string" && isValidNameSegment(p.name), `plugins[${i}].name`, filePath);

	const hasValidSource =
		typeof p.source === "string" ||
		(typeof p.source === "object" &&
			p.source !== null &&
			!Array.isArray(p.source) &&
			typeof (p.source as Record<string, unknown>).source === "string");
	assertField(hasValidSource, `plugins[${i}].source`, filePath);

	if (typeof p.source === "string") {
		assertField(p.source.startsWith("./"), `plugins[${i}].source (must start with "./")`, filePath);
	} else if (typeof p.source === "object" && p.source !== null) {
		validateTypedSource(p.source as Record<string, unknown>, i, filePath);
	}
}

function validateTypedSource(src: Record<string, unknown>, i: number, filePath: string): void {
	const variant = src.source as string;
	if (variant === "github") {
		assertField(typeof src.repo === "string" && src.repo.length > 0, `plugins[${i}].source.repo`, filePath);
	} else if (variant === "url" || variant === "git-subdir") {
		assertField(typeof src.url === "string" && src.url.length > 0, `plugins[${i}].source.url`, filePath);
		if (variant === "git-subdir") {
			assertField(typeof src.path === "string" && src.path.length > 0, `plugins[${i}].source.path`, filePath);
		}
	} else if (variant === "npm") {
		assertField(typeof src.package === "string" && src.package.length > 0, `plugins[${i}].source.package`, filePath);
	} else {
		assertField(false, `plugins[${i}].source.source (unknown variant: "${variant}")`, filePath);
	}
}

/**
 * Parse and validate a marketplace.json catalog from raw JSON content.
 */
export function parseMarketplaceCatalog(content: string, filePath: string): MarketplaceCatalog {
	const obj = parseRawCatalog(content, filePath);
	assertField(typeof obj.name === "string" && isValidNameSegment(obj.name), "name", filePath);
	assertField(typeof obj.owner === "object" && obj.owner !== null && !Array.isArray(obj.owner), "owner", filePath);
	assertField(typeof (obj.owner as Record<string, any>).name === "string", "owner.name", filePath);
	assertField(Array.isArray(obj.plugins), "plugins", filePath);

	const plugins = obj.plugins as unknown[];
	const validPlugins: unknown[] = [];
	for (let i = 0; i < plugins.length; i += 1) {
		try {
			validatePluginEntry(plugins[i], i, filePath);
			validPlugins.push(plugins[i]);
		} catch (error) {
			const name =
				typeof plugins[i] === "object" && plugins[i] !== null ? ((plugins[i] as any).name ?? `[${i}]`) : `[${i}]`;
			logger.warn(`Skipping invalid plugin ${String(name)}: ${(error as Error).message}`);
		}
	}
	obj.plugins = validPlugins;
	return obj as unknown as MarketplaceCatalog;
}

function parseRawCatalog(content: string, filePath: string): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse marketplace catalog at ${filePath}: ${(error as Error).message}`);
	}

	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Marketplace catalog at ${filePath} must be a JSON object`);
	}
	return raw as Record<string, unknown>;
}

// ── fetchMarketplace ──────────────────────────────────────────────────

const CATALOG_RELATIVE_PATH = path.join(".claude-plugin", "marketplace.json");

function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export async function fetchMarketplace(source: string, cacheDir: string): Promise<FetchResult> {
	const type = classifySource(source);
	if (type === "local") {
		const catalogPath = path.join(path.resolve(expandHome(source)), CATALOG_RELATIVE_PATH);
		try {
			const content = await Bun.file(catalogPath).text();
			return { catalog: parseMarketplaceCatalog(content, catalogPath) };
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Marketplace catalog not found at "${catalogPath}".`);
			throw error;
		}
	}

	if (type === "github" || type === "git") {
		const url = type === "github" ? `https://github.com/${source}.git` : source;
		return cloneAndReadCatalog(url, cacheDir);
	}

	const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`Failed to fetch marketplace catalog from ${source}: HTTP ${response.status}`);
	const text = await response.text();
	const catalog = parseMarketplaceCatalog(text, source);
	await Bun.write(path.join(cacheDir, catalog.name, "marketplace.json"), text);
	return { catalog };
}

// ── cloneAndReadCatalog ───────────────────────────────────────────────

async function cloneAndReadCatalog(url: string, cacheDir: string): Promise<FetchResult> {
	const tmpDir = path.join(cacheDir, `.tmp-clone-${Date.now()}`);
	await fs.mkdir(cacheDir, { recursive: true });
	await git.clone(url, tmpDir);

	const catalogPath = path.join(tmpDir, CATALOG_RELATIVE_PATH);
	try {
		const content = await Bun.file(catalogPath).text();
		return { catalog: parseMarketplaceCatalog(content, catalogPath), clonePath: tmpDir };
	} catch (error) {
		await fs.rm(tmpDir, { recursive: true, force: true });
		if (isEnoent(error)) throw new Error(`Cloned repository has no marketplace catalog at ${CATALOG_RELATIVE_PATH}`);
		throw error;
	}
}

export async function promoteCloneToCache(tmpDir: string, cacheDir: string, name: string): Promise<string> {
	const finalDir = path.join(cacheDir, name);
	await fs.rm(finalDir, { recursive: true, force: true });
	await fs.rename(tmpDir, finalDir);
	return finalDir;
}
