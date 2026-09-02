## 2024-05-18 - Fast Appended File Reading
**Learning:** In Bun, when reading appended data from `.jsonl` files, `Bun.file(path).slice(start).bytes()` is significantly faster (~14x) than loading the entire file with `Bun.file(path).bytes()` and using `.subarray()`, because it only loads the necessary bytes into memory. `file.size` can be used to prevent reading out of bounds. However, `ENOENT` must still be caught around the `bytes()` call due to TOCTOU.
**Action:** Use `.slice(start).bytes()` for extracting data from the end of growing files.
## 2024-03-24 - SQLite Template Literal Comments
**Learning:** When documenting optimizations inside TypeScript multiline template strings (e.g. for SQL queries), using backticks for markdown formatting (like `idx_messages_errors`) prematurely terminates the template string, causing syntax errors in formatters (oxfmt) and execution. Using standard inline block comments `/* ... */` without backticks solves this.
**Action:** Avoid backticks within template literals for markdown-like inline documentation. Use block comments with standard text.
