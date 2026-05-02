
import { readFileSync, writeFileSync } from "fs";

const file = "packages/coding-agent/src/sdk.ts";
let content = readFileSync(file, "utf8");
const original = content;

// Fix common strict-boolean-expressions
content = content.replace(/if\s*\(modelPattern\)/g, 'if (modelPattern !== null && modelPattern !== undefined && modelPattern !== "")');
content = content.replace(/if\s*\(agent\)/g, 'if (agent !== null && agent !== undefined)');
content = content.replace(/if\s*\(model\)/g, 'if (model !== null && model !== undefined)');
content = content.replace(/if\s*\(session\)/g, 'if (session !== null && session !== undefined)');

if (content !== original) {
    writeFileSync(file, content);
    console.log(`Updated ${file}`);
}
