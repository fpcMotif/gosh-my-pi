import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { LocalizedText, RenderResult, SpecialHandler } from "./types";
import { buildResult, getLocalizedText, loadPage } from "./types";

type FdroidPackage = {
	packageName?: string;
	name?: LocalizedText;
	summary?: LocalizedText;
	description?: LocalizedText;
	author?: string | { name?: string; email?: string };
	authorName?: string;
	authorEmail?: string;
	license?: string;
	categories?: string[];
	antiFeatures?: string[];
	sourceCode?: string;
	packages?: Array<{
		versionName?: string;
		versionCode?: number;
		added?: number;
		antiFeatures?: string[];
	}>;
	suggestedVersionCode?: number;
	suggestedVersionName?: string;
};

function normalizeAuthor(data: FdroidPackage): string | undefined {
	if (data.authorName !== null && data.authorName !== undefined && data.authorName !== "") return data.authorName;
	if (typeof data.author === "string") return data.author;
	if (data.author && typeof data.author !== "string" && typeof data.author.name === "string") return data.author.name;
	if (data.authorEmail !== null && data.authorEmail !== undefined && data.authorEmail !== "") return data.authorEmail;
	return undefined;
}

function normalizeAuthorEmail(data: FdroidPackage): string | undefined {
	if (data.authorEmail !== null && data.authorEmail !== undefined && data.authorEmail !== "") return data.authorEmail;
	if (data.author && typeof data.author !== "string" && typeof data.author.email === "string")
		return data.author.email;
	return undefined;
}

function collectAntiFeatures(data: FdroidPackage): string[] {
	const values = new Set<string>();
	for (const feature of data.antiFeatures ?? []) values.add(feature);
	for (const pkg of data.packages ?? []) {
		for (const feature of pkg.antiFeatures ?? []) values.add(feature);
	}
	return Array.from(values);
}

function resolveSuggestedVersion(data: FdroidPackage): string | undefined {
	if (
		data.suggestedVersionName !== null &&
		data.suggestedVersionName !== undefined &&
		data.suggestedVersionName !== ""
	)
		return data.suggestedVersionName;
	if (
		data.suggestedVersionCode !== null &&
		data.suggestedVersionCode !== undefined &&
		data.suggestedVersionCode !== 0
	) {
		const match = data.packages?.find(pkg => pkg.versionCode === data.suggestedVersionCode);
		if (match?.versionName !== null && match?.versionName !== undefined && match?.versionName !== "")
			return match.versionName;
	}
	return data.packages?.[0]?.versionName;
}

/**
 * Handle F-Droid URLs via API
 */
export const handleFdroid: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "f-droid.org" && parsed.hostname !== "www.f-droid.org") return null;

		// Extract package name from /packages/{packageName} or /en/packages/{packageName}
		const match = parsed.pathname.match(/^\/(?:en\/)?packages\/([^/]+)/);
		if (!match) return null;

		const packageName = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();
		const apiUrl = `https://f-droid.org/api/v1/packages/${encodeURIComponent(packageName)}`;

		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return null;

		const data = tryParseJson<FdroidPackage>(result.content);
		if (!data) return null;

		const displayName = getLocalizedText(data.name) ?? packageName;
		const summary = getLocalizedText(data.summary);
		const description = getLocalizedText(data.description);
		const author = normalizeAuthor(data);
		const authorEmail = normalizeAuthorEmail(data);
		const antiFeatures = collectAntiFeatures(data);
		const latestVersion = resolveSuggestedVersion(data);

		let md = `# ${displayName}\n\n`;
		if (summary !== null && summary !== undefined && summary !== "") md += `${summary}\n\n`;

		md += `**Package:** ${packageName}`;
		if (latestVersion !== null && latestVersion !== undefined && latestVersion !== "")
			md += ` · **Latest:** ${latestVersion}`;
		if (data.license !== null && data.license !== undefined && data.license !== "")
			md += ` · **License:** ${data.license}`;
		md += "\n";

		if (author !== null && author !== undefined && author !== "") {
			md += `**Author:** ${author}`;
			if (authorEmail !== null && authorEmail !== undefined && authorEmail !== "" && authorEmail !== author)
				md += ` <${authorEmail}>`;
			md += "\n";
		}

		if (data.sourceCode !== null && data.sourceCode !== undefined && data.sourceCode !== "")
			md += `**Source Code:** ${data.sourceCode}\n`;
		if (data.categories?.length !== null && data.categories?.length !== undefined && data.categories?.length !== 0)
			md += `**Categories:** ${data.categories.join(", ")}\n`;
		if (antiFeatures.length) md += `**Anti-Features:** ${antiFeatures.join(", ")}\n`;

		if (description !== null && description !== undefined && description !== "") {
			md += `\n## Description\n\n${description}\n`;
		}

		if (data.packages?.length !== null && data.packages?.length !== undefined && data.packages?.length !== 0) {
			md += "\n## Version History\n\n";
			for (const version of data.packages.slice(0, 10)) {
				const label = version.versionName ?? "unknown";
				const code =
					version.versionCode !== null && version.versionCode !== undefined && version.versionCode !== 0
						? ` (${version.versionCode})`
						: "";
				md += `- ${label}${code}\n`;
			}
		}

		return buildResult(md, { url, method: "fdroid", fetchedAt, notes: ["Fetched via F-Droid API"] });
	} catch {}

	return null;
};
