import { tryParseJson } from "@oh-my-pi/pi-utils";
import { parseHTML } from "linkedom";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, htmlToBasicMarkdown, loadPage } from "./types";

interface GoModuleInfo {
	Version: string;
	Time: string;
}

interface ParsedPath {
	modulePath: string;
	version: string;
}

function parsePkgGoUrl(pathname: string): ParsedPath | null {
	if (pathname === "") return null;
	const atIndex = pathname.indexOf("@");
	if (atIndex === -1) return { modulePath: pathname, version: "latest" };
	const beforeAt = pathname.slice(0, atIndex);
	const afterAt = pathname.slice(atIndex + 1);
	const slashIndex = afterAt.indexOf("/");
	const version = slashIndex === -1 ? afterAt : afterAt.slice(0, slashIndex);
	return { modulePath: beforeAt, version };
}

async function fetchModuleInfo(
	modulePath: string,
	version: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<GoModuleInfo | null> {
	const proxyUrl =
		version === "latest"
			? `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@latest`
			: `https://proxy.golang.org/${encodeURIComponent(modulePath)}/@v/${encodeURIComponent(version)}.info`;
	try {
		const proxyResult = await loadPage(proxyUrl, { timeout, signal });
		if (!proxyResult.ok) return null;
		return tryParseJson<GoModuleInfo>(proxyResult.content);
	} catch {
		return null;
	}
}

function extractActualModulePath(doc: Document, fallback: string): string {
	const breadcrumb = doc.querySelector(".go-Breadcrumb");
	if (breadcrumb === null) return fallback;
	const moduleLink = breadcrumb.querySelector("a[href^='/']");
	if (moduleLink === null) return fallback;
	const href = moduleLink.getAttribute("href");
	if (href === null) return fallback;
	const stripped = href.slice(1).split("@")[0];
	return stripped === undefined || stripped === "" ? fallback : stripped;
}

function extractPageVersion(doc: Document, fallback: string): string {
	const versionBadge = doc.querySelector(".go-Chip");
	if (versionBadge === null) return fallback;
	const versionText = versionBadge.textContent?.trim();
	if (versionText === undefined || !versionText.startsWith("v")) return fallback;
	return versionText;
}

function extractLicense(doc: Document): string {
	const licenseLink = doc.querySelector("a[data-test-id='UnitHeader-license']");
	const text = licenseLink?.textContent?.trim();
	return text === undefined || text === "" ? "Unknown" : text;
}

function extractImportPath(doc: Document, fallback: string): string {
	const importPathInput = doc.querySelector("input[data-test-id='UnitHeader-importPath']");
	const value = importPathInput?.getAttribute("value");
	return value === null || value === undefined || value === "" ? fallback : value;
}

function buildHeaderSection(importPath: string, modulePath: string, version: string, license: string): string[] {
	return [
		`# ${importPath}`,
		"",
		`**Module:** ${modulePath}`,
		`**Version:** ${version}`,
		`**License:** ${license}`,
		"",
	];
}

function buildSynopsisSection(doc: Document): string[] {
	const synopsis = doc.querySelector(".go-Main-headerContent p");
	if (synopsis === null) return [];
	const synopsisText = synopsis.textContent?.trim();
	if (synopsisText === undefined || synopsisText === "") return [];
	return ["## Synopsis", "", synopsisText, ""];
}

function buildDocOverview(docSection: Element): string[] {
	const overview = docSection.querySelector(".go-Message");
	if (overview === null) return [];
	return [htmlToBasicMarkdown(overview.innerHTML), ""];
}

function buildDocParagraphs(docSection: Element): string[] {
	const docContent = docSection.querySelector(".Documentation-content");
	if (docContent === null) return [];
	const paragraphs = docContent.querySelectorAll("p");
	const docParts: string[] = [];
	for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
		const p = paragraphs[i];
		if (!p) continue;
		const text = htmlToBasicMarkdown(p.innerHTML).trim();
		if (text !== "") docParts.push(text);
	}
	return docParts.length === 0 ? [] : [docParts.join("\n\n"), ""];
}

