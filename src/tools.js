import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { execSync, spawn } from 'node:child_process';

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
   * @param {import('./workspace.js').WorkspaceManager} [workspaceManager] - For git init on new dirs
   */
  constructor(workspaceDir, workspaceManager = null) {
    this.workspaceDir = resolve(workspaceDir);
    this.workspaceManager = workspaceManager;
  }

  /**
   * Execute a tool call.
   * @param {string} tool - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<ToolResult>}
   */
  async execute(tool, args) {
    const handler = this._getHandler(tool);
    if (!handler) {
      return {
        success: false,
        error: `Unknown tool: "${tool}". Available tools: ${this.getToolNames().join(', ')}`,
      };
    }

    try {
      return await handler(args);
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
    const resolved = resolve(this.workspaceDir, targetPath);
    const rel = relative(this.workspaceDir, resolved);
    if (rel.startsWith('..') || (sep === '\\' && /^[a-zA-Z]:\\/.test(rel) && !rel.startsWith(this.workspaceDir))) {
      throw new Error(`Path "${targetPath}" is outside the workspace`);
    }
    return resolved;
  }

  /** Ensure a directory exists. */
  _ensureDir(dirPath) {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /** Get tool definitions with metadata. */
  _getDefinitions() {
    return {
      read_file: {
        desc: 'Read the contents of a file',
        params: ['path'],
      },
      write_file: {
        desc: 'Write content to a file (creates directories if needed)',
        params: ['path', 'content'],
      },
      edit_file: {
        desc: 'Make targeted edits to an existing file by replacing text',
        params: ['path', 'old_string', 'new_string'],
      },
      list_files: {
        desc: 'List files and directories in a path',
        params: ['path'],
      },
      search_files: {
        desc: 'Search for patterns in files using regex',
        params: ['path', 'regex', 'file_pattern'],
      },
      execute_command: {
        desc: 'Run a shell command in the workspace directory (10s timeout; use & for long-running processes like servers)',
        params: ['command'],
      },
      create_directory: {
        desc: 'Create a directory (and parent directories if needed)',
        params: ['path'],
      },
      delete_file: {
        desc: 'Delete a file or directory',
        params: ['path'],
      },
      finish: {
        desc: 'Call this when the task is complete',
        params: ['message'],
      },
    };
  }

  /** Get the handler function for a tool. */
  _getHandler(tool) {
    const handlers = {
      read_file: async ({ path }) => {
        if (!path) return { success: false, error: 'Missing required argument: path' };
        const fullPath = this._resolvePath(path);
        if (!existsSync(fullPath)) {
          return { success: false, error: `File not found: ${path}` };
        }
        const content = readFileSync(fullPath, 'utf-8');
        return {
          success: true,
          output: content,
          data: { path, content, size: content.length },
        };
      },

      write_file: async ({ path, content }) => {
        if (!path) return { success: false, error: 'Missing required argument: path' };
        if (content === undefined || content === null) return { success: false, error: 'Missing required argument: content' };
        const fullPath = this._resolvePath(path);
        this._ensureDir(join(fullPath, '..'));
        writeFileSync(fullPath, String(content), 'utf-8');
        return {
          success: true,
          output: `Written ${String(content).length} bytes to ${path}`,
          data: { path, bytes: String(content).length },
        };
      },

      edit_file: async ({ path, old_string, new_string }) => {
        if (!path) return { success: false, error: 'Missing required argument: path' };
        if (!old_string) return { success: false, error: 'Missing required argument: old_string' };
        if (new_string === undefined) return { success: false, error: 'Missing required argument: new_string' };

        const fullPath = this._resolvePath(path);
        if (!existsSync(fullPath)) {
          return { success: false, error: `File not found: ${path}` };
        }

        const content = readFileSync(fullPath, 'utf-8');
        const idx = content.indexOf(old_string);
        if (idx === -1) {
          return { success: false, error: `Could not find the specified text in ${path}` };
        }

        const newContent = content.replace(old_string, new_string);
        writeFileSync(fullPath, newContent, 'utf-8');
        return {
          success: true,
          output: `Edited ${path}: replaced "${old_string.substring(0, 50)}..." with "${new_string.substring(0, 50)}..."`,
          data: { path, replaced: old_string.length, bytes: newContent.length },
        };
      },

      list_files: async ({ path = '.' }) => {
        const fullPath = this._resolvePath(path);
        if (!existsSync(fullPath)) {
          return { success: false, error: `Directory not found: ${path}` };
        }

        const entries = readdirSync(fullPath);
        const items = entries.map(name => {
          const stat = statSync(join(fullPath, name));
          return {
            name,
            type: stat.isDirectory() ? 'directory' : 'file',
            size: stat.size,
          };
        });

        const output = items
          .map(i => `${i.type === 'directory' ? '📁' : '📄'} ${i.name}${i.type === 'file' ? ` (${i.size} bytes)` : ''}`)
          .join('\n');
        return {
          success: true,
          output: output || '(empty directory)',
          data: { path, items },
        };
      },

      search_files: async ({ path = '.', regex, file_pattern }) => {
        if (!regex) return { success: false, error: 'Missing required argument: regex' };

        const fullPath = this._resolvePath(path);
        if (!existsSync(fullPath)) {
          return { success: false, error: `Path not found: ${path}` };
        }

        const grepCmd = `grep -rn${file_pattern ? ` --include="${file_pattern}"` : ''} "${regex}" "${fullPath}" 2>/dev/null | head -100`;
        try {
          const result = execSync(grepCmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          const lines = result.trim().split('\n').filter(Boolean);
          return {
            success: true,
            output: lines.length > 0 ? lines.join('\n') : 'No matches found',
            data: { matches: lines.length, results: lines.slice(0, 100) },
          };
        } catch {
          return {
            success: true,
            output: 'No matches found',
            data: { matches: 0, results: [] },
          };
        }
      },

      execute_command: async ({ command }) => {
        if (!command) return { success: false, error: 'Missing required argument: command' };

        // Security: block destructive commands
        const blocked = ['rm -rf /', 'rm -rf ~', ':(){ :|:& };:', 'dd if=', 'mkfs', '> /dev/sda'];
        for (const pattern of blocked) {
          if (command.includes(pattern)) {
            return { success: false, error: 'Command blocked for security: contains dangerous pattern' };
          }
        }

        // Use spawn for async execution with timeout
        return new Promise(resolve => {
          const child = spawn('/bin/sh', ['-c', command], {
            cwd: this.workspaceDir,
            env: { ...process.env, PATH: process.env.PATH },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
          });

          let stdout = '';
          let stderr = '';
          let timedOut = false;

          const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Give it a moment to clean up, then SIGKILL
            setTimeout(() => {
              try { child.kill('SIGKILL'); } catch {}
            }, 1000);
          }, 10_000);

          child.stdout.on('data', data => { stdout += data.toString(); });
          child.stderr.on('data', data => { stderr += data.toString(); });

          child.on('close', code => {
            clearTimeout(timeout);

            if (timedOut) {
              // Command timed out — likely a long-running process (server, watcher, etc.)
              // Return success with the output collected so far
              const output = stdout.trim() || stderr.trim() || '(process started, still running)';
              resolve({
                success: true,
                output: `${output}\n\n⚠️ Command timed out after 10s — long-running processes should use & (background) or nohup.`,
                data: { exitCode: null, timedOut: true, stdout, stderr },
              });
              return;
            }

            if (code === 0) {
              resolve({
                success: true,
                output: stdout.trim() || '(command completed with no output)',
                data: { exitCode: 0, stdout, stderr },
              });
            } else {
              resolve({
                success: false,
                output: stdout.trim() || stderr.trim() || `(exit code ${code})`,
                error: stderr.trim() || `Command failed with exit code ${code}`,
                data: { exitCode: code, stdout, stderr },
              });
            }
          });

          child.on('error', err => {
            clearTimeout(timeout);
            resolve({
              success: false,
              error: `Failed to execute command: ${err.message}`,
              data: { exitCode: null, stdout, stderr },
            });
          });
        });
      },

      create_directory: async ({ path }) => {
        if (!path) return { success: false, error: 'Missing required argument: path' };
        const fullPath = this._resolvePath(path);
        this._ensureDir(fullPath);

        // Auto-init git ONLY for top-level app directories (direct children of workdir).
        // Subdirectories within an app (e.g., my-app/src/) must NOT get their own git repo.
        if (this.workspaceManager) {
          const rel = relative(this.workspaceDir, fullPath);
          const isTopLevel = rel && !rel.includes(sep) && !rel.startsWith('.');
          const insideExistingGit = this.workspaceManager.resolveAppDir(fullPath) !== null;
          if (isTopLevel && !insideExistingGit) {
            this.workspaceManager.initAppGit(fullPath);
          }
        }

        return {
          success: true,
          output: `Created directory: ${path}`,
          data: { path },
        };
      },

      delete_file: async ({ path }) => {
        if (!path) return { success: false, error: 'Missing required argument: path' };
        const fullPath = this._resolvePath(path);
        if (!existsSync(fullPath)) {
          return { success: false, error: `Path not found: ${path}` };
        }

        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          rmSync(fullPath, { recursive: true, force: true });
        } else {
          unlinkSync(fullPath);
        }
        return {
          success: true,
          output: `Deleted ${path}`,
          data: { path, type: stat.isDirectory() ? 'directory' : 'file' },
        };
      },

      finish: async ({ message = 'Task completed' }) => {
        return {
          success: true,
          output: message,
          data: { finished: true, message },
        };
      },
    };

    return handlers[tool] || null;
  }
}
