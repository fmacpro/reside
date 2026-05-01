import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { resolvePath } from './utils/resolvePath.js';

/**
 * Run a shell command.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createExecuteCommandHandler(engine) {
  return async ({ command, cwd }) => {
    if (!command) return { success: false, error: 'Missing required argument: command' };

    // Security: block destructive commands
    const blocked = ['rm -rf /', 'rm -rf ~', ':(){ :|:& };:', 'dd if=', 'mkfs', '> /dev/sda'];
    for (const pattern of blocked) {
      if (command.includes(pattern)) {
        return { success: false, error: 'Command blocked for security: contains dangerous pattern' };
      }
    }

    // Detect shell redirect syntax in command arguments
    const shellRedirectPattern = /<[a-zA-Z][a-zA-Z0-9_-]*>/;
    if (shellRedirectPattern.test(command)) {
      return {
        success: false,
        error: `The command "${command}" contains angle brackets like "<...>" which the shell interprets as file redirects. Replace "<placeholder>" with an actual value (e.g., a real city name like "London") instead of using placeholder syntax.`,
        data: { exitCode: null, stdout: '', stderr: '' },
      };
    }

    // Detect placeholder paths in command arguments
    const placeholderPathPatterns = [
      /path\/to\/your\//i,
      /path\/to\//i,
      /\/your[-_][a-z]+\.[a-z]+/i,
      /\/sample[-_][a-z]+\.[a-z]+/i,
      /\/example[-_][a-z]+\.[a-z]+/i,
      /\/test[-_][a-z]+\.[a-z]+/i,
      /\/input\.[a-z]+/i,
      /\/output\.[a-z]+/i,
      /\/data\.[a-z]+/i,
      /\/config\.[a-z]+/i,
    ];
    const hasPlaceholderPath = placeholderPathPatterns.some(p => p.test(command));
    if (hasPlaceholderPath) {
      return {
        success: false,
        error: `The command "${command}" contains a placeholder/generic file path (e.g., "path/to/your/file.json", "your-file.csv", "input.txt") that does not exist. You must use an actual file path that exists in the project. If the app needs a data file, create it first using write_file() with real data, then run the app with the actual filename. Do NOT use placeholder paths like "path/to/your/" or generic names like "input.txt" — use real file paths.`,
        data: { exitCode: null, stdout: '', stderr: '' },
      };
    }

    // Resolve working directory: use cwd if provided, otherwise workspace root.
    // If no cwd is provided but we have a current app context, auto-set cwd to that app.
    let effectiveCwd = cwd;
    if (!effectiveCwd && engine._currentApp) {
      effectiveCwd = engine._currentApp;
    }

    let workingDir = engine.workspaceDir;
    if (effectiveCwd) {
      workingDir = resolvePath(engine.workspaceDir, effectiveCwd);
      if (!existsSync(workingDir)) {
        return { success: false, error: `Directory not found: ${effectiveCwd}. Create it first with create_directory().` };
      }
    }

    // Detect and fix path doubling: when the LLM includes the app directory prefix
    // in the command (e.g., "node weather-cli/app.js" or "chmod +x weather-cli/app.js")
    // AND the cwd is already set to that app directory, the path becomes doubled
    // (e.g., workdir/weather-cli/weather-cli/app.js). Strip the app prefix from the
    // command to avoid this.
    if (effectiveCwd && !cwd) {
      const appName = effectiveCwd.replace(/\/+$/, '');
      const appPrefix = appName + '/';
      // Escape regex special characters in the app name
      const escapedName = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match the app name followed by '/' at the start of the command OR after a
      // word boundary (e.g., after a space following "node" or "chmod +x").
      // Also handle "./app-name/" prefix (e.g., "node ./weather-cli/app.js").
      // Use a negative lookahead after the app name (before the /) to ensure we
      // don't match partial app names (e.g., "my-app" should not match
      // "my-application/").
      const appPrefixPattern = new RegExp(`(?:^|\\b|\\./)${escapedName}(?![\\w-])/`);
      if (appPrefixPattern.test(command)) {
        const fixedCommand = command.replace(appPrefixPattern, '');
        if (fixedCommand !== command) {
          console.log(`   ⚠️ Detected path doubling in command — stripping app prefix "${appPrefix}"`);
          console.log(`      Original: ${command}`);
          console.log(`      Fixed:    ${fixedCommand}`);
          command = fixedCommand;
        }
      }
    }

    // Pre-execution check: detect web server / HTTP framework packages being installed
    const webFrameworkPackages = new Set([
      'express', 'http', 'https', 'koa', 'fastify', 'hapi', 'restify',
      'express-generator', 'express-handlebars', 'pug', 'ejs', 'mustache',
      'body-parser', 'cors', 'morgan', 'compression', 'cookie-parser',
      'express-session', 'passport', 'passport-local', 'helmet',
      'socket.io', 'ws', 'websocket',
    ]);
    const npmInstallMatch = command.trim().match(/^npm\s+install\s+(.+)$/);
    if (npmInstallMatch) {
      const packages = npmInstallMatch[1].split(/\s+/).filter(p => !p.startsWith('-') && !p.startsWith('@'));

      // Check if any of the requested packages are web framework packages.
      const webPackages = packages.filter(p => webFrameworkPackages.has(p));
      if (webPackages.length > 0) {
        const webPkgList = webPackages.map(p => `"${p}"`).join(', ');
        return {
          success: false,
          error: `You are installing web framework packages (${webPkgList}) but the user asked for a CLI/console app. Web frameworks like Express are for building HTTP servers, not CLI tools. Node.js has built-in modules for CLI apps:\n\n` +
            `• Use native \`fs\` and \`path\` modules for file I/O instead of external packages\n` +
            `• Use native \`child_process\` (execSync, spawnSync) for running system commands\n` +
            `• Use native \`os\` module for system information (CPU, memory, network interfaces)\n` +
            `• Use native \`readline\` or \`readline-sync\` for user input in CLI apps\n` +
            `• Use \`console.log\` / \`console.table\` for formatted output\n\n` +
            `Do NOT install web framework packages for a CLI app. Remove them from the install command and use native Node.js modules instead. If you need a package for CLI-specific features (e.g., chalk for colors, figlet for ASCII art), that's fine — but do NOT install web servers.`,
          data: { exitCode: null, stdout: '', stderr: '' },
        };
      }

      // Detect built-in Node.js modules being installed via npm.
      const builtInModules = new Set([
        'child_process', 'fs', 'path', 'os', 'http', 'https', 'url', 'util',
        'events', 'stream', 'buffer', 'crypto', 'assert', 'net', 'dns',
        'dgram', 'readline', 'tls', 'zlib', 'querystring', 'string_decoder',
        'timers', 'tty', 'punycode', 'process', 'console', 'module',
        'cluster', 'domain', 'vm', 'worker_threads', 'perf_hooks',
        'async_hooks', 'diagnostics_channel', 'trace_events',
        'inspector', 'wasi', 'test', 'node:test',
      ]);
      const builtInPackages = packages.filter(p => builtInModules.has(p));
      if (builtInPackages.length > 0) {
        const builtInPkgList = builtInPackages.map(p => `"${p}"`).join(', ');
        return {
          success: false,
          error: `You are trying to install built-in Node.js modules (${builtInPkgList}) via npm. These modules are already part of Node.js and do NOT need to be installed. Simply use \`import\` or \`require()\` to use them in your code:\n\n` +
            `• \`import { execSync } from "node:child_process";\` — no npm install needed\n` +
            `• \`import { readFileSync, writeFileSync } from "node:fs";\` — no npm install needed\n` +
            `• \`import { join, resolve } from "node:path";\` — no npm install needed\n` +
            `• \`import os from "node:os";\` — no npm install needed\n\n` +
            `Remove these packages from the install command. They are available natively in Node.js without any installation.`,
          data: { exitCode: null, stdout: '', stderr: '' },
        };
      }

      // Track valid and invalid packages for multi-package installs
      const validPackages = [];
      const invalidPackages = [];
      const esmOnlyPackages = [];

      // Determine if the project uses CommonJS (default) or ESM.
      let projectIsCjs = true;
      try {
        const pkgJsonPath = join(workingDir, 'package.json');
        if (existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          projectIsCjs = pkgJson.type !== 'module';
        }
      } catch {}

      for (const pkg of packages) {
        try {
          // Check if package exists and get its metadata
          const viewResult = execSync(`npm view "${pkg}" version description engines 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 5000,
            cwd: workingDir,
          });
          if (!viewResult.trim()) {
            invalidPackages.push(pkg);
            continue;
          }

          const lines = viewResult.trim().split('\n');
          const latestVersion = lines[0]?.trim() || 'unknown';
          const description = lines[1]?.trim() || '';
          const engines = lines.slice(2).join(' ').trim();

          // If the package has an engine requirement, check it
          if (engines && engines !== 'undefined' && engines !== '{}') {
            const nodeEngineMatch = engines.match(/["']node["']\s*:\s*["']([^"']+)["']/);
            if (nodeEngineMatch) {
              const nodeRequirement = nodeEngineMatch[1];
              const minVersion = nodeRequirement.replace(/[>=<^~ ]/g, '');
              const minMajor = parseInt(minVersion.split('.')[0], 10);
              if (!isNaN(minMajor) && minMajor < 12) {
                invalidPackages.push(pkg);
                continue;
              }
            }
          }

          // Check if the package is ESM-only
          if (projectIsCjs) {
            try {
              const typeResult = execSync(`npm view "${pkg}" type 2>/dev/null`, {
                encoding: 'utf-8',
                timeout: 3000,
                cwd: workingDir,
              }).trim();

              if (typeResult === 'module') {
                let hasCjsExport = false;
                try {
                  const exportsResult = execSync(`npm view "${pkg}" exports --json 2>/dev/null`, {
                    encoding: 'utf-8',
                    timeout: 3000,
                    cwd: workingDir,
                  }).trim();

                  if (exportsResult && exportsResult !== 'undefined') {
                    const exports = JSON.parse(exportsResult);
                    const hasRequireCondition = (obj, isTopLevel = true) => {
                      if (typeof obj === 'string') {
                        return isTopLevel;
                      }
                      if (typeof obj !== 'object' || obj === null) return false;
                      const keys = Object.keys(obj);
                      if (keys.some(k => k.startsWith('.'))) {
                        return Object.values(obj).some(v => hasRequireCondition(v, false));
                      }
                      return 'require' in obj;
                    };
                    hasCjsExport = hasRequireCondition(exports);
                  }
                } catch {}

                if (!hasCjsExport) {
                  esmOnlyPackages.push(pkg);
                  continue;
                }
              }
            } catch {}
          }

          validPackages.push(pkg);
        } catch {
          invalidPackages.push(pkg);
        }
      }

      // Build error message for invalid packages
      let errorMsg = '';
      if (invalidPackages.length > 0) {
        if (invalidPackages.length === 1) {
          errorMsg = `Package "${invalidPackages[0]}" does not exist on the npm registry. Use search_npm_packages({"query":"<partial-name>"}) to search the npm registry directly. Do NOT use search_web() — the npm registry has its own search.`;
        } else {
          errorMsg = `Packages "${invalidPackages.join('", "')}" do not exist on the npm registry. Use search_npm_packages({"query":"<partial-name>"}) to search the npm registry directly. Do NOT use search_web() — the npm registry has its own search.`;
        }
      }

      // Build warning message for ESM-only packages
      let esmMsg = '';
      if (esmOnlyPackages.length > 0) {
        if (esmOnlyPackages.length === 1) {
          esmMsg = `Package "${esmOnlyPackages[0]}" is ESM-only (type: module) and does not provide a CommonJS export. It will NOT work with require() in a CommonJS project. To use it, either: (1) Use dynamic import: const { default: pkg } = await import("${esmOnlyPackages[0]}"); in your code, OR (2) Set "type": "module" in package.json and use import statements, OR (3) Install an older CJS-compatible version by specifying a version number, e.g.: npm install ${esmOnlyPackages[0]}@8.2.6 (replace with the actual version you want).`;
        } else {
          esmMsg = `Packages "${esmOnlyPackages.join('", "')}" are ESM-only (type: module) and do not provide CommonJS exports. They will NOT work with require() in a CommonJS project. To use them, either: (1) Use dynamic import: const pkg = await import("pkg-name"); in your code, OR (2) Set "type": "module" in package.json and use import statements, OR (3) Install older CJS-compatible versions by specifying a version number, e.g.: npm install ${esmOnlyPackages[0]}@8.2.6 (replace with the actual version you want).`;
        }
      }

      // Combine messages and return if there are any issues
      if (invalidPackages.length > 0 || esmOnlyPackages.length > 0) {
        let combinedMsg = [errorMsg, esmMsg].filter(Boolean).join('\n\n');

        if (validPackages.length > 0) {
          const validList = validPackages.map(p => `"${p}"`).join(', ');
          combinedMsg += `\n\nThe following packages ARE valid and can be installed: ${validList}. To install just the valid packages, run: npm install ${validPackages.join(' ')}`;
        }

        return {
          success: false,
          error: combinedMsg,
          data: { exitCode: null, stdout: '', stderr: '' },
        };
      }
    }

    // Pre-execution check: detect server-starting commands.
    const serverPatterns = [
      /^npm\s+start\s*$/i,
      /^npm\s+run\s+(dev|start|serve)/i,
      /^npx\s+(serve|http-server|live-server)/i,
    ];
    const isServerCommand = serverPatterns.some(p => p.test(command.trim()));
    if (isServerCommand) {
      return {
        success: false,
        error: `The command "${command}" starts a long-running server process, which cannot be managed interactively in this environment. Instead of running it, tell the user the exact command to run in their terminal. For example: "Run \`node app.js\` from the ${cwd ? cwd : 'app-name'} directory to start the app." Do NOT prefix the file path with the directory name — just say \`node app.js\` and mention the directory separately.`,
        data: { exitCode: null, stdout: '', stderr: '' },
      };
    }

    // Pre-execution check: detect animated CLI apps
    const runFileMatch = command.trim().match(/^(node|python3?|deno|bun)\s+(\S+\.\w+)\s*$/i);
    if (runFileMatch) {
      const runner = runFileMatch[1];
      const scriptFile = runFileMatch[2];
      const scriptPath = join(workingDir, scriptFile);

      if (existsSync(scriptPath)) {
        const scriptContent = readFileSync(scriptPath, 'utf-8');

        const animationPatterns = [
          /setTimeout\s*\([^,]+,\s*\d{1,4}\s*\)/,
          /setInterval\s*\([^,]+,\s*\d{1,4}\s*\)/,
          /requestAnimationFrame\s*\(/,
          /setTimeout\s*\(\s*\w+\s*,\s*\d{1,4}\s*\)/,
          /setInterval\s*\(\s*\w+\s*,\s*\d{1,4}\s*\)/,
        ];

        const hasAnimation = animationPatterns.some(p => p.test(scriptContent));
        if (hasAnimation) {
          const appDir = engine._currentApp || cwd || 'app-name';
          const strippedCommand = command.replace(/^(node|python3?|deno|bun)\s+\S+\/(\S+\.\w+)\s*$/i, '$1 $2');
          return {
            success: false,
            error: `The file "${scriptFile}" contains animation loops (setTimeout/setInterval) and will run indefinitely. This command cannot complete in this environment. Instead of running it, tell the user the exact command to run in their terminal. For example: "Run \`${strippedCommand}\` from the ${appDir} directory to start the app." Do NOT prefix the file path with the directory name — just say \`${strippedCommand}\` and mention the directory separately.`,
            data: { exitCode: null, stdout: '', stderr: '' },
          };
        }
      }
    }

    // For generic run commands (node app.js, python app.py, etc.), use a shorter timeout (5s)
    const runCommandPatterns = [
      /^node\s+\S+\.js\s*$/i,
      /^node\s+\S+\/\S+\.js\s*$/i,
      /^python3?\s+\S+\.py\s*$/i,
      /^python3?\s+\S+\/\S+\.py\s*$/i,
      /^deno\s+run\s+/i,
      /^bun\s+run\s+/i,
      /^bun\s+\S+\.(js|ts)\s*$/i,
      /^bun\s+\S+\/\S+\.(js|ts)\s*$/i,
    ];
    const isRunCommand = runCommandPatterns.some(p => p.test(command.trim()));

    // Pre-execution check: if no cwd was provided and the command is npm/node-related,
    // check if the user likely meant to run it inside an app directory.
    if (!cwd && workingDir === engine.workspaceDir) {
      const apps = readdirSync(engine.workspaceDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));
      if (apps.length > 0) {
        const needsAppDir = /^npm\s+(init|install|run|start|test)/.test(command.trim());
        if (needsAppDir) {
          const appNames = apps.map(a => `"${a.name}"`).join(', ');

          let suggestedApp = apps[0].name;
          let latestMtime = 0;
          for (const app of apps) {
            const appPath = join(engine.workspaceDir, app.name);
            try {
              const stat = statSync(appPath);
              if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                suggestedApp = app.name;
              }
            } catch {}
          }

          return {
            success: false,
            error: `Command "${command}" is running in the workdir root, but it should run inside an app directory. Available apps: ${appNames}. Use the cwd parameter, e.g.: execute_command({"command":"${command}","cwd":"${suggestedApp}"})`,
          };
        }
      }
    }

    // Use spawn for async execution with timeout.
    const commandTimeout = isRunCommand ? 5_000 : 10_000;

    return new Promise(resolve => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: workingDir,
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let resolved = false;

      const timeout = setTimeout(() => {
        timedOut = true;

        // Don't kill the process — it may be a long-running server.
        child.unref();

        const output = stdout.trim() || stderr.trim() || '(process started, still running)';
        resolved = true;

        // For run commands that timed out, determine if the issue is a missing cwd parameter
        if (isRunCommand) {
          const autoCwdResolved = !cwd && engine._currentApp;

          if (!autoCwdResolved && !cwd) {
            const fileRefMatch = command.match(/(?:node|python3?|deno|bun)\s+(\S+\.\w+)/);
            if (fileRefMatch) {
              const referencedFile = fileRefMatch[1];
              const apps = readdirSync(engine.workspaceDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('.'));
              let bestApp = null;
              let latestMtime = 0;
              for (const app of apps) {
                const appFilePath = join(engine.workspaceDir, app.name, referencedFile);
                if (existsSync(appFilePath)) {
                  try {
                    const stat = statSync(join(engine.workspaceDir, app.name));
                    if (stat.mtimeMs > latestMtime) {
                      latestMtime = stat.mtimeMs;
                      bestApp = app.name;
                    }
                  } catch {}
                }
              }
              if (bestApp) {
                resolve({
                  success: false,
                  error: `The command "${command}" timed out after 5s because it ran in the workdir root instead of inside the app directory.\n\n💡 Hint: The file "${referencedFile}" exists in the "${bestApp}/" directory. You likely forgot to set cwd="${bestApp}" in your execute_command call. Try: execute_command({"command":"${command}","cwd":"${bestApp}"})`,
                  data: { exitCode: null, timedOut: true, stdout, stderr },
                });
                return;
              }
            }
          }

          const appDir = engine._currentApp || cwd || 'app-name';
          const strippedCommand = command.replace(/^(node|python3?|deno|bun)\s+\S+\/(\S+\.\w+)\s*$/i, '$1 $2');

          const hasPrompt = /[?？:：]\s*$|(?:Enter|What|Which|Choose|Select|Type|Pick)\s/i.test(stdout.trim());

          if (hasPrompt) {
            resolve({
              success: false,
              error: `The command "${command}" is an interactive CLI that requires user input (timed out after 5s waiting for input). Instead of running it, tell the user the exact command to run in their terminal. For example: "Run \`${strippedCommand}\` from the ${appDir} directory and interact with the prompts." Do NOT prefix the file path with the directory name — just say \`${strippedCommand}\` and mention the directory separately.`,
              data: { exitCode: null, timedOut: true, background: true },
            });
          } else {
            resolve({
              success: false,
              error: `The command "${command}" appears to start a long-running process (timed out after 5s). Instead of running it, tell the user the exact command to run in their terminal. For example: "Run \`${strippedCommand}\` from the ${appDir} directory to start the app." Do NOT prefix the file path with the directory name — just say \`${strippedCommand}\` and mention the directory separately.`,
              data: { exitCode: null, timedOut: true, background: true },
            });
          }
        } else {
          resolve({
            success: true,
            output: `${output}\n\n⚠️ Command timed out after ${commandTimeout / 1000}s — the process is still running in the background. Use the URL/output above to access the server.`,
            data: { exitCode: null, timedOut: true, stdout, stderr, background: true },
          });
        }
      }, commandTimeout);

      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });

      child.on('close', code => {
        clearTimeout(timeout);

        if (resolved) return;

        if (code === 0) {
          // Post-execution verification
          let verificationNote = '';
          const isNpmInstall = /^npm\s+install/.test(command.trim());
          if (isNpmInstall) {
            const nodeModulesPath = join(workingDir, 'node_modules');
            if (!existsSync(nodeModulesPath)) {
              verificationNote = '\n\n⚠️ npm install reported success but node_modules/ was not found. Dependencies may not have been installed correctly.';
            } else {
              const pkgCount = readdirSync(nodeModulesPath).length;
              verificationNote = `\n\n✅ node_modules/ created with ${pkgCount} packages.`;
            }
          }

          // After npm init -y, auto-set "type": "module" in package.json
          const isNpmInit = /^npm\s+init\s+-y/.test(command.trim());
          if (isNpmInit) {
            const pkgJsonPath = join(workingDir, 'package.json');
            if (existsSync(pkgJsonPath)) {
              try {
                const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
                pkg.type = 'module';
                writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
                verificationNote += '\n\n✅ Set "type": "module" in package.json for ES module support. Use import/export syntax instead of require().';
              } catch {}
            }
          }

          resolved = true;
          resolve({
            success: true,
            output: (stdout.trim() || '(command completed with no output)') + verificationNote,
            data: { exitCode: 0, stdout, stderr },
          });
        } else {
          // Command failed — check if the issue is a missing cwd parameter.
          let cwdHint = '';
          if (!cwd) {
            const fileRefMatch = command.match(/(?:node|python3?|deno|bun)\s+(\S+\.\w+)/);
            if (fileRefMatch) {
              const referencedFile = fileRefMatch[1];
              const apps = readdirSync(engine.workspaceDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('.'));
              let bestApp = null;
              let latestMtime = 0;
              for (const app of apps) {
                const appFilePath = join(engine.workspaceDir, app.name, referencedFile);
                if (existsSync(appFilePath)) {
                  try {
                    const stat = statSync(join(engine.workspaceDir, app.name));
                    if (stat.mtimeMs > latestMtime) {
                      latestMtime = stat.mtimeMs;
                      bestApp = app.name;
                    }
                  } catch {}
                }
              }
              if (bestApp) {
                cwdHint = `\n\n💡 Hint: The file "${referencedFile}" exists in the "${bestApp}/" directory. You likely forgot to set cwd="${bestApp}" in your execute_command call. Try: execute_command({"command":"${command}","cwd":"${bestApp}"})`;
              }
            }
          }

          resolved = true;
          resolve({
            success: false,
            output: (stdout.trim() || stderr.trim() || `(exit code ${code})`) + cwdHint,
            error: (stderr.trim() || `Command failed with exit code ${code}`) + cwdHint,
            data: { exitCode: code, stdout, stderr },
          });
        }
      });

      child.on('error', err => {
        clearTimeout(timeout);
        if (resolved) return;
        resolved = true;
        resolve({
          success: false,
          error: `Failed to execute command: ${err.message}`,
          data: { exitCode: null, stdout, stderr },
        });
      });
    });
  };
}
