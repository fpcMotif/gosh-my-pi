
import { readFileSync, writeFileSync } from "fs";

const files = Array.from(new Bun.Glob("packages/ai/src/**/*.ts").scanSync());

for (const file of files) {
    let content = readFileSync(file, "utf8");
    const original = content;

    // Pattern: if (!x) -> if (x === null || x === undefined || x === "")
    // This is risky to do blindly, so I'll only do it for common cases.
    
    // Fix options?.signal?.aborted
    content = content.replace(/options\?.signal\?.aborted/g, "options?.signal?.aborted === true");
    content = content.replace(/signal\?.aborted/g, "signal?.aborted === true");

    // Fix if (!apiKey)
    content = content.replace(/if\s*\(!apiKey\)/g, 'if (apiKey === null || apiKey === undefined || apiKey === "")');

    // Fix if (historyItems)
    content = content.replace(/if\s*\(historyItems\)/g, 'if (historyItems !== undefined && historyItems !== null)');

    if (content !== original) {
        writeFileSync(file, content);
        console.log(`Updated ${file}`);
    }
}
