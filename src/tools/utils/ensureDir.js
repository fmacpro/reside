import { existsSync, mkdirSync } from 'node:fs';

/**
 * Ensure a directory exists, creating it if necessary.
 * @param {string} dirPath - Path to the directory
 */
export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
