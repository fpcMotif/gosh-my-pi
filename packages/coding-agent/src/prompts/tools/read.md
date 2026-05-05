Reads the content at the specified path or URL.

<instruction>
The `read` tool is multi-purpose and more capable than it looks — inspects files, directories, archives, SQLite databases, images, documents (PDF/DOCX/PPTX/XLSX/RTF/EPUB/ipynb), **and URLs**.
- You **MUST** parallelize reads when exploring related files
- For URLs, `read` fetches the page and returns clean extracted text/markdown by default (reader-mode). It handles HTML pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs, etc. You **SHOULD** reach for `read` — not a browser/puppeteer tool — for fetching and inspecting web content.

## Parameters

- `path` — file path or URL (required)
- `sel` — optional selector for line ranges or raw mode
- `timeout` — seconds, for URLs only

## Selectors

| `sel` value | Behavior                                       |
| ----------- | ---------------------------------------------- |
| _(omitted)_ | Read full file (up to {{DEFAULT_LIMIT}} lines) |
| `50`        | Read from line 50 onward                       |
| `50-200`    | Read lines 50-200                              |
| `50+150`    | Read 150 lines starting at line 50             |
| `20+1`      | Read exactly one line                          |

# Filesystem

- Reading a directory path returns a list of dirents.
  {{#if IS_HASHLINE_MODE}}
- Reading a file returns lines prefixed with anchors (line+hash): `41th|def alpha():`
  {{else}}
  {{#if IS_LINE_NUMBER_MODE}}
- Reading a file returns lines prefixed with line numbers: `41|def alpha():`
  {{/if}}
  {{/if}}

# Inspection

Extracts text from PDF, Word, PowerPoint, Excel, RTF, EPUB, and Jupyter notebook files. Can inspect images.

# Directories & Archives

Directories and archive roots return a list of entries. Supports `.tar`, `.tar.gz`, `.tgz`, `.zip`. Use `archive.ext:path/inside/archive` to read contents.

# SQLite Databases

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:

- `file.db` — list tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — single row by primary key
- `file.db:table?limit=50&offset=100` — paginated rows
- `file.db:table?where=status='active'&order=created:desc` — filtered rows
- `file.db?q=SELECT …` — read-only SELECT query

# URLs

Extracts content from web pages, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom feeds, JSON endpoints, PDFs at URLs, and similar text-based resources. Returns clean reader-mode text/markdown — no browser required. Use `sel="raw"` for untouched HTML; `timeout` to override the default request timeout.
</instruction>

<critical>
- You **MUST** use `read` for every file, directory, archive, and URL read. `cat`, `head`, `tail`, `less`, `more`, `ls`, `tar`, `unzip`, `curl`, and `wget` are **FORBIDDEN** for inspection — any such Bash call is a bug, regardless of how short or convenient it looks.
- You **MUST** prefer `read` over a browser/puppeteer tool for fetching URL content; only use a browser if `read` fails to deliver reasonable content.
- You **MUST** always include the `path` parameter — never call `read` with an empty argument object `{}`.
- For specific line ranges, use `sel` (e.g. `sel="50-200"`, `sel="50+150"`) — do **NOT** reach for `sed -n`, `awk NR`, or `head`/`tail` pipelines.
- You **MAY** use `sel` with URL reads; the tool paginates cached fetched output.
</critical>
