import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Search for patterns in files using regex.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createSearchFilesHandler(engine) {
  return async ({ path = '.', regex, file_pattern }) => {
    if (!regex) return { success: false, error: 'Missing required argument: regex' };

    const fullPath = engine._resolvePath(path);
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
  };
}
