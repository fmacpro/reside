import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Test the application by running it and checking for errors.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createTestAppHandler(engine) {
  return async ({ args, cwd }) => {
    // Determine which app directory to test.
    // Priority: 1) cwd parameter (explicit), 2) _currentApp (auto-tracked), 3) scan workdir
    let appDir = cwd || engine._currentApp;
    if (!appDir) {
      const apps = readdirSync(engine.workspaceDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('node_modules'));
      if (apps.length === 0) {
        return { success: false, error: 'No app directory found. Create an app first with create_directory() and write source files with write_file().' };
      }
      if (apps.length === 1) {
        appDir = apps[0].name;
        // Set _currentApp so subsequent calls don't need to scan again
        engine._currentApp = appDir;
      } else {
        const appNames = apps.map(a => `"${a.name}"`).join(', ');
        return {
          success: false,
          error: `Multiple app directories found: ${appNames}. Please specify which app to test by using the cwd parameter, e.g.: test_app({"cwd":"<app-name>"}) or test_app({"args":"<app-args>","cwd":"<app-name>"})`,
        };
      }
    }

    const appPath = join(engine.workspaceDir, appDir);
    if (!existsSync(appPath)) {
      return { success: false, error: `App directory "${appDir}" does not exist.` };
    }

    // Look for common entry point files.
    // First check the app root directory, then check src/ subdirectory.
    const entryPoints = ['app.js', 'index.js', 'server.js', 'main.js', 'app.mjs', 'index.mjs', 'index.html'];
    let entryPoint = null;
    let entryPointInSrc = false; // Track if entry point is in src/ subdirectory
    for (const ep of entryPoints) {
      const epPath = join(appPath, ep);
      if (existsSync(epPath)) {
        entryPoint = ep;
        entryPointInSrc = false;
        break;
      }
    }

    // If not found at app root, check inside src/ subdirectory
    if (!entryPoint) {
      const srcPath = join(appPath, 'src');
      if (existsSync(srcPath)) {
        for (const ep of entryPoints) {
          const epPath = join(srcPath, ep);
          if (existsSync(epPath)) {
            entryPoint = ep;
            entryPointInSrc = true;
            break;
          }
        }
      }
    }

    if (!entryPoint) {
      return {
        success: false,
        error: `No entry point file found in "${appDir}/". Expected one of: ${entryPoints.join(', ')}.\n\n` +
          `You MUST create the entry point file using write_file(). The entry point is the main file that imports and calls the controllers/services. ` +
          `For example: write_file({"path":"${appDir}/app.js","content":"..."}) with the complete source code that imports from your controller/service modules ` +
          `and starts the application. Do NOT edit existing files — create the missing entry point file.`,
      };
    }

    // For HTML entry points, we can't run them with node — they're static files.
    if (entryPoint.endsWith('.html')) {
      return {
        success: true,
        output: `Static HTML file "${entryPoint}" found — no runtime test needed. Open this file in a browser to view the app.`,
        data: { appDir, entryPoint, static: true },
      };
    }

    // Build the command: node <entrypoint> [args]
    // If the entry point is in src/, prefix the path with src/
    const entryPointPath = entryPointInSrc ? `src/${entryPoint}` : entryPoint;
    const cmdArgs = args ? ` ${args}` : '';
    const command = `node ${entryPointPath}${cmdArgs}`;

    // If no args were provided, we'll also test with --help
    const helpCommand = args ? null : `node ${entryPointPath} --help`;

    // Run with a 5s timeout.
    return new Promise(resolve => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: appPath,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;
      let hasPipedExit = false;

      // After 1s, if the app is still running and has produced output,
      // it's likely an interactive app waiting for input. Pipe "exit\n" to stdin.
      const exitPipeTimeout = setTimeout(() => {
        if (!resolved && stdout.trim()) {
          hasPipedExit = true;
          child.stdin.write('exit\n');
          child.stdin.end();
        }
      }, 1000);

      const timeout = setTimeout(() => {
        clearTimeout(exitPipeTimeout);
        timedOut = true;
        child.kill();
        resolved = true;
        const output = stdout.trim() || stderr.trim() || '(no output)';

        if (stdout.trim()) {
          resolve({
            success: true,
            output: stdout.trim() + '\n\n⚠️ App is interactive (requires user input). Run it manually to interact with the prompts.',
            data: { exitCode: null, timedOut: true, interactive: true, stdout, stderr, appDir, entryPoint },
          });
        } else {
          resolve({
            success: false,
            error: `The app timed out after 5s and produced no output. This may indicate an infinite loop, a missing console.log, or the app is waiting for user input. Check the code and fix any issues.`,
            output,
            data: { exitCode: null, timedOut: true, stdout, stderr, appDir, entryPoint },
          });
        }
      }, 5000);

      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });

      child.on('close', code => {
        clearTimeout(timeout);
        clearTimeout(exitPipeTimeout);
        if (resolved) return;

        resolved = true;

        if (code === 0) {
          // If the initial test succeeded and we have a --help command to test,
          // run the --help test to catch apps that use commander or similar CLI argument parsing.
          if (helpCommand && !resolved) {
            const helpChild = spawn('/bin/sh', ['-c', helpCommand], {
              cwd: appPath,
              env: { ...process.env, PATH: process.env.PATH },
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
            });

            let helpStdout = '';
            let helpStderr = '';
            let helpTimedOut = false;
            let helpResolved = false;

            const helpTimeout = setTimeout(() => {
              helpTimedOut = true;
              helpChild.kill();
              helpResolved = true;
            }, 5000);

            helpChild.stdout.on('data', data => { helpStdout += data.toString(); });
            helpChild.stderr.on('data', data => { helpStderr += data.toString(); });

            helpChild.on('close', helpCode => {
              clearTimeout(helpTimeout);
              if (helpResolved) return;
              helpResolved = true;

              if (helpCode === 0) {
                resolve({
                  success: true,
                  output: (stdout.trim() || '(app ran successfully)') + '\n\n✅ --help test passed',
                  data: { exitCode: 0, stdout, stderr, appDir, entryPoint, helpTestPassed: true },
                });
              } else {
                const helpError = helpStderr.trim() || helpStdout.trim() || `--help test exited with code ${helpCode}`;
                resolve({
                  success: false,
                  error: `The app ran without arguments but FAILED with --help flag:\n\n${helpError}\n\nThis usually means the app uses commander or similar CLI argument parsing but has a bug in the command setup (e.g., missing imports, undefined functions in command handlers). Fix the code and retry.`,
                  output: helpError,
                  data: { exitCode: helpCode, stdout: helpStdout, stderr: helpStderr, appDir, entryPoint, helpTestFailed: true },
                });
              }
            });

            helpChild.on('error', () => {
              clearTimeout(helpTimeout);
              if (helpResolved) return;
              helpResolved = true;
              resolve({
                success: true,
                output: (stdout.trim() || '(app ran successfully)') + '\n\n⚠️ --help test could not be started',
                data: { exitCode: 0, stdout, stderr, appDir, entryPoint },
              });
            });
          } else {
            resolve({
              success: true,
              output: stdout.trim() || '(app ran successfully with no output)',
              data: { exitCode: 0, stdout, stderr, appDir, entryPoint },
            });
          }
        } else {
          const errorMsg = stderr.trim() || stdout.trim() || `App exited with code ${code}`;
          resolve({
            success: false,
            error: errorMsg,
            output: errorMsg,
            data: { exitCode: code, stdout, stderr, appDir, entryPoint },
          });
        }
      });

      child.on('error', err => {
        clearTimeout(timeout);
        clearTimeout(exitPipeTimeout);
        if (resolved) return;
        resolved = true;
        resolve({
          success: false,
          error: `Failed to run app: ${err.message}`,
          data: { exitCode: null, stdout, stderr, appDir, entryPoint },
        });
      });
    });
  };
}
