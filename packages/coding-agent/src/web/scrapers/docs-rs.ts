import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getAgentDir, isEnoent, logger, ptree, tryParseJson } from "@oh-my-pi/pi-utils";
import { ToolAbortError } from "../../tools/tool-errors";
import {
	type DocsRsTarget,
	findItemInModule,
	renderModule,
	renderSingleItem,
	type RustdocCrate,
	type RustdocItem,
} from "./docs-rs-render";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, MAX_BYTES } from "./types";

// --- URL parsing ---

const ITEM_PAGE_REGEX = /^(struct|trait|fn|enum|macro|type|constant|static|attr|derive|union|primitive)\.(.+)\.html$/;

function parseDocsRsUrl(url: string): DocsRsTarget | null {
	const parsed = new URL(url);
	if (parsed.hostname !== "docs.rs") return null;

	const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

	// Skip /crate/{name}/{version} overview pages - those are docs.rs chrome, not rustdoc
	if (segments[0] === "crate") return null;
	// Rustdoc pages: /{crate}/{version}/{crate_path}/[item.html]
	if (segments.length < 3) return null;

	const crateName = segments[0];
	const version = segments[1];
	if (crateName === undefined || version === undefined) return null;

	const rest = segments.slice(2);
	let itemKind: string | null = null;
	let itemName: string | null = null;

	const last = rest[rest.length - 1];
	const itemMatch = last?.match(ITEM_PAGE_REGEX);
	if (itemMatch) {
		itemKind = itemMatch[1] ?? null;
		itemName = itemMatch[2] ?? null;
		rest.pop();
	} else if (last === "index.html") {
		rest.pop();
	}

	return { crateName, version, modulePath: rest, itemKind, itemName };
}

// --- Cache ---

const DOCS_RS_CACHE_ROOT = "webcache";
const DOCS_RS_CACHE_FILENAME = "rustdoc.json";

function sanitizeCacheSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function getDocsRsCacheVersionSegment(version: string, now = new Date()): string {
	if (version !== "latest") return sanitizeCacheSegment(version);
	return now.toISOString().slice(0, 10);
}

function getDocsRsCachePath(target: DocsRsTarget, now = new Date()): string {
	const crate = sanitizeCacheSegment(target.crateName);
	const version = getDocsRsCacheVersionSegment(target.version, now);
	return path.join(getAgentDir(), DOCS_RS_CACHE_ROOT, `docsrs_${crate}_${version}`, DOCS_RS_CACHE_FILENAME);
}

async function readCachedRustdocCrate(
	target: DocsRsTarget,
): Promise<{ crate: RustdocCrate; fetchedAt: string } | null> {
	const cachePath = getDocsRsCachePath(target);
	try {
		const [jsonStr, stat] = await Promise.all([Bun.file(cachePath).text(), fs.stat(cachePath)]);
		const crate = tryParseJson<RustdocCrate>(jsonStr);
		if (!crate?.index) return null;
		return { crate, fetchedAt: stat.mtime.toISOString() };
	} catch (error) {
		if (isEnoent(error)) return null;
		logger.warn("Failed to read docs.rs cache", { path: cachePath, error: String(error) });
		return null;
	}
}

async function writeCachedRustdocCrate(target: DocsRsTarget, json: string): Promise<void> {
	const cachePath = getDocsRsCachePath(target);
	try {
		await Bun.write(cachePath, json);
	} catch (error) {
		logger.warn("Failed to write docs.rs cache", { path: cachePath, error: String(error) });
	}
}

// --- Fetching ---

async function readResponseChunks(
	reader: ReturnType<NonNullable<Response["body"]>["getReader"]>,
): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	const r = reader as unknown as {
		read: () => Promise<{ done: boolean; value?: Uint8Array }>;
		cancel: () => Promise<void>;
	};
	const pump = async (): Promise<void> => {
		const { done, value } = await r.read();
		if (done) return;
		if (value) {
			chunks.push(value);
			totalSize += value.length;
			if (totalSize > MAX_BYTES) {
				void r.cancel();
				return;
			}
		}
		await pump();
	};
	await pump();
	return chunks;
}

async function fetchRustdocCrate(
	target: DocsRsTarget,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<RustdocCrate | null> {
	const jsonUrl = `https://docs.rs/crate/${target.crateName}/${target.version}/json.gz`;
	try {
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);
		const response = await fetch(jsonUrl, {
			signal: requestSignal,
			headers: { "User-Agent": "omp-web-fetch/1.0", Accept: "application/gzip" },
			redirect: "follow",
		});
		if (!response.ok) return null;

		const reader = response.body?.getReader();
		if (!reader) return null;

		const chunks = await readResponseChunks(reader);
		const compressed = Buffer.concat(chunks);
		const jsonStr = gunzipSync(compressed).toString("utf-8");
		const crate = tryParseJson<RustdocCrate>(jsonStr);
		if (crate?.index) {
			await writeCachedRustdocCrate(target, jsonStr);
		}
		return crate;
	} catch {
		if (signal?.aborted === true) throw new ToolAbortError();
		return null;
	}
}

function walkToTargetModule(
	root: RustdocItem,
	target: DocsRsTarget,
	index: Record<string, RustdocItem>,
): RustdocItem | null {
	let currentItem: RustdocItem = root;
	const subPath = target.modulePath.slice(1);
	for (const seg of subPath) {
		const innerMod = currentItem.inner as { module?: { items: number[] } };
		const modData = innerMod.module;
		if (!modData?.items) return null;
		const child = modData.items
			.map(id => index[String(id)])
			.find(it => it?.name === seg && "module" in (it?.inner ?? {}));
		if (!child) return null;
		currentItem = child;
	}
	return currentItem;
}

function buildRenderForTarget(target: DocsRsTarget, crate_: RustdocCrate, currentItem: RustdocItem): string | null {
	if (target.itemName !== null && target.itemName !== "") {
		const found = findItemInModule(currentItem, target.itemName, crate_.index);
		if (!found) return null;
		return renderSingleItem(found, crate_.index, crate_);
	}
	return renderModule(currentItem, crate_.index, crate_, target);
}

function buildRenderResult(
	url: string,
	target: DocsRsTarget,
	crate_: RustdocCrate,
	fetchedAt: string,
	notes: string[],
): RenderResult | null {
	const root = crate_.index[String(crate_.root)];
	if (root === undefined) return null;
	const currentItem = walkToTargetModule(root, target, crate_.index);
	if (currentItem === null) return null;
	const rendered = buildRenderForTarget(target, crate_, currentItem);
	if (rendered === null) return null;
	return buildResult(rendered, { url, method: "docs.rs", fetchedAt, notes });
}

// --- Main handler ---

export const handleDocsRs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	const target = parseDocsRsUrl(url);
	if (!target) return null;

	const cached = await readCachedRustdocCrate(target);
	if (cached) {
		return buildRenderResult(url, target, cached.crate, cached.fetchedAt, ["Loaded from docs.rs rustdoc JSON cache"]);
	}

	const crate_ = await fetchRustdocCrate(target, timeout, signal);
	if (!crate_?.index) return null;
	return buildRenderResult(url, target, crate_, new Date().toISOString(), ["Fetched via docs.rs rustdoc JSON"]);
};
