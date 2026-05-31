#!/usr/bin/env bun

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	goTuiArtifactBasename,
	goTuiBundledExecutableName,
	goTuiReleaseTargets,
} from "../packages/coding-agent/src/cli/tui-go-binary";

interface ArchiveTarget {
	id: string;
	binaryName: string;
	archiveName: string;
	executableName: string;
	nativeAddons: string[];
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const archivesDir = path.join(binariesDir, ".archives");
const goTuiTargetsById = new Map(goTuiReleaseTargets.map(target => [target.id, target]));

const targets: ArchiveTarget[] = [
	{
		id: "darwin-arm64",
		binaryName: "gmp-darwin-arm64",
		archiveName: "gmp-darwin-arm64.tar.gz",
		executableName: "gmp",
		nativeAddons: ["pi_natives.darwin-arm64.node"],
	},
	{
		id: "darwin-x64",
		binaryName: "gmp-darwin-x64",
		archiveName: "gmp-darwin-x64.tar.gz",
		executableName: "gmp",
		nativeAddons: ["pi_natives.darwin-x64-modern.node", "pi_natives.darwin-x64-baseline.node"],
	},
	{
		id: "linux-x64",
		binaryName: "gmp-linux-x64",
		archiveName: "gmp-linux-x64.tar.gz",
		executableName: "gmp",
		nativeAddons: ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node"],
	},
	{
		id: "linux-arm64",
		binaryName: "gmp-linux-arm64",
		archiveName: "gmp-linux-arm64.tar.gz",
		executableName: "gmp",
		nativeAddons: ["pi_natives.linux-arm64.node"],
	},
	{
		id: "win32-x64",
		binaryName: "gmp-windows-x64.exe",
		archiveName: "gmp-windows-x64.tar.gz",
		executableName: "gmp.exe",
		nativeAddons: ["pi_natives.win32-x64-modern.node", "pi_natives.win32-x64-baseline.node"],
	},
];

async function copyRequiredFile(source: string, destination: string): Promise<void> {
	try {
		await fs.copyFile(source, destination);
	} catch (error) {
		throw new Error(`Missing release archive input ${path.relative(repoRoot, source)}: ${String(error)}`);
	}
}

async function createArchive(target: ArchiveTarget): Promise<void> {
	const stagingDir = path.join(archivesDir, target.id);
	await fs.rm(stagingDir, { recursive: true, force: true });
	await fs.mkdir(stagingDir, { recursive: true });

	await copyRequiredFile(path.join(binariesDir, target.binaryName), path.join(stagingDir, target.executableName));
	for (const addonName of target.nativeAddons) {
		// oxlint-disable-next-line no-await-in-loop -- sequential copy keeps packaging order-stable and failures attributable to a single addon
		await copyRequiredFile(path.join(binariesDir, addonName), path.join(stagingDir, addonName));
	}

	const goTarget = goTuiTargetsById.get(target.id);
	if (goTarget) {
		const tuiGoExecutable = path.join(stagingDir, goTuiBundledExecutableName(goTarget));
		await copyRequiredFile(path.join(binariesDir, goTuiArtifactBasename(goTarget)), tuiGoExecutable);
		if (!goTarget.windows) {
			await fs.chmod(tuiGoExecutable, 0o755);
		}
	}

	if (target.executableName === "gmp") {
		await fs.chmod(path.join(stagingDir, target.executableName), 0o755);
	}

	const archivePath = path.join(binariesDir, target.archiveName);
	await fs.rm(archivePath, { force: true });
	await $`tar -czf ${archivePath} -C ${stagingDir} .`.quiet();
}

async function main(): Promise<void> {
	await fs.mkdir(binariesDir, { recursive: true });
	await fs.rm(archivesDir, { recursive: true, force: true });
	await fs.mkdir(archivesDir, { recursive: true });

	for (const target of targets) {
		// oxlint-disable-next-line no-await-in-loop -- sequential packaging keeps archive output stable and failures attributable to a single target
		await createArchive(target);
	}

	await fs.rm(archivesDir, { recursive: true, force: true });
}

await main();
