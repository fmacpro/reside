import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * List files and directories in a path.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createListFilesHandler(engine) {
  return async ({ path = '.' }) => {
    const fullPath = engine._resolvePath(path);
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
  };
}
