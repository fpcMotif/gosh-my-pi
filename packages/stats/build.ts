import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";

/**
 * Extract Tailwind class names from source files by scanning for className attributes.
 */
async function listSourceFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const subDirResults = await Promise.all(
		entries.filter(entry => entry.isDirectory()).map(entry => listSourceFiles(path.join(dir, entry.name))),
	);
	const files = entries
		.filter(entry => entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name))
		.map(entry => path.join(dir, entry.name));
	return [...files, ...subDirResults.flat()];
}

function addClassesFromContent(content: string, classes: Set<string>): void {
	const classPattern = /className\s*=\s*["'`]([^"'`]+)["'`]/g;
	for (const match of content.matchAll(classPattern)) {
		for (const cls of match[1].split(/\s+/)) {
			if (cls !== "") classes.add(cls);
		}
	}
}

async function extractTailwindClasses(dir: string): Promise<Set<string>> {
	const files = await listSourceFiles(dir);
	const contents = await Promise.all(files.map(file => Bun.file(file).text()));
	const classes = new Set<string>();
	for (const content of contents) {
		addClassesFromContent(content, classes);
	}
	return classes;
}

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });

// Build Tailwind CSS
console.log("Building Tailwind CSS...");
const sourceCss = await Bun.file("./src/client/styles.css").text();
const candidates = await extractTailwindClasses("./src/client");
const baseDir = path.resolve("./src/client");

const compiler = await compile(sourceCss, {
	base: baseDir,
	onDependency: () => {},
});
const tailwindOutput = compiler.build([...candidates]);
await Bun.write("./dist/client/styles.css", tailwindOutput);

// Build React app
console.log("Building React app...");
const result = await Bun.build({
	entrypoints: ["./src/client/index.tsx"],
	outdir: "./dist/client",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

// Create index.html
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
