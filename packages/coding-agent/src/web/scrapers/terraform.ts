import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface TerraformModule {
	id: string;
	namespace: string;
	name: string;
	provider: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	verified?: boolean;
	root?: {
		inputs?: Array<{
			name: string;
			type?: string;
			description?: string;
			default?: unknown;
			required?: boolean;
		}>;
		outputs?: Array<{
			name: string;
			description?: string;
		}>;
		dependencies?: Array<{
			name: string;
			source: string;
			version?: string;
		}>;
		resources?: Array<{
			name: string;
			type: string;
		}>;
	};
	submodules?: Array<{
		path: string;
		name: string;
	}>;
}

interface TerraformProvider {
	id: string;
	namespace: string;
	name: string;
	alias?: string;
	version: string;
	description?: string;
	source?: string;
	published_at?: string;
	downloads: number;
	tier?: string;
	logo_url?: string;
	docs?: Array<{
		id: string;
		title: string;
		path: string;
		slug: string;
		category: string;
	}>;
}

/**
 * Handle Terraform Registry URLs via API
 */
export const handleTerraform: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("registry.terraform.io")) return null;

		const fetchedAt = new Date().toISOString();

		// Match module URL: /modules/{namespace}/{name}/{provider}
		const moduleMatch = parsed.pathname.match(/^\/modules\/([^/]+)\/([^/]+)\/([^/]+)/);
		if (moduleMatch) {
			const [, namespace, name, provider] = moduleMatch;
			return await handleModuleUrl(url, namespace, name, provider, timeout, signal, fetchedAt);
		}

		// Match provider URL: /providers/{namespace}/{type}
		const providerMatch = parsed.pathname.match(/^\/providers\/([^/]+)\/([^/]+)/);
		if (providerMatch) {
			const [, namespace, type] = providerMatch;
			return await handleProviderUrl(url, namespace, type, timeout, signal, fetchedAt);
		}

		return null;
	} catch {}

	return null;
};

async function handleModuleUrl(
	url: string,
	namespace: string,
	name: string,
	provider: string,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
): Promise<RenderResult | null> {
	const apiUrl = `https://registry.terraform.io/v1/modules/${namespace}/${name}/${provider}`;
	const result = await loadPage(apiUrl, { timeout, signal, headers: { Accept: "application/json" } });

	if (!result.ok) return null;

	const mod = tryParseJson<TerraformModule>(result.content);
	if (!mod) return null;

	let md = `# ${mod.namespace}/${mod.name}/${mod.provider}\n\n`;
	if (mod.description !== null && mod.description !== undefined && mod.description !== "")
		md += `${mod.description}\n\n`;

	md += `**Version:** ${mod.version}${mod.verified === true ? " ✓ Verified" : ""}\n`;
	md += `**Downloads:** ${formatNumber(mod.downloads)}\n`;
	if (mod.published_at) md += `**Published:** ${new Date(mod.published_at).toLocaleDateString()}\n`;
	if (mod.source) md += `**Source:** ${mod.source}\n`;
	md += "\n";

	md += `## Usage\n\n\`\`\`hcl\nmodule "${mod.name}" {\n  source  = "${mod.namespace}/${mod.name}/${mod.provider}"\n  version = "${mod.version}"\n}\n\`\`\`\n\n`;

	md += formatModuleInputs(mod.root?.inputs);
	md += formatModuleOutputs(mod.root?.outputs);
	md += formatModuleDependencies(mod.root?.dependencies);
	md += formatModuleResources(mod.root?.resources);
	md += formatModuleSubmodules(mod.submodules);

	return buildResult(md, { url, method: "terraform", fetchedAt, notes: ["Fetched via Terraform Registry API"] });
}

function formatModuleInputs(inputs?: TerraformModule["root"]["inputs"]): string {
	if (!inputs || inputs.length === 0) return "";
	let md = `## Inputs (${inputs.length})\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n`;
	for (const input of inputs.slice(0, 30)) {
		const required = (input.required ?? input.default === undefined) ? "Yes" : "No";
		const desc = (input.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);
		md += `| ${input.name} | \`${input.type ?? "any"}\` | ${required} | ${desc} |\n`;
	}
	if (inputs.length > 30) md += `\n*... and ${inputs.length - 30} more inputs*\n`;
	return `${md}\n`;
}

