
import { readFileSync, writeFileSync } from "fs";

const file = "packages/coding-agent/src/sdk.ts";
let content = readFileSync(file, "utf8");
const original = content;

// Fix remaining strict-boolean-expressions
content = content.replace(/if\s*\(!session\)/g, 'if (session === null || session === undefined)');
content = content.replace(/if\s*\(activeModel\)/g, 'if (activeModel !== null && activeModel !== undefined)');
content = content.replace(/if\s*\(agent\)/g, 'if (agent !== null && agent !== undefined)');

if (content !== original) {
    writeFileSync(file, content);
    console.log(`Updated ${file}`);
}
