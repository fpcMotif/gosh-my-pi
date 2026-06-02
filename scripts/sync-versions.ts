#!/usr/bin/env bun

/**
 * Syncs ALL @oh-my-pi/* package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface PackageInfo {
	path: string;
	data: PackageJson;
}

const packagesDir = join(process.cwd(), "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

// Read all package.json files and build version map
const packages: Record<string, PackageInfo> = {};
const versionMap: Record<string, string> = {};

await Promise.all(
	packageDirs.map(async dir => {
		const pkgPath = join(packagesDir, dir, "package.json");
		try {
			const pkg = (await Bun.file(pkgPath).json()) as PackageJson;
			packages[dir] = { path: pkgPath, data: pkg };
			versionMap[pkg.name] = pkg.version;
		} catch (error) {
			const err = error as Error;
			console.error(`Failed to read ${pkgPath}:`, err.message);
		}
	}),
);

console.log("Current versions:");
for (const [name, version] of Object.entries(versionMap).sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
	console.error("\n❌ ERROR: Not all packages have the same version!");
	console.error("Expected lockstep versioning. Run the release script with the next version:");
	console.error("  bun scripts/release.ts <version>");
	console.error("Or update all package versions consistently before running this script.");

	process.exit(1);
}

console.log("\n✅ All packages at same version (lockstep)");

// Update all inter-package dependencies
let totalUpdates = 0;
const promises: Promise<number>[] = [];

const checkAndUpdate = (pkg: PackageInfo, deps: Record<string, string> | undefined, dev: boolean) => {
	let localUpdated = false;
	if (!deps) return localUpdated;
	for (const [depName, currentVersion] of Object.entries(deps)) {
		const targetVersion = versionMap[depName];
		if (!targetVersion) continue;

		const newVersion = `^${targetVersion}`;
		if (currentVersion !== newVersion) {
			console.log(`\n${pkg.data.name}:`);
			console.log(`  ${depName}: ${currentVersion} → ${newVersion}${dev ? " (devDependencies)" : ""}`);
			deps[depName] = newVersion;
			localUpdated = true;
			totalUpdates++;
		}
	}
	return localUpdated;
};

for (const [_, pkg] of Object.entries(packages)) {
	const updatedDeps = checkAndUpdate(pkg, pkg.data.dependencies, false);
	const updatedDevDeps = checkAndUpdate(pkg, pkg.data.devDependencies, true);

	// Write if updated
	if (updatedDeps || updatedDevDeps) {
		promises.push(Bun.write(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`));
	}
}

await Promise.all(promises);

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies already in sync.");
} else {
	console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`);
}
