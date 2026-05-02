/**
 * Custom share script loader.
 *
 * Allows users to define a custom share handler at ~/.omp/agent/share.ts
 * that will be used instead of the default GitHub Gist sharing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export interface CustomShareResult {
	/** URL to display/open (optional - script may handle everything itself) */
	url?: string;
	/** Additional message to show the user */
	message?: string;
}

export type CustomShareFn = (htmlPath: string) => Promise<CustomShareResult | string | undefined>;

interface LoadedCustomShare {
	path: string;
	fn: CustomShareFn;
}

const SHARE_SCRIPT_CANDIDATES = ["share.ts", "share.js", "share.mjs"];

/**
 * Get the path to the custom share script if it exists.
 */
export function getCustomSharePath(): string | null {
	const agentDir = getAgentDir();

	for (const candidate of SHARE_SCRIPT_CANDIDATES) {
		const scriptPath = path.join(agentDir, candidate);
		if (fs.existsSync(scriptPath)) {
			return scriptPath;
		}
	}

	return null;
}

/**
 * Load the custom share script if it exists.
 */
export async function loadCustomShare(): Promise<LoadedCustomShare | null> {
	const scriptPath = getCustomSharePath();
	if (scriptPath === null || scriptPath === undefined || scriptPath === "") {
		return null;
	}

	try {
		const module = await import(scriptPath);
		const fn = module.default;

		if (typeof fn !== "function") {
			throw new Error("share script must export a default function");
		}

		return { path: scriptPath, fn };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load share script: ${message}`);
	}
}
