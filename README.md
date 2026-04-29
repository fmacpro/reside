# Reside

A simplified Node.js-based agentic IDE for local LLMs via Ollama. Reside understands Qwen's native JSON tool call format — something most agentic IDE plugins get wrong.

**Minimal dependencies.** Pure Node.js with optional Puppeteer for web search and content fetching.

## Key Features

- **Local & private** — Runs entirely on your machine via Ollama. No data leaves your computer.
- **Qwen-native** — Understands both Qwen 2.5 Coder (markdown-fenced JSON) and Qwen 3.5 (raw JSON with `thinking` field) tool call formats out of the box. Automatically repairs common LLM JSON mistakes like template literals (backtick strings), trailing commas, and single quotes.
- **12 built-in tools** — Filesystem operations, web search, URL content extraction, current time, and shell command execution.
- **ESM-by-default** — All new Node.js apps automatically get `"type": "module"` in `package.json` after `npm init -y`, so the LLM uses `import`/`export` syntax instead of `require()`.
- **Prevents "talks instead of doing"** — The system prompt explicitly forbids the LLM from stopping after `npm install` to provide example code. It must always create the actual source files with `write_file()` and tell the user the command to run.
- **Per-app git repos** — Each project directory gets its own independent git repository with auto-commit after every tool execution.
- **Web-aware** — Search the web via DuckDuckGo (no API key needed), fetch and extract article content from any URL, with automatic Puppeteer fallback for bot-protected sites.
- **Loop-safe** — Detects when the LLM gets stuck in a tool-calling loop and forces a text response.
- **JSON repair** — Automatically fixes common LLM JSON mistakes: backtick template literals (`\`code\`` → `"code"`), trailing commas, and single quotes — so tool calls succeed even when the model outputs slightly malformed JSON.
- **Placeholder rejection** — Detects and rejects stub/placeholder content in `write_file` (e.g., `// Your code here`, empty function bodies), forcing the LLM to write complete, working code.
- **Pre-install verification** — Before running `npm install <pkg>`, verifies the package exists on the registry and is compatible with the current Node.js version (v24.13.1).
- **Native module preference** — The system prompt instructs the LLM to favor Node.js built-in modules over external npm packages, reducing dependencies.
- **Server-aware** — CLI/TUI apps (`node app.js`, `python app.py`) run and complete normally with a 5-second timeout. Known server commands (`npm start`, `npm run dev`, `npx serve`) are blocked — the LLM tells you the command to run instead.
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

> **Note:** The agent builds your app — it creates source files, installs dependencies, and sets up the project structure. For Node.js apps, `"type": "module"` is automatically added to `package.json` so the LLM uses `import`/`export` syntax. The agent does **not** attempt to run the app; it tells you the exact command to run in your terminal instead.

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

💬 > What time is it?

🔧 get_current_time({"format":"full"})
   ✅ Monday, 28 April 2026 at 10:15:42 British Summer Time (Europe/London, unix: 1777356942)

🤖 It's Monday, 28 April 2026, 10:15:42 BST (Europe/London).

💬 > What's the current price of bitcoin?

🔧 search_web({"query":"current bitcoin price USD"})
   ✅ Found 5 results

🤖 The current price of Bitcoin is approximately $76,711.52 USD as of the latest data.

💬 > Create a weather CLI app that takes a city name and shows the temperature

🔧 create_directory({"path":"weather-cli"})
   ✅ Directory created

🔧 write_file({"path":"weather-cli/app.js","content":"import https from 'node:https';\nconst city = process.argv[2] || 'London';\nconst url = `https://wttr.in/${city}?format=%t+%C`;\nhttps.get(url, res => {\n  let data = '';\n  res.on('data', c => data += c);\n  res.on('end', () => console.log(`${city}: ${data.trim()}`));\n});"})
   ✅ Written 278 bytes to weather-cli/app.js

🔧 test_app({"args":"London"})
   ✅ London: +12°C Partly cloudy

