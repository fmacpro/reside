import { resolve, relative, sep } from 'node:path';

/**
 * Validate that a path is within the workspace (security).
 * @param {string} workspaceDir - Absolute path to the workspace
 * @param {string} targetPath - Path to resolve (relative to workspace)
 * @returns {string} Resolved absolute path
 * @throws {Error} If path is outside the workspace
 */
export function resolvePath(workspaceDir, targetPath) {
  const resolved = resolve(workspaceDir, targetPath);
  const rel = relative(workspaceDir, resolved);
  if (rel.startsWith('..') || (sep === '\\' && /^[a-zA-Z]:\\/.test(rel) && !rel.startsWith(workspaceDir))) {
    throw new Error(`Path "${targetPath}" is outside the workspace`);
  }
  return resolved;
}