function buildDocumentationSection(doc: Document): string[] {
	const docSection = doc.querySelector("#section-documentation");
	if (docSection === null) return [];
	return ["## Documentation", "", ...buildDocOverview(docSection), ...buildDocParagraphs(docSection)];
}

function collectIndexExports(indexList: Element): string[] {
	const items = indexList.querySelectorAll("li");
	const exported: string[] = [];
	for (const item of items) {
		const link = item.querySelector("a");
		if (link === null) continue;
		const name = link.textContent?.trim();
		if (name === undefined || name === "") continue;
		exported.push(`- ${name}`);
	}
	return exported;
}

function buildIndexSection(doc: Document, notes: string[]): string[] {
	const indexSection = doc.querySelector("#section-index");
	if (indexSection === null) return [];
	const indexList = indexSection.querySelector(".Documentation-indexList");
	if (indexList === null) return [];
	const exported = collectIndexExports(indexList);
	if (exported.length === 0) return [];
	const sections = ["## Index", "", exported.slice(0, 50).join("\n")];
	if (exported.length > 50) {
		notes.push(`showing 50 of ${exported.length} exports`);
		sections.push(`\n... and ${exported.length - 50} more`);
	}
	sections.push("");
	return sections;
}

function collectImportLinks(importsList: Element): string[] {
	const links = importsList.querySelectorAll("a");
	const imports: string[] = [];
	for (const link of links) {
		const imp = link.textContent?.trim();
		if (imp === undefined || imp === "") continue;
		imports.push(`- ${imp}`);
	}
	return imports;
}

function buildImportsSection(doc: Document, notes: string[]): string[] {
	const importsSection = doc.querySelector("#section-imports");
	if (importsSection === null) return [];
	const importsList = importsSection.querySelector(".go-Message");
	if (importsList === null) return [];
	const imports = collectImportLinks(importsList);
	if (imports.length === 0) return [];
	const sections = ["## Imports", "", imports.slice(0, 20).join("\n")];
	if (imports.length > 20) {
		notes.push(`showing 20 of ${imports.length} imports`);
		sections.push(`\n... and ${imports.length - 20} more`);
	}
	sections.push("");
	return sections;
}

type Document = ReturnType<typeof parseHTML>["document"];
type Element = NonNullable<ReturnType<Document["querySelector"]>>;

function buildAllSections(
	doc: Document,
	importPath: string,
	actualModulePath: string,
	version: string,
	license: string,
	notes: string[],
): string[] {
	return [
		...buildHeaderSection(importPath, actualModulePath, version, license),
		...buildSynopsisSection(doc),
		...buildDocumentationSection(doc),
		...buildIndexSection(doc, notes),
		...buildImportsSection(doc, notes),
	];
}

export const handleGoPkg: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "pkg.go.dev") return null;
		const parsedPath = parsePkgGoUrl(parsed.pathname.slice(1));
		if (parsedPath === null) return null;
		const { modulePath } = parsedPath;
		let { version } = parsedPath;

		const moduleInfo = await fetchModuleInfo(modulePath, version, timeout, signal);
		if (moduleInfo !== null && version === "latest") version = moduleInfo.Version;

		const pageResult = await loadPage(url, { timeout, signal });
		if (!pageResult.ok) {
			return buildResult(`Failed to fetch pkg.go.dev page (status: ${pageResult.status ?? "unknown"})`, {
				url,
				finalUrl: pageResult.finalUrl,
				method: "go-pkg",
				fetchedAt: new Date().toISOString(),
				notes: ["error"],
				contentType: "text/plain",
			});
		}

		const doc = parseHTML(pageResult.content).document;
		const actualModulePath = extractActualModulePath(doc, modulePath);
		if (moduleInfo === null) version = extractPageVersion(doc, version);
		const license = extractLicense(doc);
		const importPath = extractImportPath(doc, actualModulePath);

		const notes: string[] = [];
		const sections = buildAllSections(doc, importPath, actualModulePath, version, license, notes);
		if (moduleInfo !== null) notes.push(`published ${moduleInfo.Time}`);

		return buildResult(sections.join("\n"), {
			url,
			finalUrl: pageResult.finalUrl,
			method: "go-pkg",
			fetchedAt: new Date().toISOString(),
			notes,
		});
	} catch {
		return null;
	}
};
