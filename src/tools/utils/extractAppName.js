import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Extract the top-level app directory name from a path.
 * Returns null if the path is not inside an app subdirectory.
 * @param {string} workspaceDir - Absolute path to the workspace
 * @param {string} path - File path to extract app name from
 * @returns {string|null}
 */
export function extractAppName(workspaceDir, path) {
  if (!path) return null;
  // Remove leading ./ or /
  const normalized = path.replace(/^[./\\]+/, '');
  // Get the first path segment
  const firstSegment = normalized.split(/[/\\]/)[0];
  // Must be a non-hidden, non-empty directory name
  if (!firstSegment || firstSegment.startsWith('.')) return null;
  // Verify it's actually a directory in the workspace
  const appPath = join(workspaceDir, firstSegment);
  if (existsSync(appPath) && statSync(appPath).isDirectory()) {
    return firstSegment;
  }
  return null;
}
