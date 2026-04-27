# Reside

A simplified Node.js-based agentic IDE for local LLMs via Ollama. Reside understands Qwen's native JSON tool call format — something most agentic IDE plugins get wrong.

**Minimal dependencies.** Pure Node.js with optional Puppeteer for web search and content fetching.

## Key Features

- **Local & private** — Runs entirely on your machine via Ollama. No data leaves your computer.
- **Qwen-native** — Understands both Qwen 2.5 Coder (markdown-fenced JSON) and Qwen 3.5 (raw JSON with `thinking` field) tool call formats out of the box.
- **12 built-in tools** — Filesystem operations, web search, URL content extraction, current time, and shell command execution.
- **Per-app git repos** — Each project directory gets its own independent git repository with auto-commit after every tool execution.
- **Web-aware** — Search the web via DuckDuckGo (no API key needed), fetch and extract article content from any URL, with automatic Puppeteer fallback for bot-protected sites.
- **Loop-safe** — Detects when the LLM gets stuck in a tool-calling loop and forces a text response.
- **Server-aware** — Blocks commands that start long-running server processes (e.g., `node app.js`, `npm start`) and tells the LLM to output instructions for the user instead.
- **Compact CLI output** — One-line tool status summaries by default; `--debug` flag for full verbose output.
- **Model-agnostic** — Works with any Ollama model, not just Qwen.

## How It Works

Reside connects to a local LLM running in Ollama, gives it filesystem access through a set of tools, and lets it build projects inside a workdir. Each app/project directory gets its own independent git repository.

```
You ──> reside ──> Ollama (qwen2.5-coder / qwen3.5)
            │
            └──> Workdir/
                    ├── my-app/        (git repo)
                    │   ├── index.js
                    │   └── style.css
                    ├── todo-app/      (git repo)
                    │   └── app.js
                    └── api-server/    (git repo)
                        └── server.js
```

## Prerequisites