function formatModuleOutputs(outputs?: TerraformModule["root"]["outputs"]): string {
	if (!outputs || outputs.length === 0) return "";
	let md = `## Outputs (${outputs.length})\n\n`;
	for (const output of outputs.slice(0, 20)) {
		md += `- **${output.name}**`;
		if (output.description) md += `: ${output.description.replace(/\n/g, " ").slice(0, 100)}`;
		md += "\n";
	}
	if (outputs.length > 20) md += `\n*... and ${outputs.length - 20} more outputs*\n`;
	return `${md}\n`;
}

function formatModuleDependencies(deps?: TerraformModule["root"]["dependencies"]): string {
	if (!deps || deps.length === 0) return "";
	let md = `## Dependencies (${deps.length})\n\n`;
	for (const dep of deps.slice(0, 15)) {
		md += `- **${dep.name}**: ${dep.source}${dep.version ? ` (${dep.version})` : ""}\n`;
	}
	if (deps.length > 15) md += `\n*... and ${deps.length - 15} more dependencies*\n`;
	return `${md}\n`;
}

function formatModuleResources(resources?: TerraformModule["root"]["resources"]): string {
	if (!resources || resources.length === 0) return "";
	let md = `## Resources (${resources.length})\n\n`;
	for (const res of resources.slice(0, 20)) md += `- \`${res.type}\` (${res.name})\n`;
	if (resources.length > 20) md += `\n*... and ${resources.length - 20} more resources*\n`;
	return `${md}\n`;
}

function formatModuleSubmodules(submodules?: TerraformModule["submodules"]): string {
	if (!submodules || submodules.length === 0) return "";
	let md = `## Submodules (${submodules.length})\n\n`;
	for (const sub of submodules.slice(0, 10)) md += `- **${sub.name}**: \`${sub.path}\`\n`;
	if (submodules.length > 10) md += `\n*... and ${submodules.length - 10} more submodules*\n`;
	return md;
}

async function handleProviderUrl(
	url: string,
	namespace: string,
	type: string,
	timeout: number,
	signal: AbortSignal | undefined,
	fetchedAt: string,
): Promise<RenderResult | null> {
	const apiUrl = `https://registry.terraform.io/v1/providers/${namespace}/${type}`;
	const result = await loadPage(apiUrl, { timeout, signal, headers: { Accept: "application/json" } });

	if (!result.ok) return null;

	const provider = tryParseJson<TerraformProvider>(result.content);
	if (!provider) return null;

	let md = `# ${provider.namespace}/${provider.name}\n\n`;
	if (provider.description) md += `${provider.description}\n\n`;

	md += `**Version:** ${provider.version}\n`;
	if (provider.tier) md += `**Tier:** ${provider.tier}\n`;
	md += `**Downloads:** ${formatNumber(provider.downloads)}\n`;
	if (provider.published_at) md += `**Published:** ${new Date(provider.published_at).toLocaleDateString()}\n`;
	if (provider.source) md += `**Source:** ${provider.source}\n\n`;

	md += `## Usage\n\n\`\`\`hcl\nterraform {\n  required_providers {\n    ${provider.name} = {\n      source  = "${provider.namespace}/${provider.name}"\n      version = "~> ${provider.version}"\n    }\n  }\n}\n\nprovider "${provider.name}" {\n  # Configuration options\n}\n\`\`\`\n\n`;

	if (provider.docs && provider.docs.length > 0) {
		md += formatProviderDocs(provider.docs, namespace, type);
	}

	return buildResult(md, { url, method: "terraform", fetchedAt, notes: ["Fetched via Terraform Registry API"] });
}

function formatProviderDocs(docs: TerraformProvider["docs"] & any[], namespace: string, type: string): string {
	const categories = new Map<string, any[]>();
	for (const doc of docs) {
		const cat = doc.category || "other";
		if (!categories.has(cat)) categories.set(cat, []);
		categories.get(cat)!.push(doc);
	}

	let md = `## Documentation\n\n`;
	for (const [category, catDocs] of categories) {
		md += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${catDocs.length})\n\n`;
		for (const doc of catDocs.slice(0, 15)) {
			md += `- [${doc.title}](https://registry.terraform.io/providers/${namespace}/${type}/latest/docs/${doc.category}/${doc.slug})\n`;
		}
		if (catDocs.length > 15) md += `\n*... and ${catDocs.length - 15} more*\n`;
		md += "\n";
	}
	return md;
}
