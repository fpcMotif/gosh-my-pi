import * as path from "node:path";
import { Glob } from "bun";
import { getProjectDir } from "./dirs";

export interface GlobPathsOptions {
	/** Base directory for glob patterns. Defaults to getProjectDir(). */
	cwd?: string;
	/** Glob exclusion patterns. */
	exclude?: string[];
	/** Abort signal to cancel the glob. */
	signal?: AbortSignal;
	/** Timeout in milliseconds for the glob operation. */
	timeoutMs?: number;
	/** Include dotfiles when true. */
	dot?: boolean;
	/** Only return files (skip directories). Default: true. */
	onlyFiles?: boolean;
	/** Respect .gitignore files when true. Walks up directory tree to find all applicable .gitignore files. */
	gitignore?: boolean;
}

/** Patterns always excluded (.git is never useful in glob results). */
const ALWAYS_IGNORED = ["**/.git", "**/.git/**"];

/** node_modules exclusion patterns (skipped if pattern explicitly references node_modules). */
const NODE_MODULES_IGNORED = ["**/node_modules", "**/node_modules/**"];

/**
 * Parse a single .gitignore file and return glob-compatible exclude patterns.
 * @param content - Raw content of the .gitignore file
 * @param gitignoreDir - Absolute path to the directory containing the .gitignore
 * @param baseDir - Absolute path to the glob's cwd (for relativizing rooted patterns)
 */
function parseGitignorePatterns(content: string, gitignoreDir: string, baseDir: string): string[] {
	const patterns: string[] = [];

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		// Skip empty lines and comments
		if (!line || line.startsWith("#")) {
			continue;
		}
		// Skip negation patterns (unsupported for simple exclude)
		if (line.startsWith("!")) {
			continue;
		}

		let pattern = line;

		// Handle trailing slash (directory-only match)
		// For glob exclude, we treat it as matching the dir and its contents
		const isDirectoryOnly = pattern.endsWith("/");
		if (isDirectoryOnly) {
			pattern = pattern.slice(0, -1);
		}

		// Handle rooted patterns (start with /)
		if (pattern.startsWith("/")) {
			// Rooted pattern: relative to the .gitignore location
			const absolutePattern = path.join(gitignoreDir, pattern.slice(1));
			const relativeToBase = path.relative(baseDir, absolutePattern);
			if (relativeToBase.startsWith("..")) {
				// Pattern is outside the search directory, skip
				continue;
			}
			pattern = relativeToBase.replace(/\\/g, "/");
			if (isDirectoryOnly) {
				patterns.push(pattern);
				patterns.push(`${pattern}/**`);
			} else {
				patterns.push(pattern);
			}
		} else {
			// Unrooted pattern: match anywhere in the tree (slash or no slash, same handling)
			patterns.push(`**/${pattern}`);
			if (isDirectoryOnly) {
				patterns.push(`**/${pattern}/**`);
			}
		}
	}

	return patterns;
}

/**
 * Load .gitignore patterns from a directory and its parents.
 * Walks up the directory tree to find all applicable .gitignore files.
 * Returns glob-compatible exclude patterns.
 */
export async function loadGitignorePatterns(baseDir: string): Promise<string[]> {
	const patterns: string[] = [];
	const absoluteBase = path.resolve(baseDir);

	const maxDepth = 50; // Prevent infinite loops
	const dirChain: string[] = [];
	{
		let current = absoluteBase;
		for (let i = 0; i < maxDepth; i++) {
			dirChain.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	}

	const reads = await Promise.all(
		dirChain.map(async dir => {
			try {
				const content = await Bun.file(path.join(dir, ".gitignore")).text();
				return parseGitignorePatterns(content, dir, absoluteBase);
			} catch {
				return [] as string[];
			}
		}),
	);
	for (const filePatterns of reads) patterns.push(...filePatterns);
	return patterns;
}

/**
 * Resolve filesystem paths matching glob patterns with optional exclude filters.
 * Returns paths relative to the provided cwd (or getProjectDir()).
 * Errors and abort/timeouts are surfaced to the caller.
 */
async function buildEffectiveExclude(options: GlobPathsOptions, patternArray: string[]): Promise<string[]> {
	const { cwd, exclude, gitignore } = options;
	const mentionsNodeModules = patternArray.some(p => p.includes("node_modules"));
	const baseExclude = mentionsNodeModules ? [...ALWAYS_IGNORED] : [...ALWAYS_IGNORED, ...NODE_MODULES_IGNORED];
	let effective = exclude === undefined ? baseExclude : [...baseExclude, ...exclude];
	if (gitignore === true) {
		const gitignorePatterns = await loadGitignorePatterns(cwd ?? getProjectDir());
		effective = [...effective, ...gitignorePatterns];
	}
	return effective;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
	const timeoutSignal = timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
	if (signal !== undefined && timeoutSignal !== undefined) return AbortSignal.any([signal, timeoutSignal]);
	return signal ?? timeoutSignal;
}

function isExcluded(normalized: string, excludePatterns: string[]): boolean {
	for (const excludePattern of excludePatterns) {
		if (new Glob(excludePattern).match(normalized)) return true;
	}
	return false;
}

function checkAborted(combinedSignal: AbortSignal | undefined): void {
	if (combinedSignal?.aborted !== true) return;
	const reason = combinedSignal.reason;
	if (reason instanceof Error) throw reason;
	throw new DOMException("Aborted", "AbortError");
}

async function scanPattern(
	pattern: string,
	base: string,
	dot: boolean | undefined,
	onlyFiles: boolean,
	excludePatterns: string[],
	combinedSignal: AbortSignal | undefined,
): Promise<string[]> {
	const glob = new Glob(pattern);
	const scanOptions = { cwd: base, dot, onlyFiles, throwErrorOnBrokenSymlink: false };
	const out: string[] = [];
	for await (const entry of glob.scan(scanOptions)) {
		checkAborted(combinedSignal);
		const normalized = entry.replace(/\\/g, "/");
		if (!isExcluded(normalized, excludePatterns)) out.push(normalized);
	}
	return out;
}

export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, signal, timeoutMs, dot, onlyFiles = true } = options;
	const patternArray = Array.isArray(patterns) ? patterns : [patterns];
	const effectiveExclude = await buildEffectiveExclude(options, patternArray);
	const base = cwd ?? getProjectDir();
	const combinedSignal = combineSignals(signal, timeoutMs);

	const groups = await Promise.all(
		patternArray.map(p => scanPattern(p, base, dot, onlyFiles, effectiveExclude, combinedSignal)),
	);
	return groups.flat();
}
