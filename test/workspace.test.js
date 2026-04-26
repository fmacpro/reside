import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { WorkspaceManager } from '../src/workspace.js';

function createTestWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'reside-ws-test-'));
  return { dir, wm: new WorkspaceManager(dir) };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('WorkspaceManager', () => {
  describe('init', () => {
    it('creates the workdir if it does not exist', () => {
      const { dir, wm } = createTestWorkdir();
      rmSync(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false);
      wm.init();
      assert.equal(existsSync(dir), true);
      cleanup(dir);
    });

    it('does not create a .git at the workdir root', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      assert.equal(existsSync(join(dir, '.git')), false);
      cleanup(dir);
    });
  });

  describe('getPath', () => {
    it('returns the resolved workdir path', () => {
      const { dir, wm } = createTestWorkdir();
      assert.equal(wm.getPath(), dir);
      cleanup(dir);
    });
  });

  describe('initAppGit', () => {
    it('initializes git in an app directory', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      assert.equal(existsSync(join(appPath, '.git')), true);
      assert.equal(existsSync(join(appPath, '.gitignore')), true);
      cleanup(dir);
    });

    it('creates the app directory if needed', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'new-app');
      assert.equal(existsSync(appPath), false);
      wm.initAppGit(appPath);
      assert.equal(existsSync(appPath), true);
      assert.equal(existsSync(join(appPath, '.git')), true);
      cleanup(dir);
    });

    it('does not re-init if git already exists', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      const gitDirStat1 = existsSync(join(appPath, '.git'));
      wm.initAppGit(appPath); // second call
      assert.equal(existsSync(join(appPath, '.git')), true);
      cleanup(dir);
    });
  });

  describe('listApps', () => {
    it('returns empty array for empty workdir', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      assert.deepEqual(wm.listApps(), []);
      cleanup(dir);
    });

    it('lists app directories', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      mkdirSync(join(dir, 'app1'));
      mkdirSync(join(dir, 'app2'));
      const apps = wm.listApps();
      assert.equal(apps.length, 2);
      assert.ok(apps.some(a => a.name === 'app1'));
      assert.ok(apps.some(a => a.name === 'app2'));
      cleanup(dir);
    });

    it('excludes hidden directories', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      mkdirSync(join(dir, '.hidden'));
      mkdirSync(join(dir, 'visible'));
      const apps = wm.listApps();
      assert.equal(apps.length, 1);
      assert.equal(apps[0].name, 'visible');
      cleanup(dir);
    });

    it('reports hasGit correctly', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      mkdirSync(join(dir, 'with-git'));
      mkdirSync(join(dir, 'without-git'));
      wm.initAppGit(join(dir, 'with-git'));
      const apps = wm.listApps();
      const withGit = apps.find(a => a.name === 'with-git');
      const withoutGit = apps.find(a => a.name === 'without-git');
      assert.equal(withGit.hasGit, true);
      assert.equal(withoutGit.hasGit, false);
      cleanup(dir);
    });
  });

  describe('autoCommit', () => {
    it('commits changes in an app directory', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      writeFileSync(join(appPath, 'test.txt'), 'hello', 'utf-8');
      const result = wm.autoCommit(appPath, 'Add test.txt');
      assert.equal(result, true);
      cleanup(dir);
    });

    it('returns false if no git repo', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'no-git');
      mkdirSync(appPath);
      const result = wm.autoCommit(appPath, 'test');
      assert.equal(result, false);
      cleanup(dir);
    });
  });

  describe('getGitLog', () => {
    it('returns git log for an app', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      writeFileSync(join(appPath, 'f.txt'), 'data', 'utf-8');
      wm.autoCommit(appPath, 'Add f.txt');
      const log = wm.getGitLog(appPath);
      assert.match(log, /Add f\.txt/);
      cleanup(dir);
    });

    it('returns message for no git repo', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'no-git');
      mkdirSync(appPath);
      const log = wm.getGitLog(appPath);
      assert.equal(log, '(no git repository)');
      cleanup(dir);
    });
  });

  describe('resolveAppDir', () => {
    it('finds the app directory for a nested path', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      mkdirSync(join(appPath, 'src'));
      const resolved = wm.resolveAppDir(join(appPath, 'src', 'index.js'));
      assert.equal(resolved, appPath);
      cleanup(dir);
    });

    it('returns null for path outside workdir', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const resolved = wm.resolveAppDir('/tmp/some-file');
      assert.equal(resolved, null);
      cleanup(dir);
    });

    it('returns null for path in workdir root (no git)', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const resolved = wm.resolveAppDir(join(dir, 'some-file'));
      assert.equal(resolved, null);
      cleanup(dir);
    });
  });

  describe('findDirtyApps', () => {
    it('finds apps with uncommitted changes', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      writeFileSync(join(appPath, 'new.txt'), 'new', 'utf-8');
      const dirty = wm.findDirtyApps();
      assert.equal(dirty.length, 1);
      assert.equal(dirty[0], appPath);
      cleanup(dir);
    });

    it('returns empty if no dirty apps', () => {
      const { dir, wm } = createTestWorkdir();
      wm.init();
      const appPath = join(dir, 'my-app');
      wm.initAppGit(appPath);
      const dirty = wm.findDirtyApps();
      assert.equal(dirty.length, 0);
      cleanup(dir);
    });
  });
});
