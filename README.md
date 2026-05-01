# Reside

A simplified Node.js-based agentic IDE for local LLMs via Ollama. Reside understands native JSON tool call formats from Qwen, Granite, DeepSeek, and other models — something most agentic IDE plugins get wrong.

**Minimal dependencies.** Pure Node.js with optional Puppeteer for web search and content fetching.

## Key Features

- **Local & private** — Runs entirely on your machine via Ollama. No data leaves your computer.
- **Model-native JSON tool calls** — Understands Qwen 2.5 Coder (markdown-fenced JSON), Qwen 3.5 (raw JSON with `thinking` field), Granite 4.1 (raw JSON), and DeepSeek Coder V2 (Unicode XML-like tags with JSON arguments) tool call formats out of the box. Automatically repairs common LLM JSON mistakes like template literals, trailing commas, and single quotes.
- **12 built-in tools** — Filesystem operations, web search (DuckDuckGo, no API key), URL content extraction, current time, and shell command execution — all with automatic error recovery and self-healing.
- **Self-healing** — After the LLM writes an app, Reside automatically runs it and injects any runtime errors back into the conversation for the LLM to fix, with up to 3 fix attempts.
- **Per-app git repos** — Each project directory gets its own independent git repository with auto-commit after every tool execution.

## How It Works

Reside connects to a local LLM running in Ollama, gives it filesystem access through a set of tools, and lets it build projects inside a workdir. Each app/project directory gets its own independent git repository.

```
You ──> reside ──> Ollama (qwen2.5-coder / qwen3.5 / granite4.1)
            │
            └──> Workdir/
                    ├── my-app/        (git repo)
                    │   ├── index.html
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
ollama pull granite4.1:8b
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

The LLM has access to 13 built-in tools. See the full [Tools Reference](docs/tools.md) for detailed documentation, parameters, examples, and behavior for each tool.

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
| [`search_npm_packages(query)`](docs/tools.md#search_npm_packagesquery)       | Search the npm registry for packages (use before `npm install` to verify package names)                  |
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

| Model | Tool Call Format | Notes |
|-------|-----------------|-------|
| **qwen2.5-coder:7b** | Markdown-fenced JSON (` ```json {...} ``` `) | Well-tested, reliable |
| **qwen3.5:latest** | Raw JSON (no fences, includes `thinking` field) | Well-tested, reliable |
| **granite4.1:8b** | Raw JSON (no fences, no thinking field) | Well-tested, reliable |
| **deepseek-coder-v2:latest** | Unicode XML-like tags (`<｜tool▁calls▁begin｜>...<｜tool▁calls▁end｜>`) with JSON arguments | Tested and working |

The parser automatically detects and handles all formats. To use a different model:

```bash
node src/index.js --model llama3.2:latest "Your task here"
```

## Project Architecture

```
src/index.js          CLI argument parsing, routes to single-run or chat mode
     │
src/config.js         Loads config from ~/.config/reside/config.json + env vars
     │
src/agent/index.js    Agent loop: sends messages to LLM, parses responses,
     │                executes tools, feeds results back, detects loops
     │
     ├── src/ollama.js      HTTP client for Ollama API
     ├── src/parser.js      Parses JSON tool call format (Qwen 2.5, Qwen 3.5, Granite)
     ├── src/tools/         Tool execution engine (13 tools, modular)
     │   ├── index.js       Tool registry and dispatch
     │   ├── testApp.js     App testing with root + src/ entry point support
     │   └── utils/         Shared utilities (workspace, fetchUrl, search, etc.)
     └── src/agent/utils/   Agent utilities (briefToolStatus, renderText)
```

## LLM Application Architecture Guidance

Reside's system prompt includes built-in guidance that tells the LLM to structure generated applications with a **controller pattern** — separating concerns into dedicated modules rather than writing everything into a single monolithic entry point file.

When the LLM builds an app, it is instructed to follow this structure:

```
my-app/
├── app.js              # Thin entry point — imports, config, server start
├── controllers/        # Route handlers / business logic per domain
│   ├── weatherController.js
│   └── userController.js
├── services/           # Business logic / data access layer
│   ├── weatherService.js
│   └── ...
├── middleware/         # Express middleware (if applicable)
├── models/             # Data models / schemas
├── utils/              # Helper functions
└── config/             # Configuration
```

**Key principles:**
- **`app.js`** stays minimal (~50 lines max): imports, middleware setup, route mounting, server startup
- **Controllers** handle routing and response formatting for a specific domain
- **Services** contain the actual business logic (API calls, database queries, file I/O)
- **Utils** hold pure helper functions (date formatting, validation, string manipulation)
- Each file has a single responsibility; split files that exceed ~200 lines
- For smaller apps (under ~100 lines total), a single file is acceptable

This guidance is embedded in the system prompt at [`src/config.js`](src/config.js:149) and applies to all apps the LLM generates.

## Why Reside?

Most agentic IDE plugins don't understand native JSON tool call formats from models like Qwen, Granite, and DeepSeek. They expect OpenAI-style `function_call` structures, but these models output tool calls as JSON objects embedded in the response text — either wrapped in markdown code fences (Qwen 2.5 Coder), as raw JSON with a `thinking` field (Qwen 3.5), as plain raw JSON (Granite 4.1), or as Unicode XML-like tags with JSON arguments (DeepSeek Coder V2).

Reside was built specifically to handle these formats correctly, with zero dependencies and maximum efficiency.
