import { resolve } from 'node:path';
import { getToolDefinitions } from './utils/toolDefinitions.js';
import { resolvePath } from './utils/resolvePath.js';
import { extractAppName } from './utils/extractAppName.js';
import { createReadFileHandler } from './readFile.js';
import { createWriteFileHandler } from './writeFile.js';
import { createEditFileHandler } from './editFile.js';
import { createListFilesHandler } from './listFiles.js';
import { createSearchFilesHandler } from './searchFiles.js';
import { createExecuteCommandHandler } from './executeCommand.js';
import { createCreateDirectoryHandler } from './createDirectory.js';
import { createDeleteFileHandler } from './deleteFile.js';
import { createSearchNpmHandler } from './searchNpm.js';
import { createSearchWebHandler } from './searchWeb.js';
import { createFetchUrlHandler } from './fetchUrl.js';
import { createGetCurrentTimeHandler } from './getCurrentTime.js';
import { createTestAppHandler } from './testApp.js';
import { createFinishHandler } from './finish.js';

/**
 * @typedef {Object} ToolResult
 * @property {boolean} success
 * @property {string} [output] - Human-readable result
 * @property {any} [data] - Structured data for the model
 * @property {string} [error] - Error message if failed
 */

/**
 * Tool execution engine.
 * All tools operate within a designated workspace directory.
 */
export class ToolEngine {
  /**
   * @param {string} workspaceDir - Absolute path to the workspace
   * @param {import('../workspace.js').WorkspaceManager} [workspaceManager] - For git init on new dirs
   * @param {object} [config] - Reside configuration
   */
  constructor(workspaceDir, workspaceManager = null, config = {}) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspaceManager = workspaceManager;
    this.config = config;

    // Track the "current working app" — the most recently created or written-to app directory.
    // When execute_command is called without cwd, it will automatically use this app's directory.
    this._currentApp = null;

    // Initialize handler registry (lazily populated)
    this._handlerRegistry = {};
  }

  /**
   * Extract the top-level app directory name from a path.
   * Returns null if the path is not inside an app subdirectory.
   * @param {string} path
   * @returns {string|null}
   */
  _extractAppName(path) {
    return extractAppName(this.workspaceDir, path);
  }

  /**
   * Strip unknown/extra arguments from a tool call that are not in the tool's
   * parameter list. Some models (e.g., Qwen 3.5) hallucinate extra parameters
   * like "createRequire" in write_file calls — these should be silently removed
   * rather than passed to the handler or echoed back in tool results.
   *
   * This is a public method so the agent can also use it when building tool
   * result messages — ensuring hallucinated params are never echoed back to
   * the LLM (which would reinforce the hallucination).
   *
   * @param {string} tool - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Object} The filtered arguments object
   */
  stripUnknownArgs(tool, args) {
    if (!args || typeof args !== 'object') return args;
    const defs = this._getDefinitions();
    const def = defs[tool];
    if (!def) return args;

    // Extract valid parameter names (strip trailing '?' for optional params)
    const validParams = new Set(def.params.map(p => p.replace(/\?$/, '')));
    const filtered = {};
    for (const [key, value] of Object.entries(args)) {
      if (validParams.has(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  /**
   * Execute a tool call.
   * @param {string} tool - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<ToolResult>}
   */
  async execute(tool, args) {
    // Resolve tool aliases first (e.g., "rename_file" -> "edit_file")
    const toolAliases = {
      'rename_file': 'edit_file',
      'rename': 'edit_file',
      'move_file': 'edit_file',
      'copy_file': 'write_file',
      'delete': 'delete_file',
      'remove': 'delete_file',
      'mkdir': 'create_directory',
      'create_dir': 'create_directory',
      'ls': 'list_files',
      'dir': 'list_files',
      'cat': 'read_file',
      'type': 'read_file',
      'grep': 'search_files',
      'find': 'search_files',
      'exec': 'execute_command',
      'run': 'execute_command',
      'shell': 'execute_command',
      'npm': 'execute_command',
      'node': 'execute_command',
    };
    const resolvedTool = toolAliases[tool] || tool;

    const handler = this._getHandler(resolvedTool);
    if (!handler) {
      return {
        success: false,
        error: `Unknown tool: "${tool}". Available tools: ${this.getToolNames().join(', ')}`,
      };
    }

    try {
      // Strip unknown/extra arguments that the LLM may have hallucinated.
      const cleanArgs = this.stripUnknownArgs(resolvedTool, args);
      return await handler(cleanArgs);
    } catch (err) {
      return { success: false, error: `Error executing "${tool}": ${err.message}` };
    }
  }

  /**
   * Get the list of available tool names.
   */
  getToolNames() {
    return Object.keys(this._getDefinitions());
  }

  /**
   * Get tool descriptions formatted for the system prompt.
   */
  getToolDescriptions() {
    const defs = this._getDefinitions();
    return Object.entries(defs)
      .map(([name, def]) => `- **${name}(${def.params.join(', ')})** - ${def.desc}`)
      .join('\n');
  }

  /**
   * Validate that a path is within the workspace (security).
   */
  _resolvePath(targetPath) {
    return resolvePath(this.workspaceDir, targetPath);
  }

  /** Get tool definitions with metadata. */
  _getDefinitions() {
    return getToolDefinitions();
  }

  /** Get the handler function for a tool. */
  _getHandler(tool) {
    // Lazy-initialize handlers on first access
    if (!this._handlerRegistry[tool]) {
      this._handlerRegistry[tool] = this._createHandler(tool);
    }
    return this._handlerRegistry[tool];
  }

  /** Create a handler function for the given tool. */
  _createHandler(tool) {
    const handlerFactories = {
      read_file: createReadFileHandler,
      write_file: createWriteFileHandler,
      edit_file: createEditFileHandler,
      list_files: createListFilesHandler,
      search_files: createSearchFilesHandler,
      execute_command: createExecuteCommandHandler,
      create_directory: createCreateDirectoryHandler,
      delete_file: createDeleteFileHandler,
      search_npm_packages: createSearchNpmHandler,
      search_web: createSearchWebHandler,
      fetch_url: createFetchUrlHandler,
      get_current_time: createGetCurrentTimeHandler,
      test_app: createTestAppHandler,
      finish: createFinishHandler,
    };

    const factory = handlerFactories[tool];
    if (!factory) return null;

    return factory(this);
  }
}