🔧 finish({"message":"Created weather-cli app that shows temperature for any city"})
   ✅ Created weather-cli app that shows temperature for any city

💬 > Now modify it to also show the humidity

🔧 read_file({"path":"weather-cli/app.js"})
   ✅ Read 278 bytes

🔧 edit_file({"file_path":"weather-cli/app.js","new_string":"const url = `https://wttr.in/${city}?format=%t+%C+%h`;\nhttps.get(url, res => {\n  let data = '';\n  res.on('data', c => data += c);\n  res.on('end', () => {\n    const [temp, condition, humidity] = data.trim().split(' ');\n    console.log(`${city}: ${temp}, ${condition}, Humidity: ${humidity}`);\n  });\n});"})
   ✅ Edited weather-cli/app.js

🔧 test_app({"args":"London"})
   ✅ London: +12°C, Partly cloudy, Humidity: 65%

🔧 finish({"message":"Updated weather-cli to show temperature, conditions, and humidity"})
   ✅ Updated weather-cli to show temperature, conditions, and humidity

💬 > /summary

📊 Session Summary:
   Iterations: 8
   Messages: 28
   Workdir: /home/user/reside/workdir
   Apps in workdir:
     📜 weather-cli
        abc1234 Iteration 1: create_directory, write_file, test_app, finish
        def5678 Iteration 2: read_file, edit_file, test_app, finish

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

The LLM has access to 12 built-in tools. See the full [Tools Reference](docs/tools.md) for detailed documentation, parameters, examples, and behavior for each tool.

| Tool                                      | Description                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`read_file(path)`](docs/tools.md#read_filepath)                         | Read the contents of a file                                                                              |
| [`write_file(path, content)`](docs/tools.md#write_filepath-content)               | Create a NEW file with content (creates directories if needed)                                           |
| [`edit_file(path, file_path, new_string)`](docs/tools.md#edit_filepath-file_path-new_string) | Edit an EXISTING file by replacing text (use `write_file` for new files)                                 |
| [`list_files(path)`](docs/tools.md#list_filespath)                        | List files and directories in a path                                                                     |
| [`search_files(path, regex, file_pattern)`](docs/tools.md#search_filespath-regex-file_pattern) | Search for patterns in files using regex                                                                 |
| [`create_directory(path)`](docs/tools.md#create_directorypath)                  | Create a directory (and parents if needed); auto-initializes git for top-level app dirs                  |
| [`execute_command(command, cwd?)`](docs/tools.md#execute_commandcommand-cwd)          | Run a shell command with timeout and auto-cwd                                                             |
| [`delete_file(path)`](docs/tools.md#delete_filepath)                       | Delete a file or directory                                                                               |
| [`search_web(query)`](docs/tools.md#search_webquery)                       | Search the web for information (DuckDuckGo, no API key needed)                                           |
| [`fetch_url(url, useBrowser?)`](docs/tools.md#fetch_urlurl-usebrowser)             | Fetch a URL and extract its main article content (strips nav, ads, boilerplate)                          |
| [`get_current_time(format?)`](docs/tools.md#get_current_timeformat)               | Get the current system date/time in various formats                                                      |
| [`test_app(args?, cwd?)`](docs/tools.md#test_appargs-cwd)                   | Test the application by running it and checking for errors                                               |
| [`finish(message)`](docs/tools.md#finishmessage)                         | Signal that a task is complete                                                                           |

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
├── test/
│   ├── config.test.js        # Config system tests
│   ├── fetchUrl.test.js      # URL fetching tests (local test server)
│   ├── integration.test.js   # End-to-end LLM simulation tests
│   ├── parser.test.js        # JSON tool call parser tests
│   ├── tools.test.js         # Tool execution engine tests
│   ├── workspace.test.js     # Workspace manager tests
│   ├── test-server.js        # Local HTTP test server for fetch tests
│   └── fixtures/             # HTML test pages for local server
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
