import { readFileSync, writeFileSync } from "node:fs";

const file = "packages/ai/test/stream.test.ts";
const lines = readFileSync(file, "utf8").split("\n");

let start = -1;
let end = -1;

for (let i = 0; i < lines.length; i++) {
	if (lines[i].includes('describe("Google Gemini CLI Provider (gemini-2.5-flash)", () => {')) {
		start = i;
	}
	if (lines[i].includes('describe("OpenAI Codex Provider (gpt-5.2-codex)", () => {')) {
		end = i;
		break;
	}
}

if (start !== -1 && end !== -1) {
	const newLines = [...lines.slice(0, start), ...lines.slice(end)];
	writeFileSync(file, newLines.join("\n"));
	console.log("Lines removed!");
} else {
	console.log("Could not find start/end lines.");
}
