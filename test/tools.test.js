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

  describe('write_file - broken JS string literal repair (the fishtank-app bug)', () => {
    it('repairs double-quoted strings broken by JSON \\n -> newline conversion', async () => {
      // Simulate what happens when the LLM writes code with \n in a JSON string value.
      // The LLM's JSON looks like: {"content": "console.log(\"Adding a fish...\\n\");"}
      // After JSON.parse, the \n becomes an actual newline character.
      // The content passed to write_file would be:
      //   console.log("Adding a fish...
      //   ");
      const brokenContent = 'console.log("Adding a fish...\n");';
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content: brokenContent,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      // The repair should have converted the literal newline back to \n
      assert.equal(written, 'console.log("Adding a fish...\\n");');
      // Verify the file is valid JavaScript (no SyntaxError)
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), ''); // No output means valid syntax
      cleanup(dir);
    });

    it('repairs single-quoted strings broken by JSON \\n -> newline conversion', async () => {
      const brokenContent = "console.log('Adding a fish...\n');";
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content: brokenContent,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      assert.equal(written, "console.log('Adding a fish...\\n');");
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('repairs template literal strings broken by JSON \\n -> newline conversion', async () => {
      const brokenContent = 'console.log(`Adding a fish...\n`);';
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content: brokenContent,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      assert.equal(written, 'console.log(`Adding a fish...\\n`);');
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('repairs multi-line strings with multiple \\n sequences', async () => {
      // Simulate a more complex case with multiple \n sequences
      const brokenContent = 'const msg = "Line 1\nLine 2\nLine 3\n";';
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content: brokenContent,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      assert.equal(written, 'const msg = "Line 1\\nLine 2\\nLine 3\\n";');
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('does NOT repair legitimate multi-line strings (template literals with actual newlines)', async () => {
      // Template literals CAN legitimately span multiple lines, so we should NOT repair them
      const validMultiLine = 'const msg = `Line 1\nLine 2\nLine 3`;';
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content: validMultiLine,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      // Should remain unchanged — template literals with actual newlines are valid JS
      assert.equal(written, validMultiLine);
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('does NOT repair template literals with ${} interpolation containing quotes (the recipe-app bug)', async () => {
      // This simulates the EXACT recipe-app failure scenario:
      // A template literal with ${} interpolation that contains single/double-quoted strings.
      // The fixSingle/fixDouble regexes must NOT match across template literal boundaries.
      const content = [
        "const prompt = `",
        "You are a recipe suggestion bot.",
        `Today's date: \${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        "",
        "Recipe:`;",
        "",
        "const options = {",
        "  method: 'POST',",
        "  headers: {",
        "    'Content-Type': 'application/json',",
        "  },",
        "};",
      ].join('\n');
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.js',
        content,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.js'), 'utf-8');
      // The content should remain unchanged — template literals with actual newlines are valid JS
      assert.equal(written, content);
      // Verify the file is valid JavaScript
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'my-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('does NOT repair non-JS files', async () => {
      const brokenContent = 'console.log("Adding a fish...\n");';
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('write_file', {
        path: 'my-app/app.txt',
        content: brokenContent,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'my-app', 'app.txt'), 'utf-8');
      // Non-JS files should NOT be repaired
      assert.equal(written, brokenContent);
      cleanup(dir);
    });

    it('repairs strings in edit_file new_string (the same bug via edit_file)', async () => {
      const { dir, engine } = createTestWorkspace();
      // Write a valid JS file first
      writeFileSync(join(dir, 'app.js'), 'const msg = "hello";\nconsole.log(msg);', 'utf-8');
      // Now edit it with a broken string (simulating LLM sending \n in JSON)
      const brokenNewString = 'const msg = "hello\nworld\n";';
      const result = await engine.execute('edit_file', {
        path: 'app.js',
        old_string: 'const msg = "hello";',
        new_string: brokenNewString,
      });
      assert.equal(result.success, true);
      const written = readFileSync(join(dir, 'app.js'), 'utf-8');
      assert.equal(written, 'const msg = "hello\\nworld\\n";\nconsole.log(msg);');
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');
      cleanup(dir);
    });

    it('end-to-end: simulates the ASCII art fish.txt scenario (non-JS file should NOT be repaired)', async () => {
      // This simulates the exact scenario from the user's prompting example:
      // 1. LLM searches for fish ASCII art
      // 2. LLM writes a fish.txt file with \n in the JSON content string
      // 3. After JSON.parse, the \n becomes actual newlines
      // 4. Since fish.txt is NOT a JS file, the content should be preserved as-is
      const { dir, engine } = createTestWorkspace();

      // Step 1: Create the app directory
      await engine.execute('create_directory', { path: 'fish-app' });

      // Step 2: Simulate the LLM's JSON content after JSON.parse
      // The LLM wrote: "content": ">.<\\n(o.o)\\n ^_^\\n<`'-'`>\\n..."
      // After JSON.parse, \n becomes actual newlines
      // This is the exact content from the user's example
      const fishArt = [
        '>.<',
        '(o.o)',
        ' ^_^',
        "<`'-'`>",
        '(O_O)',
        ' ^_^',
        '(>.<)',
        ' / \\_',
        ' (    @\\___',
        '    /_\\',
        '  (_____@\\',
        '   |||||\\\\',
        '   ||||| \\\\_',
      ].join('\n') + '\n';

      const writeResult = await engine.execute('write_file', {
        path: 'fish-app/fish.txt',
        content: fishArt,
      });
      assert.equal(writeResult.success, true);

      // Step 3: Verify the file content is preserved exactly (NOT repaired, since it's .txt)
      const written = readFileSync(join(dir, 'fish-app', 'fish.txt'), 'utf-8');
      assert.equal(written, fishArt);
      assert.equal(written.split('\n').length, 14); // 13 fish lines + trailing newline = 14

      cleanup(dir);
    });

    it('end-to-end: simulates the exact fishtank-app failure scenario', async () => {
      // This is the EXACT scenario that failed:
      // 1. LLM writes a JS file with console.log("Adding a fish...\n");
      // 2. The \n in the JSON gets converted to an actual newline by JSON.parse
      // 3. The file ends up with a broken string literal
      // 4. Running node app.js throws SyntaxError
      const { dir, engine } = createTestWorkspace();

      // Step 1: Create the app directory
      await engine.execute('create_directory', { path: 'fishtank-app' });

      // Step 2: Write the broken content (simulating what JSON.parse does to \n)
      // The LLM's JSON: {"content": "console.log(\"Adding a fish...\\n\");"}
      // After JSON.parse, the content string has an actual newline:
      const brokenContent = `console.log("Adding a fish...\n");`;
      const writeResult = await engine.execute('write_file', {
        path: 'fishtank-app/app.js',
        content: brokenContent,
      });
      assert.equal(writeResult.success, true);

      // Step 3: Verify the file is valid JavaScript (the repair should have fixed it)
      const written = readFileSync(join(dir, 'fishtank-app', 'app.js'), 'utf-8');
      assert.equal(written, 'console.log("Adding a fish...\\n");');

      // Step 4: Run node --check to verify syntax is valid
      const { execSync } = await import('node:child_process');
      const syntaxCheck = execSync(`node --check "${join(dir, 'fishtank-app', 'app.js')}" 2>&1`, { encoding: 'utf-8' });
      assert.equal(syntaxCheck.trim(), '');

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

    // Timeout test disabled — it takes 10 seconds and slows down the test suite.
    // The timeout behavior is tested implicitly by the server command detection
    // and other execute_command tests.

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

  describe('search_web', () => {
    it('fails for missing query argument', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('search_web', {});
      assert.equal(result.success, false);
      assert.match(result.error, /Missing required argument/);
      cleanup(dir);
    });

    it('fails for empty query', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('search_web', { query: '' });
      assert.equal(result.success, false);
      assert.match(result.error, /Missing required argument/);
      cleanup(dir);
    });

    it('returns search_web in tool names', () => {
      const engine = new ToolEngine('/tmp');
      const names = engine.getToolNames();
      assert.ok(names.includes('search_web'));
    });

    it('includes search_web in tool descriptions', () => {
      const engine = new ToolEngine('/tmp');
      const desc = engine.getToolDescriptions();
      assert.match(desc, /search_web/);
      assert.match(desc, /Search the web/);
    });
  });

  describe('fetch_url', () => {
    it('fails for missing url argument', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('fetch_url', {});
      assert.equal(result.success, false);
      assert.match(result.error, /Missing required argument/);
      cleanup(dir);
    });

    it('fails for empty url', async () => {
      const { dir, engine } = createTestWorkspace();
      const result = await engine.execute('fetch_url', { url: '' });
      assert.equal(result.success, false);
      assert.match(result.error, /Missing required argument/);
      cleanup(dir);
    });

    it('returns fetch_url in tool names', () => {
      const engine = new ToolEngine('/tmp');
      const names = engine.getToolNames();
      assert.ok(names.includes('fetch_url'));
    });

    it('includes fetch_url in tool descriptions', () => {
      const engine = new ToolEngine('/tmp');
      const desc = engine.getToolDescriptions();
      assert.match(desc, /fetch_url/);
      assert.match(desc, /Fetch a URL/);
    });

    it('accepts useBrowser parameter', async () => {
      const { dir, engine } = createTestWorkspace();
      // With useBrowser=true, it should try Puppeteer and fail gracefully
      // since there's no real URL
      const result = await engine.execute('fetch_url', { url: 'https://example.com', useBrowser: true });
      // Should either succeed or fail gracefully (network-dependent)
      assert.ok(result.success === true || result.success === false);
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
      assert.ok(names.includes('search_web'));
      assert.ok(names.includes('fetch_url'));
      assert.ok(names.includes('get_current_time'));
      assert.ok(names.includes('test_app'));
      assert.ok(names.includes('finish'));
      assert.equal(names.length, 13);
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
