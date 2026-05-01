import { existsSync, readFileSync } from 'node:fs';

/**
 * Read the contents of a file.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createReadFileHandler(engine) {
  return async ({ path }) => {
    if (!path) return { success: false, error: 'Missing required argument: path' };
    const fullPath = engine._resolvePath(path);
    if (!existsSync(fullPath)) {
      return { success: false, error: `File not found: ${path}` };
    }
    const content = readFileSync(fullPath, 'utf-8');
    return {
      success: true,
      output: content,
      data: { path, content, size: content.length },
    };
  };
}
