/**
 * Edit benchmark task definitions loaded from fixtures.
 *
 * Supports loading from either:
 * - A fixtures directory (for development)
 * - A fixtures.tar.gz tarball (for distribution)
 */
/// <reference types="./bun-imports.d.ts" />
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EditTask {
	id: string;
	name: string;
	prompt: string;
	files: string[];
	metadata?: TaskMetadata;
	inputDir: string;
	expectedDir: string;
}

export interface TaskMetadata {
	seed?: number;
	mutationType?: string;
	mutationCategory?: string;
	difficulty?: string;
	difficultyScore?: number;
	filePath?: string;
	fileName?: string;
	lineNumber?: number;
	originalSnippet?: string;
	mutatedSnippet?: string;
}

export const DEFAULT_TARBALL_PATH = path.join(import.meta.dir, "../fixtures.tar.gz");

function titleize(id: string): string {
	return id
		.split(/[-_]/)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

async function listFiles(rootDir: string, subPath = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const collected = await Promise.all(
		entries.map(async (entry): Promise<string[]> => {
			const relativePath = path.join(subPath, entry.name);
			const absolutePath = path.join(rootDir, relativePath);
			if (entry.isDirectory()) {
				return listFiles(rootDir, relativePath);
			}
			if (entry.isFile()) {
				return [relativePath];
			}
			if (entry.isSymbolicLink()) {
				const stats = await fs.stat(absolutePath).catch(() => null);
				if (stats?.isFile() === true) {
					return [relativePath];
				}
			}
			return [];
		}),
	);

	return collected.flat().sort();
}

async function loadTaskFromEntry(fixturesDir: string, entryName: string): Promise<EditTask> {
	const challengeDir = path.join(fixturesDir, entryName);
	const promptPath = path.join(challengeDir, "prompt.md");
	const inputDir = path.join(challengeDir, "input");
	const expectedDir = path.join(challengeDir, "expected");
	const metadataPath = path.join(challengeDir, "metadata.json");

	const promptFile = Bun.file(promptPath);
	if (!(await promptFile.exists())) {
		throw new Error(`Missing prompt.md for ${entryName}`);
	}

	const [inputDirStat, expectedDirStat] = await Promise.all([
		fs.stat(inputDir).catch(() => null),
		fs.stat(expectedDir).catch(() => null),
	]);
	if (inputDirStat?.isDirectory() !== true) {
		throw new Error(`Missing input directory for ${entryName}`);
	}
	if (expectedDirStat?.isDirectory() !== true) {
		throw new Error(`Missing expected directory for ${entryName}`);
	}

	const [promptText, files, metadata] = await Promise.all([
		promptFile.text(),
		listFiles(inputDir),
		loadMetadata(metadataPath),
	]);

	return {
		id: entryName,
		name: titleize(entryName),
		prompt: promptText.trim(),
		inputDir,
		expectedDir,
		files,
		metadata,
	};
}

export async function loadTasksFromDir(fixturesDir: string): Promise<EditTask[]> {
	const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
	const directories = entries.filter(entry => entry.isDirectory());
	const tasks = await Promise.all(directories.map(entry => loadTaskFromEntry(fixturesDir, entry.name)));
	return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export interface FixtureValidationIssue {
	taskId: string;
	message: string;
}

interface FixturePaths {
	taskId: string;
	challengeDir: string;
	promptPath: string;
	inputDir: string;
	expectedDir: string;
	metadataPath: string;
}

function buildFixturePaths(fixturesPath: string, taskId: string): FixturePaths {
	const challengeDir = path.join(fixturesPath, taskId);
	return {
		taskId,
		challengeDir,
		promptPath: path.join(challengeDir, "prompt.md"),
		inputDir: path.join(challengeDir, "input"),
		expectedDir: path.join(challengeDir, "expected"),
		metadataPath: path.join(challengeDir, "metadata.json"),
	};
}

async function validatePromptFile(paths: FixturePaths): Promise<FixtureValidationIssue[]> {
	const promptFile = Bun.file(paths.promptPath);
	if (!(await promptFile.exists())) {
		return [{ taskId: paths.taskId, message: "prompt.md is missing" }];
	}
	if ((await promptFile.text()).trim().length === 0) {
		return [{ taskId: paths.taskId, message: "prompt.md is empty" }];
	}
	return [];
}

async function validateFileContents(
	taskId: string,
	dir: string,
	files: string[],
	label: string,
): Promise<FixtureValidationIssue[]> {
	const checks = await Promise.all(
		files.map(async file => {
			const content = await Bun.file(path.join(dir, file)).text();
			return content.length === 0 ? { taskId, message: `${label}/${file} is empty` } : null;
		}),
	);
	return checks.filter((issue): issue is FixtureValidationIssue => issue !== null);
}

async function validateMetadataFile(
	paths: FixturePaths,
	inputFiles: string[],
	expectedFiles: string[],
): Promise<FixtureValidationIssue[]> {
	const metadataFile = Bun.file(paths.metadataPath);
	if (!(await metadataFile.exists())) {
		return [{ taskId: paths.taskId, message: "metadata.json is missing" }];
	}
	let metadata: Record<string, unknown>;
	try {
		metadata = JSON.parse(await metadataFile.text()) as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [{ taskId: paths.taskId, message: `metadata.json is invalid JSON: ${message}` }];
	}
	if (typeof metadata.file_path !== "string" || metadata.file_path.trim().length === 0) {
		return [{ taskId: paths.taskId, message: "metadata.json missing file_path" }];
	}
	const issues: FixtureValidationIssue[] = [];
	const fileName = path.basename(metadata.file_path);
	if (!inputFiles.some(file => path.basename(file) === fileName)) {
		issues.push({
			taskId: paths.taskId,
			message: `metadata file_path ${metadata.file_path} not found in input files`,
		});
	}
	if (!expectedFiles.some(file => path.basename(file) === fileName)) {
		issues.push({
			taskId: paths.taskId,
			message: `metadata file_path ${metadata.file_path} not found in expected files`,
		});
	}
	return issues;
}

async function validateOneFixture(fixturesPath: string, entryName: string): Promise<FixtureValidationIssue[]> {
	const paths = buildFixturePaths(fixturesPath, entryName);
	const issues: FixtureValidationIssue[] = [];

	const [promptIssues, inputDirStat, expectedDirStat] = await Promise.all([
		validatePromptFile(paths),
		fs.stat(paths.inputDir).catch(() => null),
		fs.stat(paths.expectedDir).catch(() => null),
	]);
	issues.push(...promptIssues);

	if (inputDirStat?.isDirectory() !== true) {
		issues.push({ taskId: paths.taskId, message: "input directory is missing" });
	}
	if (expectedDirStat?.isDirectory() !== true) {
		issues.push({ taskId: paths.taskId, message: "expected directory is missing" });
	}

	const [inputFiles, expectedFiles] = await Promise.all([
		inputDirStat?.isDirectory() === true ? listFiles(paths.inputDir) : Promise.resolve([] as string[]),
		expectedDirStat?.isDirectory() === true ? listFiles(paths.expectedDir) : Promise.resolve([] as string[]),
	]);

	if (inputFiles.length === 0) {
		issues.push({ taskId: paths.taskId, message: "input directory is empty" });
	}
	if (expectedFiles.length === 0) {
		issues.push({ taskId: paths.taskId, message: "expected directory is empty" });
	}

	const [inputContentIssues, expectedContentIssues, metadataIssues] = await Promise.all([
		validateFileContents(paths.taskId, paths.inputDir, inputFiles, "input"),
		validateFileContents(paths.taskId, paths.expectedDir, expectedFiles, "expected"),
		validateMetadataFile(paths, inputFiles, expectedFiles),
	]);

	issues.push(...inputContentIssues, ...expectedContentIssues, ...metadataIssues);
	return issues;
}

export async function validateFixturesFromDir(fixturesPath: string): Promise<FixtureValidationIssue[]> {
	const entries = await fs.readdir(fixturesPath, { withFileTypes: true });
	const directories = entries.filter(entry => entry.isDirectory());
	const allIssues = await Promise.all(directories.map(entry => validateOneFixture(fixturesPath, entry.name)));
	return allIssues.flat();
}

async function loadMetadata(metadataPath: string): Promise<TaskMetadata | undefined> {
	const metadataFile = Bun.file(metadataPath);
	const exists = await metadataFile.exists();
	if (!exists) {
		return undefined;
	}
	const raw = (await metadataFile.json()) as Record<string, unknown>;
	return parseTaskMetadata(raw);
}

function assignStringField(
	metadata: TaskMetadata,
	raw: Record<string, unknown>,
	key: keyof TaskMetadata,
	...rawKeys: string[]
): void {
	for (const rawKey of rawKeys) {
		const value = raw[rawKey];
		if (typeof value === "string" && value.length > 0) {
			const current = metadata[key];
			if (typeof current !== "string" || current.length === 0) {
				(metadata as unknown as Record<string, string>)[key as string] = value;
			}
			return;
		}
	}
}

function assignNumberField(
	metadata: TaskMetadata,
	raw: Record<string, unknown>,
	key: keyof TaskMetadata,
	...rawKeys: string[]
): void {
	for (const rawKey of rawKeys) {
		const value = raw[rawKey];
		if (typeof value === "number" && metadata[key] === undefined) {
			(metadata as unknown as Record<string, number>)[key as string] = value;
			return;
		}
	}
}

function parseTaskMetadata(raw: Record<string, unknown> | undefined): TaskMetadata | undefined {
	if (!raw) {
		return undefined;
	}
	const metadata: TaskMetadata = {};
	assignNumberField(metadata, raw, "seed", "seed");
	assignStringField(metadata, raw, "mutationType", "mutation_type", "mutationType");
	assignStringField(metadata, raw, "mutationCategory", "mutation_category", "category", "mutationCategory");
	assignStringField(metadata, raw, "difficulty", "difficulty");
	assignNumberField(metadata, raw, "difficultyScore", "difficulty_score", "difficultyScore");
	assignStringField(metadata, raw, "filePath", "file_path");
	assignNumberField(metadata, raw, "lineNumber", "line_number");
	assignStringField(metadata, raw, "originalSnippet", "original_snippet");
	assignStringField(metadata, raw, "mutatedSnippet", "mutated_snippet");
	assignStringField(metadata, raw, "fileName", "fileName");

	if (
		(metadata.fileName === undefined || metadata.fileName.length === 0) &&
		typeof metadata.filePath === "string" &&
		metadata.filePath.trim().length > 0
	) {
		metadata.fileName = path.basename(metadata.filePath);
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}
