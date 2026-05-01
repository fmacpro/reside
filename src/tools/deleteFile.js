import { existsSync, statSync, rmSync, unlinkSync } from 'node:fs';

/**
 * Delete a file or directory.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createDeleteFileHandler(engine) {
  return async ({ path }) => {
    if (!path) return { success: false, error: 'Missing required argument: path' };
    const fullPath = engine._resolvePath(path);
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
  };
}
