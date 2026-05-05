import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { SpecialHandler } from "./types";
import { buildResult, htmlToBasicMarkdown, loadPage } from "./types";

interface MDNSection {
	type: string;
	value: {
		id?: string;
		title?: string;
		content?: string;
		isH3?: boolean;
		code?: string;
		language?: string;
		items?: Array<{ term: string; description: string }>;
		rows?: string[][];
	};
}

interface MDNDoc {
	doc: {
		title: string;
		summary: string;
		mdn_url: string;
		body: MDNSection[];
		browserCompat?: unknown;
	};
}

/**
 * Convert MDN body sections to markdown
 */
function convertMDNBody(sections: MDNSection[]): string {
	const parts: string[] = [];

	for (const section of sections) {
		const { type, value } = section;

		switch (type) {
			case "prose":
				renderProse(value, parts);
				break;
			case "browser_compatibility":
			case "specifications":
				renderMetadataSection(type, value, parts);
				break;
			case "code_example":
				renderCodeExample(value, parts);
				break;
			case "definition_list":
				renderDefinitionList(value, parts);
				break;
			case "table":
				renderTable(value, parts);
				break;
			default:
				break;
		}
	}

	return parts.join("\n\n");
}

function renderProse(value: MDNSection["value"], parts: string[]): void {
	if (value.content === null || value.content === undefined || value.content === "") return;
	const markdown = htmlToBasicMarkdown(value.content);
	if (value.title !== null && value.title !== undefined && value.title !== "") {
		const level = value.isH3 === true ? "###" : "##";
		parts.push(`${level} ${value.title}\n\n${markdown}`);
	} else {
		parts.push(markdown);
	}
}

function renderMetadataSection(type: string, value: MDNSection["value"], parts: string[]): void {
	if (value.title === null || value.title === undefined || value.title === "") return;
	const label = type === "browser_compatibility" ? "browser compatibility" : "specifications";
	parts.push(`## ${value.title}\n\n(See ${label} data at MDN)`);
}

function renderCodeExample(value: MDNSection["value"], parts: string[]): void {
	if (value.title !== null && value.title !== undefined && value.title !== "") {
		parts.push(`### ${value.title}`);
	}
	if (value.code !== null && value.code !== undefined && value.code !== "") {
		const lang = value.language ?? "";
		parts.push(`\`\`\`${lang}\n${value.code}\n\`\`\``);
	}
}

function renderDefinitionList(value: MDNSection["value"], parts: string[]): void {
	if (!value.items) return;
	for (const item of value.items) {
		parts.push(`**${item.term}**`);
		parts.push(htmlToBasicMarkdown(item.description));
	}
}

function renderTable(value: MDNSection["value"], parts: string[]): void {
	if (!value.rows || value.rows.length === 0) return;
	const header = value.rows[0].map(cell => htmlToBasicMarkdown(cell)).join(" | ");
	const separator = value.rows[0].map(() => "---").join(" | ");
	const bodyRows = value.rows.slice(1).map(row => row.map(cell => htmlToBasicMarkdown(cell)).join(" | "));

	parts.push(`| ${header} |`);
	parts.push(`| ${separator} |`);
	for (const row of bodyRows) {
		parts.push(`| ${row} |`);
	}
}

export const handleMDN: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	const urlObj = new URL(url);

	// Only handle developer.mozilla.org
	if (!urlObj.hostname.includes("developer.mozilla.org")) {
		return null;
	}

	// Only handle docs paths
	if (!urlObj.pathname.includes("/docs/")) {
		return null;
	}

	const notes: string[] = [];

	// Construct JSON API URL
	const jsonUrl = url.replace(/\/?$/, "/index.json");

	try {
		const result = await loadPage(jsonUrl, { timeout, signal, headers: { Accept: "application/json" } });

		if (!result.ok) {
			notes.push(`Failed to fetch MDN JSON API (status ${result.status ?? "unknown"})`);
			return null;
		}

		const data = tryParseJson<MDNDoc>(result.content);
		if (data?.doc?.title === null || data?.doc?.title === undefined || data?.doc?.title === "") {
			notes.push("Invalid MDN JSON structure");
			return null;
		}

		const { doc } = data;

		// Build markdown content
		const parts: string[] = [];

		parts.push(`# ${doc.title}`);

		if (doc.summary) {
			const summary = htmlToBasicMarkdown(doc.summary);
			parts.push(summary);
		}

		if (doc.body && doc.body.length > 0) {
			const bodyMarkdown = convertMDNBody(doc.body);
			parts.push(bodyMarkdown);
		}

		const rawContent = parts.join("\n\n");

		return buildResult(rawContent, {
			url,
			finalUrl: doc.mdn_url || result.finalUrl,
			method: "mdn",
			fetchedAt: new Date().toISOString(),
			notes,
		});
	} catch (error) {
		notes.push(`MDN handler error: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
};
