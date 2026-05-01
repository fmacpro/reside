/**
 * WorkspaceManager — manages the workdir and per-app git repositories.
 * The workdir is a container directory. Each app/project subdirectory
 * within it has its own independent git repository.
 *
 * @module tools/utils/workspace
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Manages the workdir and per-app git repositories.
 * The workdir is a container directory. Each app/project subdirectory
 * within it has its own independent git repository.
 */
export class WorkspaceManager {
  /**
   * @param {string} workdir - Absolute path to the workdir (container for apps)
   */
  constructor(workdir) {
    this.workdir = resolve(workdir);
  }

  /**
   * Initialize the workdir: ensure it exists.
   * Does NOT create a git repo at the workdir level.
   */
  init() {
    if (!existsSync(this.workdir)) {
      mkdirSync(this.workdir, { recursive: true });
    }
  }

  /**
   * Get the workdir path.
   * @returns {string}
   */
  getPath() {
    return this.workdir;
  }

  /**
   * List app/project directories in the workdir.
   * @returns {Array<{name: string, path: string, hasGit: boolean}>}
   */
  listApps() {
    if (!existsSync(this.workdir)) return [];

    return readdirSync(this.workdir)
      .filter(name => {
        const fullPath = join(this.workdir, name);
        try {
          return statSync(fullPath).isDirectory() && !name.startsWith('.');
        } catch {
          return false;
        }
      })
      .map(name => ({
        name,
        path: join(this.workdir, name),
        hasGit: existsSync(join(this.workdir, name, '.git')),
      }));
  }

  /**
   * Initialize a git repository in a specific app directory.
   * Creates the directory if it doesn't exist.
   * @param {string} appPath - Absolute path to the app directory
   */
  initAppGit(appPath) {
    try {
      execSync('git --version', { encoding: 'utf-8', stdio: 'pipe' });

      if (!existsSync(appPath)) {
        mkdirSync(appPath, { recursive: true });
      }

      if (!existsSync(join(appPath, '.git'))) {
        execSync('git init', { cwd: appPath, encoding: 'utf-8', stdio: 'pipe' });

        // Create .gitignore
        const gitignore = join(appPath, '.gitignore');
        if (!existsSync(gitignore)) {
          writeFileSync(gitignore, `node_modules/\n.env\n*.log\n`, 'utf-8');
        }

        // Initial commit
        execSync('git add -A && git commit -m "Initial commit" --allow-empty', {
          cwd: appPath,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      }
    } catch {
      // Git not available - proceed without it
    }
  }

  /**
   * Auto-commit all changes in a specific app directory.
   * Ensures .gitignore exists with node_modules/ before committing.
   * @param {string} appPath - Absolute path to the app directory
   * @param {string} message - Commit message
   * @returns {boolean} Whether commit was successful
   */
  autoCommit(appPath, message) {
    try {
      if (!existsSync(join(appPath, '.git'))) return false;

      // Ensure .gitignore exists with node_modules/ before staging anything.
      // This prevents accidentally committing node_modules/ if npm install
      // was run before git init or before .gitignore was created.
      const gitignorePath = join(appPath, '.gitignore');
      if (existsSync(gitignorePath)) {
        const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
        if (!gitignoreContent.includes('node_modules/')) {
          writeFileSync(gitignorePath, gitignoreContent + '\nnode_modules/\n', 'utf-8');
        }
      } else {
        writeFileSync(gitignorePath, 'node_modules/\n.env\n*.log\n', 'utf-8');
      }

      execSync('git add -A', { cwd: appPath, encoding: 'utf-8', stdio: 'pipe' });

      const status = execSync('git status --porcelain', { cwd: appPath, encoding: 'utf-8' }).trim();
      if (!status) return true; // Nothing to commit

      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: appPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get git log for a specific app directory.
   * @param {string} appPath - Absolute path to the app directory
   * @param {number} [limit=10]
   * @returns {string}
   */
  getGitLog(appPath, limit = 10) {
    try {
      if (!existsSync(join(appPath, '.git'))) return '(no git repository)';
      return execSync(`git log --oneline -${limit}`, {
        cwd: appPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return '(no git history)';
    }
  }

  /**
   * Determine which app directory a given path belongs to.
   * Walks up from the path to find the nearest app directory.
   * @param {string} targetPath - Absolute path within the workdir
   * @returns {string|null} The app directory path, or null if not inside an app
   */
  resolveAppDir(targetPath) {
    const rel = resolve(targetPath);
    if (!rel.startsWith(this.workdir)) return null;

    // Walk up from the target path to find the first directory that has .git
    let current = rel;
    while (current.startsWith(this.workdir) && current !== this.workdir) {
      if (existsSync(join(current, '.git'))) {
        return current;
      }
      current = join(current, '..');
    }
    return null;
  }

  /**
   * Find all app directories that have been modified (have uncommitted changes).
   * @returns {string[]} Array of app directory paths with changes
   */
  findDirtyApps() {
    const apps = this.listApps();
    const dirty = [];

    for (const app of apps) {
      if (!app.hasGit) continue;
      try {
        const status = execSync('git status --porcelain', {
          cwd: app.path,
          encoding: 'utf-8',
        }).trim();
        if (status) {
          dirty.push(app.path);
        }
      } catch {
        // skip
      }
    }

    return dirty;
  }
}
