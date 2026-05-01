import { existsSync, readdirSync } from 'node:fs';
import { relative, sep, join } from 'node:path';
import { ensureDir } from './utils/ensureDir.js';

/**
 * Create a directory (and parent directories if needed).
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createCreateDirectoryHandler(engine) {
  return async ({ path }) => {
    if (!path) return { success: false, error: 'Missing required argument: path' };
    const fullPath = engine._resolvePath(path);

    // Determine if this is a top-level app directory (direct child of workdir)
    // or a subdirectory within an existing app (e.g., "time-app/assets/").
    const rel = relative(engine.workspaceDir, fullPath);
    const isTopLevel = rel && !rel.includes(sep) && !rel.startsWith('.');

    // For top-level app directories: if it already exists and has files,
    // reject the call — the LLM should not create the same app twice.
    // For subdirectories within an app: always allow creation.
    if (existsSync(fullPath)) {
      if (isTopLevel) {
        // Check if it's a non-empty directory (likely an existing app)
        const entries = readdirSync(fullPath);
        if (entries.length > 0 && !entries.every(e => e.startsWith('.'))) {
          return {
            success: false,
            error: `Directory "${path}" already exists and contains files. Cannot overwrite existing apps. Please reprompt and specify a new name for the app.`,
          };
        }
        // Empty top-level directory — allow re-creation (e.g., if it was just created and is still empty)
      }
      // Subdirectory within an app — always allow
    }

    ensureDir(fullPath);

    // Track this as the current working app for auto-cwd in execute_command
    if (isTopLevel) {
      engine._currentApp = path;
    }

    // Auto-init git ONLY for top-level app directories (direct children of workdir).
    // Subdirectories within an app (e.g., my-app/src/) must NOT get their own git repo.
    if (engine.workspaceManager) {
      const insideExistingGit = engine.workspaceManager.resolveAppDir(fullPath) !== null;
      if (isTopLevel && !insideExistingGit) {
        engine.workspaceManager.initAppGit(fullPath);
      }
    }

    return {
      success: true,
      output: existsSync(fullPath) ? `Directory already exists: ${path}` : `Created directory: ${path}`,
      data: { path },
    };
  };
}