- **Node.js** v18+ (tested on v24)
- **Ollama** running locally with at least one model pulled
- **Google Chrome** (for web search and browser-based URL fetching) — `search_web` and `fetch_url` (browser mode) use Puppeteer with stealth plugin to bypass bot detection. Install Chrome via your package manager or download from [google.com/chrome](https://www.google.com/chrome/).

```bash
# Install a model if you haven't already
ollama pull qwen2.5-coder:7b
ollama pull qwen3.5:latest
```

## Quick Start

```bash
# Clone or create the project
cd reside

# Run a single task
node src/index.js "Create a simple HTML page with a blue button"

# Start an interactive chat session
node src/index.js --chat

# Use a specific model
node src/index.js --chat --model qwen3.5:latest
```

## Usage

### Single-Run Mode

Run a task and exit:

```bash
node src/index.js "Create a simple Express.js API server with a /hello endpoint"
```

The agent will:

1. Create app directories under `workdir/`
2. Initialize a git repository in each new app directory
3. Process your task through the LLM
4. Execute tool calls (write files, run commands, etc.)
5. Auto-commit changes to each app's git repo
6. Tell you the command to run to start the app (e.g., `node app.js` in the app directory)
7. Print a summary and exit

> **Note:** The agent builds your app but does **not** run server processes (e.g., `node app.js`, `npm start`). These are long-running processes that can't be managed interactively. Instead, the agent tells you the exact command to run in your terminal.

### Conversational Chat Mode

Start an interactive session where you can have a back-and-forth conversation:

```bash
node src/index.js --chat
```

This opens a REPL prompt where you can type messages, ask follow-up questions, and give sequential instructions. The model remembers the conversation history.

**Chat commands:**

| Command              | Description                                      |
| -------------------- | ------------------------------------------------ |
| `/exit` or `/quit`   | End the session and quit                         |
| `/sum` or `/summary` | Show session summary                             |
| `/git` or `/log`     | Show git commit log for all apps                 |
| `/apps`              | List apps in the workdir                         |
| `/clear`             | Clear conversation history (keeps system prompt) |
| `/model`             | Show the current model                           |
| `/help`              | Show available commands                          |

Example chat session:

```
$ node src/index.js --chat

📁 Workdir: /home/user/reside/workdir
🤖 Model: qwen2.5-coder:7b

Interactive mode. Type your messages or commands:

💬 > Create a simple HTML page called index.html in a new app called my-site

🔧 create_directory({"path":"my-site"})
   ✅ Created directory: my-site

🔧 write_file({"path":"my-site/index.html","content":"<!DOCTYPE html>..."})
   ✅ Written 142 bytes to my-site/index.html

🔧 finish({"message":"Created my-site with index.html"})
   ✅ Created my-site with index.html

💬 > Now add a CSS file to style it

🔧 write_file({"path":"my-site/style.css","content":"body { font-family: sans-serif; }"})
   ✅ Written 32 bytes to my-site/style.css

🔧 finish({"message":"Added style.css"})
   ✅ Added style.css

💬 > /exit
```

### Loading Tasks from a File

```bash
node src/index.js --file task.txt
```

### Listing Models and Apps

```bash
# List all models available in Ollama
node src/index.js --list-models

# List all apps in the workdir (with git status)
node src/index.js --list-apps
```

### Configuration

```bash
# Set the default model
node src/index.js --set model qwen3.5:latest

# Set the workdir directory
node src/index.js --set workdir /path/to/projects
```

Configuration is stored in `~/.config/reside/config.json`. You can also use environment variables:

| Variable             | Description                                         |
| -------------------- | --------------------------------------------------- |
| `RESIDE_MODEL`       | Default model name                                  |
| `RESIDE_WORKDIR`     | Base workdir directory                              |
| `RESIDE_OLLAMA_HOST` | Ollama API host (default: `http://localhost:11434`) |

## Available Tools

The LLM has access to these tools:

| Tool                                      | Description                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `read_file(path)`                         | Read the contents of a file                                                                              |
| `write_file(path, content)`               | Create a NEW file with content (creates directories if needed)                                           |
| `edit_file(path, old_string, new_string)` | Edit an EXISTING file by replacing text (use `write_file` for new files)                                 |
| `list_files(path)`                        | List files and directories in a path                                                                     |
| `search_files(path, regex, file_pattern)` | Search for patterns in files using regex                                                                 |
| `create_directory(path)`                  | Create a directory (and parents if needed); auto-initializes git for top-level app dirs                  |
| `execute_command(command, cwd?)`          | Run a shell command (defaults to workdir root; use `cwd` to run inside an app directory like `"my-app"`). **Cannot start server processes** — use `finish()` to tell the user the command to run instead. |
| `delete_file(path)`                       | Delete a file or directory                                                                               |
| `search_web(query)`                       | Search the web for information (DuckDuckGo, no API key needed)                                           |
| `fetch_url(url, useBrowser?)`             | Fetch a URL and extract its main article content (strips nav, ads, boilerplate)                          |
| `get_current_time(format?)`               | Get the current system date/time. Formats: "full" (default), "date", "time", "day", "month", "year", "timestamp" |
| `finish(message)`                         | Signal that a task is complete                                                                           |

### Web Search

The `search_web(query)` tool uses [DuckDuckGo](https://html.duckduckgo.com/html/) — a free, privacy-respecting search engine that requires **no API key** and **no registration**. Results are returned as structured data (title, snippet, URL) for the LLM to use.

**How the LLM uses it:**
```
💬 > What's the latest version of Node.js?

🤖 Let me search for that...

🔧 search_web({"query":"latest Node.js version 2026"})
   ✅ Found 3 results

🤖 The latest LTS version of Node.js is 22.x...
```

The tool uses **Puppeteer** with the `puppeteer-extra-plugin-stealth` plugin to bypass bot detection. It launches a headless Chrome browser with a desktop viewport, navigates to DuckDuckGo HTML, and extracts results from the rendered page. Ads are automatically filtered out, and redirect URLs are resolved to their real destinations.

`search_web` also follows the top result links to fetch actual article content (titles and summaries), so the LLM gets rich information directly from search results without needing a separate `fetch_url` call.

> **Note:** `search_web` requires Google Chrome to be installed on your system. The default Chrome path is `/usr/bin/google-chrome`. You can modify the `executablePath` in [`src/search.js`](src/search.js:26) if Chrome is installed elsewhere.

### Web Search + Fetch Workflow

The `search_web` and `fetch_url` tools work together to give the LLM access to current web content:

1. **Search** — `search_web("query")` returns a list of results with titles, snippets, and URLs (already fetched from the source pages)
2. **Fetch** — `fetch_url("https://...")` retrieves the full article content from a specific URL when the user asks for more detail

**Example workflow:**
```
💬 > What's the latest news about Node.js?

🔧 search_web({"query":"Node.js latest news 2026"})
   ✅ Found 3 results
   1. Node.js 24 Released with New Features
      Node.js 24 brings significant performance improvements...
      https://nodejs.org/en/blog/release/v24
   2. Node.js 22.x LTS Now Available
      ...

🤖 Node.js 24 has been released with V8 12.4, better ESM support...
```

The LLM presents search results directly — it does **not** call `fetch_url` on search results since `search_web` already fetches article content. `fetch_url` is only used when the user explicitly asks for the full text of a specific article.

### Fetch URL

The `fetch_url(url)` tool fetches a web page and extracts its main article content using a heuristic content detection algorithm adapted from [horseman-article-parser](https://github.com/fmacpro/horseman-article-parser). It:

- **Strips boilerplate** — Removes navigation, headers, footers, sidebars, ads, cookie notices, and other non-content elements
- **Detects the main content** — Uses a scoring system that evaluates text density, paragraph structure, link density, and semantic HTML elements (`<article>`, `<main>`, `[role="main"]`)
- **Preserves structure** — Outputs clean text with headings, lists, blockquotes, and code blocks formatted for readability
- **Zero dependencies** — Uses only Node.js built-in `http`/`https` modules and a lightweight custom HTML parser
- **Optional browser rendering** — For JavaScript-heavy pages (SPAs, dynamic content), pass `useBrowser=true` to render with Puppeteer before extraction
- **Automatic fallback** — If the HTTP request is blocked with 403/401/429 (Cloudflare, bot protection), it automatically retries using Puppeteer with stealth plugins

**How it works internally (default HTTP mode):**
1. Fetches the page HTML via HTTPS with a browser-like User-Agent
2. Parses the HTML into a lightweight DOM tree (no JSDOM needed)
3. Gathers candidate content containers using positive selectors (`<article>`, `<main>`, content class patterns like `.post-content`, `.entry-content`, `#article`)
4. Scores each candidate using heuristic features (text length, paragraph count, link density, presence of semantic tags like `<h1>`–`<h6>`, `<p>`, `<ul>`, `<blockquote>`)
5. Selects the highest-scoring candidate and strips negative containers (nav, footer, aside, script, style, `.comment`, `.sidebar`, `.ad`)
6. Returns the best candidate as clean formatted text with structural spacing

**Browser mode (`useBrowser=true` or automatic fallback):**
1. Launches a headless Chrome browser via Puppeteer (shared instance with `search_web`)
2. Detects and waits for Cloudflare challenges to resolve (checks page title, body text, and DOM selectors for challenge indicators like "Just a moment", "Checking your browser")
3. Renders the page with JavaScript enabled, waiting for dynamic content to load
4. Extracts text using a heuristic scoring algorithm on the rendered DOM (same algorithm as HTTP mode, but operating on the live DOM)
5. Falls back to `document.body.innerText` if heuristic extraction yields fewer than 200 characters (handles JS-heavy SPAs that don't use semantic HTML)
6. Strips hidden elements, scripts, styles, nav, footer, and header
7. Returns clean text with structural spacing preserved

### Get Current Time

The `get_current_time(format?)` tool returns the current system date and time using Node.js built-in `Date` and `Intl.DateTimeFormat` APIs. It supports multiple output formats:

| Format        | Example output                              |
| ------------- | ------------------------------------------- |
| `"full"`      | `Monday, 27 April 2026 at 20:35:36 British Summer Time (Europe/London, unix: 1777318536)` |
| `"date"`      | `2026-04-27`                                |
| `"time"`      | `20:35:36`                                  |
| `"day"`       | `Monday`                                    |
| `"month"`     | `April`                                     |
| `"year"`      | `2026`                                      |
| `"timestamp"` | `1777318536`                                |

The LLM automatically selects the appropriate format based on the question (e.g., "what time is it?" → `"time"`, "what's the date?" → `"date"`). Structured data with all fields is always returned regardless of format.

## Debug Mode

To see full raw LLM responses, intermediate logs, and verbose tool output, use the `--debug` flag:

```bash
# Single task with debug output
node src/index.js --debug "Create a simple HTML page"

# Chat mode with debug output
node src/index.js --chat --debug
```

In debug mode, the agent shows:
- Full raw JSON arguments for each tool call
- Complete tool output (truncated at 500 chars)
- Intermediate logs from search and fetch operations (e.g., "DDG returned N raw results", "Followed N results")
- No compact one-liner summaries — you see the raw output

You can also enable debug mode permanently by setting `debugMode: true` in `~/.config/reside/config.json`.

## Workdir & Git

The workdir is a container directory (default: `workdir/`). Each app/project you create gets its own subdirectory with an independent git repository:

- **Per-app git repos** — `create_directory("my-app")` auto-initializes git in `my-app/`
- **Auto-committed** — Changes are committed to each app's git repo after each tool execution iteration
- **Sandboxed** — Path traversal is blocked; tools can't escape the workdir
- **Independent history** — Each app has its own commit log, branches, and state
- **No files in the root** — Files must always be written inside an app subdirectory (e.g., `my-app/app.js`), never directly in the workdir root. The `write_file` tool will reject root-level paths with a clear error message.

```bash
# List all apps with git status
node src/index.js --list-apps

# Example output:
#   📜 my-app
#      /home/user/reside/workdir/my-app
#      a1b2c3d Iteration 1: create_directory, write_file
#      e5f6g7h Initial commit
#   📁 todo-app       (no git yet)
#      /home/user/reside/workdir/todo-app
```

## Model Support

Reside is model-agnostic and works with any Ollama model. It has been tested with:

- **qwen2.5-coder:7b** — Uses markdown-fenced JSON format (` ```json {...} ``` `)
- **qwen3.5:latest** — Uses raw JSON format (no fences, includes `thinking` field)

The parser automatically detects and handles both formats. To use a different model:

```bash
node src/index.js --model llama3.2:latest "Your task here"
```

## Project Structure

```
reside/
├── package.json              # Project manifest (ESM, puppeteer deps)
├── README.md                 # This file
├── src/
│   ├── index.js              # CLI entry point with argument parsing
│   ├── config.js             # Configuration system (file + env vars)
│   ├── ollama.js             # Native Node.js HTTP Ollama API client
│   ├── parser.js             # Qwen tool call parser (2.5 + 3.5 formats)
│   ├── tools.js              # Tool execution engine (12 tools)
│   ├── fetchUrl.js           # URL fetching and article content extraction (zero deps)
│   ├── search.js             # Puppeteer-based DuckDuckGo search + browser URL fetch
│   ├── agent.js              # Main agent loop orchestrator
│   └── workspace.js          # Workdir manager with per-app git repos
└── workdir/                  # App/project directories (each with own git)
```

## Architecture

```
src/index.js          CLI argument parsing, routes to single-run or chat mode
     │
src/config.js         Loads config from ~/.config/reside/config.json + env vars
     │
src/agent.js          Agent loop: sends messages to LLM, parses responses,
     │                executes tools, feeds results back, detects loops
     │
     ├── src/ollama.js      HTTP client for Ollama API
     ├── src/parser.js      Parses Qwen's JSON tool call format
     ├── src/tools.js       Tool execution engine (filesystem + web + time)
     ├── src/fetchUrl.js    URL fetching & content extraction (zero deps)
     ├── src/search.js      Puppeteer-based DuckDuckGo search + browser URL fetch
     └── src/workspace.js   Workdir management with per-app git repos
```

## Why Reside?

Most agentic IDE plugins don't understand Qwen's JSON tool call format properly. They expect OpenAI-style `function_call` structures, but Qwen outputs tool calls as JSON objects embedded in the response text — either wrapped in markdown code fences (2.5 Coder) or as raw JSON (3.5).

Reside was built specifically to handle this format correctly, with zero dependencies and maximum efficiency.
