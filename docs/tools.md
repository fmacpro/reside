# Tools Reference

Reside provides the LLM with 13 built-in tools for filesystem operations, web access, npm registry search, time queries, and shell command execution. All tools operate within a designated workspace directory (`workdir/`).

---

## Table of Contents

- [Filesystem Tools](#filesystem-tools)
  - [`read_file(path)`](#read_filepath)
  - [`write_file(path, content)`](#write_filepath-content)
  - [`edit_file(path, file_path, new_string)`](#edit_filepath-file_path-new_string)
  - [`list_files(path)`](#list_filespath)
  - [`search_files(path, regex, file_pattern)`](#search_filespath-regex-file_pattern)
  - [`create_directory(path)`](#create_directorypath)
  - [`delete_file(path)`](#delete_filepath)
- [Execution Tools](#execution-tools)
  - [`execute_command(command, cwd?)`](#execute_commandcommand-cwd)
  - [`test_app(args?, cwd?)`](#test_appargs-cwd)
- [Web Tools](#web-tools)
  - [`search_npm_packages(query)`](#search_npm_packagesquery)
  - [`search_web(query)`](#search_webquery)
  - [`fetch_url(url, useBrowser?)`](#fetch_urlurl-usebrowser)
- [Utility Tools](#utility-tools)
  - [`get_current_time(format?)`](#get_current_timeformat)
  - [`finish(message)`](#finishmessage)

---

## Filesystem Tools

### `read_file(path)`

Read the contents of a file and return it as text.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Relative path to the file (e.g., `"my-app/app.js"`) |

**Returns:** The full file contents as a string, plus metadata (`path`, `content`, `size`).

**Errors:**
- `File not found: <path>` — the file does not exist
- `Path "<path>" is outside the workspace` — path traversal attempt blocked

**Example:**
```
{"tool": "read_file", "arguments": {"path": "my-app/app.js"}}
```

---

### `write_file(path, content)`

Create a **new** file with content. Automatically creates parent directories if they don't exist. Files **must** be inside an app subdirectory — writing directly to the workdir root is rejected.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Relative path to the file (e.g., `"my-app/app.js"`) |
| `content` | string | Yes | The complete file content |

**Behavior:**
- Creates parent directories automatically if they don't exist
- Rejects files written directly to the workdir root (must be inside an app subdirectory like `my-app/app.js`)
- Rejects CommonJS `module.exports` syntax in `package.json` files (must be plain JSON)
- Rejects placeholder/stub content (e.g., `// Your code here`, empty function bodies) for files under 200 bytes
- Automatically repairs broken JavaScript string literals caused by JSON parsing (e.g., `\n` inside strings)
- Tracks the app directory for auto-`cwd` in subsequent `execute_command` calls
- Verifies the file was written correctly by checking size after write

**Errors:**
- `Missing required argument: path` — no path provided
- `Missing required argument: content` — no content provided
- `Cannot write files directly in the workdir root` — path is not inside an app subdirectory
- `The content for "<path>" uses CommonJS "module.exports" syntax` — package.json must be plain JSON
- `The content for "<path>" appears to be a placeholder/stub` — content is too short and matches placeholder patterns

**Example:**
```
{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\"Hello, world!\");"}}
```

---

### `edit_file(path, file_path, new_string)`

Edit an **existing** file by replacing a section of text. Uses diff-based matching to locate the section to replace — you provide the **new code** with enough surrounding context (e.g., the function signature), and the tool automatically finds the best match.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No* | Relative path to the file |
| `file_path` | string | No* | Alternative parameter name for path |
| `new_string` | string | Yes | The replacement code with surrounding context |

> \* Either `path` or `file_path` must be provided.

**How matching works:**
1. Extracts the first significant line from `new_string` (the "anchor" — e.g., a function signature)
2. Finds all occurrences of the anchor in the current file
3. For each occurrence, computes a diff score between the surrounding context and `new_string`
4. Returns the best match (highest unchanged − changed score)
5. Replaces the matched section with `new_string`

**Important:** Do **NOT** include `old_string` — it is not a valid parameter and will be silently stripped. The tool automatically finds the best match using diff-based matching. Just provide the new code with enough context.

**Errors:**
- `Missing required argument: path` — no path provided
- `Missing required argument: new_string` — no replacement content provided
- `File not found: <path>` — the file does not exist
- `Could not find a matching section in <path>` — the anchor line could not be found in the file

**Example:**
```
{"tool": "edit_file", "arguments": {"file_path": "my-app/app.js", "new_string": "function greet(name) {\n  return `Hello, ${name}!`;\n}"}}
```

---

### `list_files(path)`

List files and directories in a given path.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No (default: `"."`) | Directory path to list |

**Returns:** A formatted list with icons (📁 for directories, 📄 for files) and file sizes.

**Errors:**
- `Directory not found: <path>` — the directory does not exist

**Example:**
```
{"tool": "list_files", "arguments": {"path": "my-app"}}
```

---

### `search_files(path, regex, file_pattern)`

Search for patterns in files using regex. Uses `grep` under the hood.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No (default: `"."`) | Directory to search recursively |
| `regex` | string | Yes | Regular expression pattern to match |
| `file_pattern` | string | No | Glob pattern to filter files (e.g., `"*.js"`) |

**Returns:** Up to 100 matching lines with file paths and line numbers.

**Errors:**
- `Missing required argument: regex` — no regex pattern provided
- `Path not found: <path>` — the directory does not exist

**Example:**
```
{"tool": "search_files", "arguments": {"path": "my-app", "regex": "function\\s+\\w+", "file_pattern": "*.js"}}
```

---

### `create_directory(path)`

Create a directory (and parent directories if needed). For top-level app directories (direct children of the workdir), automatically initializes a git repository.

**Use this to create controller/service subdirectories** when structuring your app. For example:
```
create_directory("my-app/controllers")
create_directory("my-app/services")
create_directory("my-app/utils")
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Directory path to create |

**Behavior:**
- Creates parent directories automatically
- For top-level app directories: auto-initializes git (unless already inside an existing git repo)
- Tracks the app directory for auto-`cwd` in subsequent `execute_command` calls
- Rejects creation of existing non-empty top-level directories (prevents overwriting existing apps)
- Subdirectories within an existing app (e.g., `my-app/src/`) are always allowed

**Errors:**
- `Missing required argument: path` — no path provided
- `Directory "<path>" already exists and contains files` — top-level app directory already exists with content

**Example:**
```
{"tool": "create_directory", "arguments": {"path": "my-app"}}
```

---

### `delete_file(path)`

Delete a file or directory. For directories, recursively deletes all contents.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file or directory to delete |

**Errors:**
- `Missing required argument: path` — no path provided
- `Path not found: <path>` — the file or directory does not exist

**Example:**
```
{"tool": "delete_file", "arguments": {"path": "my-app/old-file.js"}}
```

---

## Execution Tools

### `execute_command(command, cwd?)`

Run a shell command with a timeout. Automatically runs inside the current app directory if one has been created and no `cwd` is specified.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `cwd` | string | No | App subdirectory to run in (e.g., `"my-app"`) |

**Behavior:**
- **Timeout:** 5 seconds for run commands (`node app.js`, `python app.py`), 10 seconds for all other commands
- **Auto-cwd:** If no `cwd` is provided but a current app context exists (from a prior `create_directory` or `write_file` call), the command automatically runs inside that app's directory
- **Server detection:** Known server commands (`npm start`, `npm run dev`, `npx serve`) are blocked — the LLM tells the user the command to run instead
- **Animation detection:** Files with `setTimeout`/`setInterval` loops are detected and blocked — the LLM tells the user to run them manually
- **Security:** Destructive commands (`rm -rf /`, `dd if=`, `mkfs`) are blocked
- **npm install verification:** Before installing, verifies each package exists on the npm registry and is compatible with the current Node.js version. ESM-only packages are flagged for CommonJS projects
- **npm init -y:** Automatically sets `"type": "module"` in `package.json` after `npm init -y`
- **Shell redirect detection:** Placeholder syntax like `<city-name>` is detected and rejected (the shell interprets it as a file redirect)
- **npm without cwd:** If an npm command runs in the workdir root without `cwd`, the tool suggests the most recently modified app directory

**Errors:**
- `Missing required argument: command` — no command provided
- `Command blocked for security` — destructive command detected
- `Directory not found: <cwd>` — the specified cwd directory doesn't exist
- `Package "<name>" does not exist on the npm registry` — npm package not found
- `The command "<cmd>" starts a long-running server process` — server command blocked
- `The file "<file>" contains animation loops` — animated CLI blocked

**Example:**
```
{"tool": "execute_command", "arguments": {"command": "node app.js", "cwd": "my-app"}}
```

---

### `test_app(args?, cwd?)`

Test the application by running it and checking for errors. Use this **after** writing the source code to verify the app works.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | string | No | Command-line arguments to pass to the app (e.g., `"London"` for a weather app) |
| `cwd` | string | No | Which app directory to test when multiple apps exist |

**Behavior:**
- Automatically finds the entry point file (`app.js`, `index.js`, `server.js`, `main.js`, `app.mjs`, `index.mjs`, `index.html`)
- Runs `node <entrypoint> [args]` with a 5-second timeout
- For HTML entry points (static files), returns success immediately without running
- If no `cwd` is specified and only one app exists, uses that app
- If multiple apps exist and no `cwd` is specified, returns a helpful error listing available apps
- Priority for app selection: 1) `cwd` parameter, 2) auto-tracked current app, 3) scan workdir

**Errors:**
- `No app directory found` — no apps exist in the workdir
- `Multiple app directories found: <names>` — specify which app with `cwd`
- `App directory "<name>" does not exist` — the specified app doesn't exist
- `No entry point file found in "<name>/"` — no recognized entry point exists
- `The app timed out after 5s` — app produced no output (infinite loop, missing console.log, or waiting for input)

**Example:**
```
{"tool": "test_app", "arguments": {"args": "London", "cwd": "weather-cli"}}
```

---

## Web Tools

### `search_npm_packages(query)`

Search the npm registry for packages matching a query. Returns a list of packages with name, description, version, and keywords. Use this **instead** of `search_web()` when you need to find npm packages — the npm registry has its own search that is more accurate and up-to-date than web search.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (package name or partial name) |

**Behavior:**
- Runs `npm search <query>` via the CLI with a 10-second timeout
- Tries JSON output format first (`npm search --json`), falls back to parsing the table format
- Returns up to 20 matching packages with name, version, description, keywords, and last update date
- If `npm search` fails (e.g., npm not installed or registry unreachable), suggests using `fetch_url` to search npmjs.com directly

**Returns:** Structured data with `query`, `packages` array, and `count`.

**When to use:**
- **Always** use this tool before running `npm install` to verify a package exists
- Use this to find the correct package name when you're not sure of the exact name
- Use this to discover alternative packages when a specific package doesn't exist
- Do **NOT** use `search_web()` for npm package lookups — this tool queries the npm registry directly

**Errors:**
- `Missing required argument: query` — no query provided
- `npm search failed: <message>` — npm CLI failed (suggests using `fetch_url` as fallback)

**Example:**
```
{"tool": "search_npm_packages", "arguments": {"query": "readline-sync"}}
```

**Example output:**
```
Found 3 package(s) matching "readline-sync":

1. **readline-sync** v1.4.10 — Synchronous Readline for interactively running to have a conversation with the user via a console(TTY).
   Keywords: readline, synchronous, prompt, question, password, cli, tty, command, interactive
   Updated: 2024-01-15

2. **readline-sync2** v0.1.1 — Synchronous Readline for interactively running to have a conversation with the user via a console(TTY).
   Keywords: readline, synchronous, line, command, tty, prompt
   Updated: 2023-08-22
```

---

### `search_web(query)`

Search the web for information using DuckDuckGo — a free, privacy-respecting search engine that requires **no API key** and **no registration**.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |

**Behavior:**
- Uses **Puppeteer** with `puppeteer-extra-plugin-stealth` to bypass bot detection
- Launches a headless Chrome browser with a desktop viewport
- Navigates to DuckDuckGo HTML and extracts results from the rendered page
- Ads are automatically filtered out
- Redirect URLs are resolved to their real destinations
- **Also follows the top result links** to fetch actual article content (titles and summaries), so the LLM gets rich information directly from search results without needing a separate `fetch_url` call
- Results are cached so subsequent `fetch_url` calls on the same URLs are served from cache

**Returns:** Structured data with titles, snippets, URLs, and article content for each result.

**Prerequisites:** Google Chrome must be installed on your system. The default Chrome path is `/usr/bin/google-chrome`. You can modify the `executablePath` in [`src/search.js`](../src/search.js:26) if Chrome is installed elsewhere.

**Example:**
```
{"tool": "search_web", "arguments": {"query": "current price of bitcoin"}}
```

**Example output:**
```
💬 > what is the current price of bitcoin

🔧 search_web("current price of bitcoin")
   ✅ Found 5 results

🤖 The current price of Bitcoin is $76,711.52 USD as of the time this information was fetched.
```

---

### `fetch_url(url, useBrowser?)`

Fetch a URL and extract its main article content. Returns clean text with the title and body content, stripped of navigation, ads, and other boilerplate.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to fetch |
| `useBrowser` | boolean | No | Force browser rendering for JavaScript-heavy pages |

**Behavior:**
- **Default mode (HTTP):** Uses only Node.js built-in `http`/`https` modules and a lightweight custom HTML parser — zero dependencies
  - Fetches the page HTML via HTTPS with a browser-like User-Agent
  - Parses the HTML into a lightweight DOM tree (no JSDOM needed)
  - Gathers candidate content containers using positive selectors (`<article>`, `<main>`, content class patterns)
  - Scores each candidate using heuristic features (text length, paragraph count, link density, semantic tags)
  - Selects the highest-scoring candidate and strips negative containers (nav, footer, aside, script, style)
  - Returns clean formatted text with structural spacing
- **Browser mode (`useBrowser=true` or automatic fallback):**
  - Launches a headless Chrome browser via Puppeteer (shared instance with `search_web`)
  - Detects and waits for Cloudflare challenges to resolve
  - Renders the page with JavaScript enabled
  - Extracts text using the same heuristic scoring algorithm on the rendered DOM
  - Falls back to `document.body.innerText` for JS-heavy SPAs
- **Automatic fallback:** If HTTP fetch fails with 403/401/429 (bot protection), automatically retries with Puppeteer
- **Prompt injection protection:** Content is wrapped in clear delimiters with instructions to treat it as data, not instructions
- **URL normalization:** Automatically strips surrounding angle brackets, square brackets, and trailing punctuation

**When to use:**
- Use `search_web(query)` first to find information
- `fetch_url` is only needed when the user explicitly asks for the full text of a specific article
- Do **NOT** call `fetch_url` on URLs returned by `search_web` — `search_web` already fetches article content and returns summaries

**Errors:**
- `Missing required argument: url` — no URL provided
- `Invalid URL protocol` — only http and https URLs are supported
- `Invalid URL format` — the URL is malformed

**Example:**
```
{"tool": "fetch_url", "arguments": {"url": "https://example.com/article"}}
```

---

## Utility Tools

### `get_current_time(format?)`

Get the current system date and/or time using Node.js built-in `Date` and `Intl.DateTimeFormat` APIs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | string | No (default: `"full"`) | Output format |

**Supported formats:**

| Format | Example Output |
|--------|---------------|
| `"full"` | `Monday, 27 April 2026 at 20:35:36 British Summer Time (Europe/London, unix: 1777318536)` |
| `"date"` | `2026-04-27` |
| `"time"` | `20:35:36` |
| `"day"` | `Monday` |
| `"month"` | `April` |
| `"year"` | `2026` |
| `"timestamp"` | `1777318536` |

**Returns:** The formatted time string plus structured data with all fields (`datetime`, `date`, `time`, `timezone`, `unixTimestamp`, `year`, `month`, `monthName`, `day`, `dayOfWeek`) regardless of the format requested.

The LLM automatically selects the appropriate format based on the question (e.g., "what time is it?" → `"time"`, "what's the date?" → `"date"`).

**Example:**
```
{"tool": "get_current_time", "arguments": {"format": "full"}}
```

---

### `finish(message)`

Signal that a task is complete. Provides a summary message that is displayed to the user.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | No (default: `"Task completed"`) | Completion message |

**Behavior:**
- The agent intercepts `finish()` in several cases to provide guidance:
  - **No entry point written:** If the LLM calls `finish()` without writing a recognized entry point file (e.g., `app.js`, `index.js`), the agent injects guidance to write the entry point first
  - **npm init in same batch:** If `finish()` is called in the same response as `npm init`/`npm install` without writing any code, the finish is skipped and the LLM is re-prompted to write source files
  - **Question-answering sessions:** If the LLM has only used information-retrieval tools (`search_web`, `fetch_url`, `get_current_time`) and no file-creation tools, `finish()` proceeds normally
- After `finish()` with a valid entry point, the agent automatically runs `test_app` (self-healing) to verify the app works. If it fails, the error is injected and the LLM gets up to 3 chances to fix it

**Example:**
```
{"tool": "finish", "arguments": {"message": "Created a weather CLI app with current time display"}}
```
