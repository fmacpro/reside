# Reside

A simplified Node.js-based agentic IDE for local LLMs via Ollama. Reside understands Qwen's native JSON tool call format — something most agentic IDE plugins get wrong.

**Zero dependencies.** Pure Node.js. No npm install needed.

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

1. Create app directories under `workdirs/`
2. Initialize a git repository in each new app directory
3. Process your task through the LLM
4. Execute tool calls (write files, run commands, etc.)
5. Auto-commit changes to each app's git repo
6. Print a summary and exit

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

📁 Workdir: /home/user/reside/workdirs
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
| `execute_command(command, cwd?)`          | Run a shell command (defaults to workdir root; use `cwd` to run inside an app directory like `"my-app"`) |
| `delete_file(path)`                       | Delete a file or directory                                                                               |
| `search_web(query)`                     | Search the web for information (DuckDuckGo Lite, no API key needed)                          |
| `finish(message)`                       | Signal that a task is complete                                                               |

### Web Search

The `search_web(query)` tool uses [DuckDuckGo Lite](https://lite.duckduckgo.com/lite/) — a free, privacy-respecting search endpoint that requires **no API key** and **no registration**. Results are parsed from the HTML response and returned as structured data (title, snippet, URL) for the LLM to use.

**How the LLM uses it:**
```
💬 > What's the latest version of Node.js?

🤖 Let me search for that...

🔧 search_web({"query":"latest Node.js version 2026"})
   ✅ 1. Node.js — Download the latest LTS version
      https://nodejs.org/
   2. Node.js Releases
      Node.js 22.x is the current LTS release...
      https://nodejs.org/en/about/releases/

🤖 The latest LTS version of Node.js is 22.x...
```

The tool is implemented with zero dependencies — it uses Node.js built-in `https` module for the HTTP request and regex-based HTML parsing.

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
#      /home/user/reside/workdirs/my-app
#      a1b2c3d Iteration 1: create_directory, write_file
#      e5f6g7h Initial commit
#   📁 todo-app       (no git yet)
#      /home/user/reside/workdirs/todo-app
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
├── package.json              # Project manifest (ESM, zero deps)
├── README.md                 # This file
├── src/
│   ├── index.js              # CLI entry point with argument parsing
│   ├── config.js             # Configuration system (file + env vars)
│   ├── ollama.js             # Native Node.js HTTP Ollama API client
│   ├── parser.js             # Qwen tool call parser (2.5 + 3.5 formats)
│   ├── tools.js              # Tool execution engine (10 tools: filesystem + web search)
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
     │                executes tools, feeds results back
     │
     ├── src/ollama.js      HTTP client for Ollama API
     ├── src/parser.js      Parses Qwen's JSON tool call format
     ├── src/tools.js       Filesystem tool implementations
     └── src/workspace.js   Workdir management with per-app git repos
```

## Why Reside?

Most agentic IDE plugins don't understand Qwen's JSON tool call format properly. They expect OpenAI-style `function_call` structures, but Qwen outputs tool calls as JSON objects embedded in the response text — either wrapped in markdown code fences (2.5 Coder) or as raw JSON (3.5).

Reside was built specifically to handle this format correctly, with zero dependencies and maximum efficiency.
