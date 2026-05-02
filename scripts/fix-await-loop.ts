
import { readFileSync, writeFileSync } from "fs";

const files = Array.from(new Bun.Glob("packages/**/*.ts").scanSync());

for (const file of files) {
    let content = readFileSync(file, "utf8");
    const original = content;

    // Pattern: for (const x of Array.from(y.values())) { await x.stop(); }
    content = content.replace(
        /for\s*\(\s*const\s+(\w+)\s+of\s+Array\.from\(([\w.]+)\.values\(\)\)\s*\)\s*\{\s*await\s+\1\.stop\(\);?\s*\}/g,
        "await Promise.all(Array.from($2.values()).map(c => c.stop()));"
    );

    // Pattern: for (const x of y) { await x.stop(); }
    content = content.replace(
        /for\s*\(\s*const\s+(\w+)\s+of\s+([\w.]+)\s*\)\s*\{\s*await\s+\1\.stop\(\);?\s*\}/g,
        "await Promise.all($2.map(c => c.stop()));"
    );

     // Pattern: for (const x of y) { await x.close(); }
    content = content.replace(
        /for\s*\(\s*const\s+(\w+)\s+of\s+([\w.]+)\s*\)\s*\{\s*await\s+\1\.close\(\);?\s*\}/g,
        "await Promise.all($2.map(c => c.close()));"
    );

    if (content !== original) {
        writeFileSync(file, content);
        console.log(`Updated ${file}`);
    }
}
