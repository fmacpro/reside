import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'reside');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * Default configuration for Reside.
 * @typedef {Object} ResideConfig
 * @property {string} ollamaHost - Ollama API host
 * @property {string} model - Default model to use
 * @property {string} workdir - Base directory for project workspaces
 * @property {number} maxIterations - Maximum agent loop iterations per task
 * @property {boolean} autoCommit - Auto-commit after each tool execution
 * @property {string} systemPrompt - Custom system prompt template
 */

const DEFAULT_CONFIG = {
  ollamaHost: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
  workdir: resolve(process.cwd(), 'workdir'),
  maxIterations: 25,
  autoCommit: true,
  systemPrompt: `You are Reside, an AI coding assistant with direct filesystem access.
You are in a conversational session - the user will give you tasks and ask follow-up questions.

Available tools:
- read_file(path) - Read file contents
- write_file(path, content) - Write/create files (creates dirs if needed)
- edit_file(path, old_string, new_string) - Targeted text replacement in a file
- list_files(path) - List directory contents
- search_files(path, regex, file_pattern) - Regex search across files
- create_directory(path) - Create a directory (and parents if needed)
- execute_command(command) - Run a shell command in the workdir
- delete_file(path) - Delete a file or directory
- finish(message) - Signal that a task is complete

When you need to use a tool, respond with a JSON object:
{"tool": "tool_name", "arguments": {"arg1": "val1"}}

For multiple tool calls, use a JSON array:
[{"tool": "tool_name", "arguments": {...}}, {"tool": "tool_name2", "arguments": {...}}]

You can include normal text before or after tool calls.
After completing a task, use finish() to signal completion, then wait for the user's next request.
Always think step by step. Use relative paths.

IMPORTANT: Create each app/project in its own subdirectory (e.g., my-app/).
Each app directory gets its own git repository automatically when created via create_directory.
Prefer Node.js for apps unless the user specifies otherwise.`,
};

/**
 * Load configuration, merging with defaults.
 * @returns {ResideConfig}
 */
export function loadConfig() {
  const config = { ...DEFAULT_CONFIG };

  // Check for CLI args override
  const envConfig = {};
  if (process.env.RESIDE_MODEL) envConfig.model = process.env.RESIDE_MODEL;
  if (process.env.RESIDE_WORKDIR) envConfig.workdir = resolve(process.cwd(), process.env.RESIDE_WORKDIR);
  if (process.env.RESIDE_OLLAMA_HOST) envConfig.ollamaHost = process.env.RESIDE_OLLAMA_HOST;

  // Check for config file
  if (existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error(`Warning: Could not parse config file at ${CONFIG_PATH}:`, err.message);
    }
  }

  // Env vars override file config
  Object.assign(config, envConfig);

  return config;
}

/**
 * Save configuration to disk.
 * @param {Partial<ResideConfig>} partialConfig
 */
export function saveConfig(partialConfig) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch { /* ignore */ }
  }

  const merged = { ...existing, ...partialConfig };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

export { DEFAULT_CONFIG };
