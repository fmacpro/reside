import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { ToolEngine } from '../src/tools.js';

/**
 * Helper: create a temp workspace for testing.
 */
function createTestWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reside-test-'));
  return { dir, engine: new ToolEngine(dir) };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('ToolEngine', () => {
  describe('read_file', () => {
    it('reads an existing file', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'test.txt'), 'hello world', 'utf-8');
      const result = await engine.execute('read_file', { path: 'test.txt' });
      assert.equal(result.success, true);
      assert.equal(result.output, 'hello world');
      assert.equal(result.data.content, 'hello world');
      cleanup(dir);
    });

    it('fails for non-existent file', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('read_file', { path: 'nope.txt' });
      assert.equal(result.success, false);
      assert.match(result.error, /not found/);
      cleanup(dir);
    });

    it('fails for missing path argument', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('read_file', {});
      assert.equal(result.success, false);
      assert.match(result.error, /Missing/);
      cleanup(dir);
    });

    it('blocks path traversal', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('read_file', { path: '../etc/passwd' });
      assert.equal(result.success, false);
      assert.match(result.error, /outside the workspace/);
      cleanup(dir);
    });
  });

  describe('write_file', () => {
    it('writes a new file inside an app subdirectory', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: 'my-app/hello.txt', content: 'Hello!' });
      assert.equal(result.success, true);
      assert.match(result.output, /Written/);
      assert.equal(readFileSync(join(dir, 'my-app', 'hello.txt'), 'utf-8'), 'Hello!');
      cleanup(dir);
    });

    it('creates parent directories inside an app subdirectory', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: 'my-app/a/b/c/deep.txt', content: 'deep' });
      assert.equal(result.success, true);
      assert.equal(readFileSync(join(dir, 'my-app', 'a/b/c/deep.txt'), 'utf-8'), 'deep');
      cleanup(dir);
    });

    it('fails for missing path', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { content: 'x' });
      assert.equal(result.success, false);
      cleanup(dir);
    });

    it('fails for missing content', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: 'x.txt' });
      assert.equal(result.success, false);
      cleanup(dir);
    });
  });

  describe('write_file - root-level protection', () => {
    it('rejects writing directly to workdir root', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: 'app.js', content: 'x' });
      assert.equal(result.success, false);
      assert.match(result.error, /Cannot write files directly in the workdir root/);
      cleanup(dir);
    });

    it('allows writing inside an app subdirectory', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: 'my-app/app.js', content: 'x' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, 'my-app', 'app.js')), true);
      cleanup(dir);
    });

    it('allows hidden files at root (e.g., .gitkeep)', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', { path: '.gitkeep', content: '' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, '.gitkeep')), true);
      cleanup(dir);
    });
  });

  describe('edit_file', () => {
    it('replaces text in a file', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'app.js'), 'const x = 1;\nconsole.log(x);', 'utf-8');
      const result = await engine.execute('edit_file', {
        path: 'app.js',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      });
      assert.equal(result.success, true);
      assert.match(result.output, /Edited/);
      assert.equal(readFileSync(join(dir, 'app.js'), 'utf-8'), 'const x = 42;\nconsole.log(x);');
      cleanup(dir);
    });

    it('fails if old_string not found', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'app.js'), 'const x = 1;', 'utf-8');
      const result = await engine.execute('edit_file', {
        path: 'app.js',
        old_string: 'const y = 2;',
        new_string: 'const z = 3;',
      });
      assert.equal(result.success, false);
      assert.match(result.error, /Could not find/);
      cleanup(dir);
    });

    it('fails for non-existent file', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('edit_file', {
        path: 'missing.js',
        old_string: 'a',
        new_string: 'b',
      });
      assert.equal(result.success, false);
      cleanup(dir);
    });
  });

  describe('list_files', () => {
    it('lists files in a directory', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'a.txt'), 'a', 'utf-8');
      writeFileSync(join(dir, 'b.txt'), 'b', 'utf-8');
      mkdirSync(join(dir, 'sub'));
      const result = await engine.execute('list_files', { path: '.' });
      assert.equal(result.success, true);
      assert.match(result.output, /a\.txt/);
      assert.match(result.output, /b\.txt/);
      assert.match(result.output, /sub/);
      cleanup(dir);
    });

    it('returns empty for empty directory', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('list_files', { path: '.' });
      assert.equal(result.success, true);
      assert.match(result.output, /empty/);
      cleanup(dir);
    });
  });

  describe('create_directory', () => {
    it('creates a directory', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('create_directory', { path: 'my-app' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, 'my-app')), true);
      cleanup(dir);
    });

    it('creates nested directories', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('create_directory', { path: 'a/b/c' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, 'a/b/c')), true);
      cleanup(dir);
    });

    it('fails for missing path', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('create_directory', {});
      assert.equal(result.success, false);
      cleanup(dir);
    });
  });

  describe('delete_file', () => {
    it('deletes a file', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'temp.txt'), 'temp', 'utf-8');
      const result = await engine.execute('delete_file', { path: 'temp.txt' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, 'temp.txt')), false);
      cleanup(dir);
    });

    it('deletes a directory', async () => {
      const { dir, engine } = createTestWorkspace();
      mkdirSync(join(dir, 'tempdir'));
      writeFileSync(join(dir, 'tempdir/f.txt'), 'f', 'utf-8');
      const result = await engine.execute('delete_file', { path: 'tempdir' });
      assert.equal(result.success, true);
      assert.equal(existsSync(join(dir, 'tempdir')), false);
      cleanup(dir);
    });
  });

  describe('search_files', () => {
    it('finds matching patterns', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'app.js'), 'const port = 3000;', 'utf-8');
      writeFileSync(join(dir, 'other.txt'), 'no match here', 'utf-8');
      const result = await engine.execute('search_files', { path: '.', regex: 'port' });
      assert.equal(result.success, true);
      assert.match(result.output, /port/);
      cleanup(dir);
    });

    it('returns no matches when pattern not found', async () => {
      const { dir, engine } = createTestWorkspace();
      writeFileSync(join(dir, 'app.js'), 'hello', 'utf-8');
      const result = await engine.execute('search_files', { path: '.', regex: 'zzzz' });
      assert.equal(result.success, true);
      assert.match(result.output, /No matches/);
      cleanup(dir);
    });
  });

  describe('execute_command', () => {
    it('runs a command and returns output', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('execute_command', { command: 'echo "hello from test"' });
      assert.equal(result.success, true);
      assert.match(result.output, /hello from test/);
      cleanup(dir);
    });

    it('fails for missing command', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('execute_command', {});
      assert.equal(result.success, false);
      cleanup(dir);
    });

    it('blocks destructive commands', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('execute_command', { command: 'rm -rf /' });
      assert.equal(result.success, false);
      assert.match(result.error, /blocked/);
      cleanup(dir);
    });

    it('times out long-running commands gracefully', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('execute_command', { command: 'sleep 30' });
      assert.equal(result.success, true);
      assert.match(result.output, /timed out/);
      cleanup(dir);
    });

    it('runs command in specified cwd directory', async () => {
      const { dir, engine } = createTestWorkspace();
      mkdirSync(join(dir, 'my-app'));
      writeFileSync(join(dir, 'my-app', 'test.txt'), 'hello', 'utf-8');
      const result = await engine.execute('execute_command', {
        command: 'cat test.txt',
        cwd: 'my-app',
      });
      assert.equal(result.success, true);
      assert.equal(result.output, 'hello');
      cleanup(dir);
    });

    it('fails if cwd directory does not exist', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('execute_command', {
        command: 'pwd',
        cwd: 'nonexistent-app',
      });
      assert.equal(result.success, false);
      assert.match(result.error, /not found/);
      cleanup(dir);
    });
  });

  describe('finish', () => {
    it('returns success with message', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('finish', { message: 'Task done' });
      assert.equal(result.success, true);
      assert.equal(result.output, 'Task done');
      cleanup(dir);
    });

    it('uses default message', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('finish', {});
      assert.equal(result.success, true);
      assert.equal(result.output, 'Task completed');
      cleanup(dir);
    });
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('nonexistent_tool', {});
      assert.equal(result.success, false);
      assert.match(result.error, /Unknown tool/);
      cleanup(dir);
    });
  });

  describe('getToolNames', () => {
    it('returns all tool names', () => {
      const engine = new ToolEngine('/tmp');
      const names = engine.getToolNames();
      assert.ok(names.includes('read_file'));
      assert.ok(names.includes('write_file'));
      assert.ok(names.includes('edit_file'));
      assert.ok(names.includes('list_files'));
      assert.ok(names.includes('search_files'));
      assert.ok(names.includes('create_directory'));
      assert.ok(names.includes('execute_command'));
      assert.ok(names.includes('delete_file'));
      assert.ok(names.includes('finish'));
      assert.equal(names.length, 9);
    });
  });

  describe('getToolDescriptions', () => {
    it('returns descriptions for all tools', () => {
      const engine = new ToolEngine('/tmp');
      const desc = engine.getToolDescriptions();
      assert.match(desc, /read_file/);
      assert.match(desc, /write_file/);
      assert.match(desc, /finish/);
      assert.match(desc, /create_directory/);
    });
  });
});
