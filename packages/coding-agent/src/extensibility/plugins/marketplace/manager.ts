/**
 * MarketplaceManager — orchestrates registry, fetcher, resolver, and cache.
 *
 * Constructor takes explicit paths for testability (same pattern as registry.ts).
 * The `clearPluginRootsCache` dependency is injected so callers can provide
 * the real `clearClaudePluginRootsCache` while tests supply a counter stub.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger } from "@oh-my-pi/pi-utils";

import { cachePlugin } from "./cache";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "./registry";
import { resolvePluginSource } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";

// ── Options ──────────────────────────────────────────────────────────────────

export interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	/**
	 * Path to the project-scoped installed_plugins.json.
	 */
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	/** Injected for testing; production callers pass clearClaudePluginRootsCache. */
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	// Invalidate fs caches for all registry paths the manager writes, then clear plugin roots.
	#clearCache(): void {
		const extra =
			this.#opts.projectInstalledRegistryPath !== null &&
			this.#opts.projectInstalledRegistryPath !== undefined &&
			this.#opts.projectInstalledRegistryPath !== ""
				? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
				: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	// ── Marketplace lifecycle ─────────────────────────────────────────────────

	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existingNames = new Set(reg.marketplaces.map(m => m.name));

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		if (existingNames.has(catalog.name)) {
			if (clonePath) await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			throw new Error(`Marketplace "${catalog.name}" already exists`);
		}

		if (clonePath) await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);

		const sourceType = classifySource(source);
		const normalizedSource =
			sourceType === "local"
				? path.resolve(source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source)
				: source;

		const catalogPath = path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json");
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	async removeMarketplace(name: string): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);
		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), { recursive: true, force: true });
		logger.debug("Marketplace removed", { name });
	}

	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) throw new Error(`Marketplace "${name}" not found`);

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		if (catalog.name !== name) {
			if (clonePath) await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			throw new Error(`Marketplace catalog name changed from "${name}" to "${catalog.name}".`);
		}

		if (clonePath) await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		await Bun.write(existing.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = { ...existing, updatedAt: new Date().toISOString() };
		const updatedReg = { ...reg, marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)) };
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		return Promise.all(marketplaces.map(m => this.updateMarketplace(m.name)));
	}

	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		return reg.marketplaces;
	}

	// ── Plugin discovery ──────────────────────────────────────────────────────

	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) throw new Error(`Marketplace "${marketplace}" not found`);
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const catalogs = await Promise.all(reg.marketplaces.map(entry => this.#readCatalog(entry)));
		return catalogs.flatMap(catalog => catalog.plugins);
	}

	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	// ── Install / uninstall ───────────────────────────────────────────────────

	async installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstalledPluginEntry> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);

		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) throw new Error(`Marketplace "${marketplace}" not found`);

		const catalog = await this.#readCatalog(mktEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);

		const pluginId = buildPluginId(name, marketplace);
		const instReg = await readInstalledPluginsRegistry(registryPath);
		const existing = getInstalledPlugin(instReg, pluginId);
		if (existing && existing.length > 0 && !force) throw new Error(`Plugin "${pluginId}" is already installed.`);

		const { version, cachePath } = await this.#preparePluginCache(mktEntry, catalog, pluginEntry, marketplace, name);

		if (existing && existing.length > 0) {
			await this.#cleanupOldPluginEntries(registryPath, pluginId, existing, cachePath);
		}

		const installedEntry = await this.#registerInstalledPlugin(
			registryPath,
			pluginId,
			scope,
			cachePath,
			version,
			existing,
		);
		this.#clearCache();
		logger.debug("Plugin installed", { pluginId, version, cachePath });
		return installedEntry;
	}

	async #preparePluginCache(
		mktEntry: MarketplaceRegistryEntry,
		catalog: MarketplaceCatalog,
		pluginEntry: MarketplacePluginEntry,
		marketplace: string,
		name: string,
	): Promise<{ version: string; cachePath: string }> {
		const marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);
		if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
			throw new Error(
				`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL.`,
			);
		}

		const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});

		try {
			const version = await this.#resolvePluginVersion(pluginEntry, sourcePath);
			const cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
			return { version, cachePath };
		} finally {
			if (tempCloneRoot) await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
		}
	}

	async #cleanupOldPluginEntries(
		registryPath: string,
		pluginId: string,
		existing: InstalledPluginEntry[],
		newCachePath: string,
	): Promise<void> {
		const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
		await writeInstalledPluginsRegistry(registryPath, prunedReg);

		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(userReg, projectReg);

		await Promise.all(
			existing
				.filter(entry => entry.installPath !== newCachePath && !referenced.has(entry.installPath))
				.map(entry => fs.rm(entry.installPath, { recursive: true, force: true })),
		);
	}

	async #registerInstalledPlugin(
		registryPath: string,
		pluginId: string,
		scope: "user" | "project",
		cachePath: string,
		version: string,
		existing?: InstalledPluginEntry[],
	): Promise<InstalledPluginEntry> {
		const now = new Date().toISOString();
		const wasDisabled = existing?.some(e => e.enabled === false) === true;
		const installedEntry: InstalledPluginEntry = {
			scope,
			installPath: cachePath,
			version,
			installedAt: now,
			lastUpdated: now,
			...(wasDisabled ? { enabled: false } : {}),
		};

		const freshInstReg = await readInstalledPluginsRegistry(registryPath);
		const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
		await writeInstalledPluginsRegistry(registryPath, newInstReg);
		return installedEntry;
	}

	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		if (entry.version) return entry.version;
		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string") return content.version;
			} catch {}
		}
		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha)
			return entry.source.sha.slice(0, 7);
		return "0.0.0";
	}

	async uninstallPlugin(pluginId: string, scope?: "user" | "project"): Promise<void> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) throw new Error(`Invalid plugin ID format: "${pluginId}".`);

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);
		const inUser = (userEntries?.length ?? 0) > 0;
		const inProject = (projectEntries?.length ?? 0) > 0;
		if (!inUser && !inProject) throw new Error(`Plugin "${pluginId}" is not installed`);

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) throw new Error(`Plugin "${pluginId}" is installed in both scopes. Specify one.`);
			targetScope = scope;
		} else targetScope = inProject ? "project" : "user";

		if (scope && scope !== targetScope) throw new Error(`Plugin "${pluginId}" is not installed in ${scope} scope`);

		const targetEntries = targetScope === "project" ? projectEntries! : userEntries!;
		const targetReg = targetScope === "project" ? projectReg : userReg;
		await writeInstalledPluginsRegistry(this.#registryPath(targetScope), removeInstalledPlugin(targetReg, pluginId));

		const [freshUserReg, freshProjectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(freshUserReg, freshProjectReg);

		await Promise.all(
			targetEntries
				.filter(entry => !referenced.has(entry.installPath))
				.map(entry => fs.rm(entry.installPath, { recursive: true, force: true })),
		);

		this.#clearCache();
		logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
	}

	// ── Plugin state ──────────────────────────────────────────────────────────

	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve(null),
		]);

		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];
		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}
		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);
		const inUser = (userEntries?.length ?? 0) > 0;
		const inProject = (projectEntries?.length ?? 0) > 0;
		if (!inUser && !inProject) throw new Error(`Plugin "${pluginId}" is not installed`);

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) throw new Error(`Plugin "${pluginId}" is installed in both scopes. Specify one.`);
			targetScope = scope;
		} else targetScope = inProject ? "project" : "user";

		const reg = targetScope === "project" ? projectReg : userReg;
		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		const updated = { ...reg, plugins: { ...reg.plugins, [pluginId]: entries.map(e => ({ ...e, enabled })) } };
		await writeInstalledPluginsRegistry(this.#registryPath(targetScope), updated);

		this.#clearCache();
		logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
	}

	// ── Update / upgrade ─────────────────────────────────────────────────────

	async refreshStaleMarketplaces(): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const staleMs = 24 * 60 * 60 * 1000;
		await Promise.all(
			reg.marketplaces.map(async entry => {
				if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
					try {
						await this.updateMarketplace(entry.name);
					} catch {}
				}
			}),
		);
	}

	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath)
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const update = await this.#checkPluginUpdate(pluginId, entries[0], scope, mktReg);
				if (update) updates.push(update);
			}
		}
		return updates;
	}

	async #checkPluginUpdate(
		pluginId: string,
		installed: InstalledPluginEntry | undefined,
		scope: "user" | "project",
		mktReg: { marketplaces: MarketplaceRegistryEntry[] },
	): Promise<{ pluginId: string; scope: "user" | "project"; from: string; to: string } | null> {
		if (!installed) return null;
		const parsed = parsePluginId(pluginId);
		if (!parsed) return null;

		const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
		if (!mktEntry) return null;

		let catalogVersion: string | undefined;
		try {
			const catalog = await this.#readCatalog(mktEntry);
			catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
		} catch {
			return null;
		}

		if (!catalogVersion || catalogVersion === installed.version) return null;

		let isNewer: boolean;
		try {
			isNewer = Bun.semver.order(catalogVersion, installed.version) > 0;
		} catch {
			isNewer = catalogVersion !== installed.version;
		}

		return isNewer ? { pluginId, scope, from: installed.version, to: catalogVersion } : null;
	}

	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) throw new Error(`Invalid plugin ID: "${pluginId}".`);
		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);
		const inUser = (userEntries?.length ?? 0) > 0;
		const inProject = (projectEntries?.length ?? 0) > 0;
		if (!inUser && !inProject) throw new Error(`Plugin "${pluginId}" is not installed`);

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) throw new Error(`Plugin "${pluginId}" is installed in both scopes. Specify one.`);
			resolvedScope = scope;
		} else resolvedScope = inProject ? "project" : "user";

		return this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: resolvedScope });
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) throw new Error("project scope requires project directory");
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		try {
			const content = await Bun.file(entry.catalogPath).text();
			return parseMarketplaceCatalog(content, entry.catalogPath);
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Catalog not found at ${entry.catalogPath}.`);
			throw error;
		}
	}

	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(os.homedir(), entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		return path.dirname(entry.catalogPath);
	}
}
