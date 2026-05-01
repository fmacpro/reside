import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolvePath } from './utils/resolvePath.js';
import { findBestMatch } from './utils/findBestMatch.js';
import { repairStringLiterals } from './utils/stringRepair.js';

/**
 * Edit an existing file by replacing text.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createEditFileHandler(engine) {
  return async ({ path, file_path, new_string }) => {
    // Accept both 'path' and 'file_path' argument names.
    const effectivePath = path || file_path;
    if (!effectivePath) return { success: false, error: 'Missing required argument: path' };
    if (new_string === undefined) return { success: false, error: 'Missing required argument: new_string' };

    const fullPath = resolvePath(engine.workspaceDir, effectivePath);
    if (!existsSync(fullPath)) {
      return { success: false, error: `File not found: ${effectivePath}` };
    }

    const content = readFileSync(fullPath, 'utf-8');

    // Use diff-based matching to find the section to replace.
    const match = findBestMatch(content, new_string);
    if (!match) {
      return {
        success: false,
        error: `Could not find a matching section in ${effectivePath}. Make sure the new code includes enough context (e.g., the function signature) for the tool to locate it.`,
      };
    }

    const idx = match.startChar;
    const sliceEnd = match.endChar;

    // Fix broken string literals in the new content (same as write_file)
    let fixedNewString = repairStringLiterals(String(new_string), effectivePath, { debugMode: engine.config.debugMode === true });

    const newContent = content.slice(0, idx) + fixedNewString + content.slice(sliceEnd);

    // Detect no-op edits
    if (newContent === content) {
      return {
        success: false,
        error: `The edit_file() call did NOT change anything in ${effectivePath} — the new content is identical to the existing content. This usually means you provided the same code that already exists. Use write_file() to rewrite the ENTIRE file with the corrected code instead. First use read_file() to see the current content, then call write_file() with the complete corrected file content.`,
      };
    }

    writeFileSync(fullPath, newContent, 'utf-8');

    const startLine = content.slice(0, idx).split('\n').length;
    const endLine = content.slice(0, sliceEnd).split('\n').length;
    return {
      success: true,
      output: `Edited ${effectivePath} (lines ${startLine}-${endLine}): replaced with "${fixedNewString.substring(0, 50)}..."`,
      data: { path: effectivePath, replaced: sliceEnd - idx, bytes: newContent.length },
    };
  };
}
