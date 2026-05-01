import { existsSync, writeFileSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { relative, sep, join } from 'node:path';
import { resolvePath } from './utils/resolvePath.js';
import { ensureDir } from './utils/ensureDir.js';
import { extractAppName } from './utils/extractAppName.js';
import { repairStringLiterals } from './utils/stringRepair.js';

/**
 * Write content to a file (creates directories if needed).
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createWriteFileHandler(engine) {
  return async ({ path, content }) => {
    if (!path) return { success: false, error: 'Missing required argument: path' };
    if (content === undefined || content === null) return { success: false, error: 'Missing required argument: content' };
    const fullPath = resolvePath(engine.workspaceDir, path);
    const rel = relative(engine.workspaceDir, fullPath);
    // Reject writing directly to the workdir root — files must be inside an app subdirectory.
    // Allow hidden files (starting with '.') for edge cases like .gitkeep.
    if (rel && !rel.includes(sep) && !rel.startsWith('.')) {
      return {
        success: false,
        error: `Cannot write files directly in the workdir root. Create an app directory first using create_directory(), then write files inside it (e.g., "my-app/${path}").`,
      };
    }

    // Detect when the LLM writes package.json using CommonJS module.exports syntax
    // instead of plain JSON. This happens when the LLM is confused about ESM vs CJS.
    const contentStr = String(content).trim();
    if (path.endsWith('package.json') && contentStr.startsWith('module.exports')) {
      return {
        success: false,
        error: `The content for "${path}" uses CommonJS "module.exports" syntax, but package.json must be plain JSON. Write the content as a valid JSON object, e.g.:\n{\n  "name": "my-app",\n  "version": "1.0.0",\n  "type": "module"\n}`,
      };
    }

    // Detect when the LLM writes package.json directly instead of using npm init -y.
    if (path.endsWith('package.json')) {
      let pkgObj;
      try {
        pkgObj = JSON.parse(contentStr);
      } catch {
        return {
          success: false,
          error: `The content for "${path}" is not valid JSON. Use execute_command({"command":"npm init -y","cwd":"<app-name>"}) to create package.json instead of writing it manually. The system will automatically set "type": "module" for ES module support.`,
        };
      }
      // If the LLM wrote package.json with "type": "commonjs", reject it and tell
      // the LLM to use npm init -y instead.
      if (pkgObj.type === 'commonjs') {
        return {
          success: false,
          error: `The package.json for "${path}" has "type": "commonjs" but your source code uses import/export syntax. Do NOT write package.json manually — use execute_command({"command":"npm init -y","cwd":"<app-name>"}) to create it. The system will automatically set "type": "module" for ES module support. If you need to add dependencies, use npm install <package> instead of editing package.json directly.`,
        };
      }
    }

    // Detect web framework imports in source files
    const webFrameworkImports = [
      /from\s+["']express["']/i,
      /from\s+["']koa["']/i,
      /from\s+["']fastify["']/i,
      /from\s+["']hapi["']/i,
      /from\s+["']restify["']/i,
      /require\s*\(\s*["']express["']\s*\)/i,
      /require\s*\(\s*["']koa["']\s*\)/i,
      /require\s*\(\s*["']fastify["']\s*\)/i,
      /require\s*\(\s*["']hapi["']\s*\)/i,
      /require\s*\(\s*["']restify["']\s*\)/i,
    ];
    const hasWebFrameworkImport = webFrameworkImports.some(p => p.test(contentStr));
    if (hasWebFrameworkImport && /\.(js|mjs|cjs|ts)$/i.test(path)) {
      return {
        success: false,
        error: `The file "${path}" imports a web framework (Express, Koa, Fastify, etc.) but this should be a CLI/console app. Web frameworks are for building HTTP servers, not CLI tools. Node.js has built-in modules for CLI apps:\n\n` +
          `• Use native \`fs\` and \`path\` modules for file I/O instead of external packages\n` +
          `• Use native \`child_process\` (execSync, spawnSync) for running system commands\n` +
          `• Use native \`os\` module for system information (CPU, memory, network interfaces)\n` +
          `• Use native \`readline\` or \`readline-sync\` for user input in CLI apps\n` +
          `• Use \`console.log\` / \`console.table\` for formatted output\n\n` +
          `Remove the web framework import and rewrite the file using native Node.js modules. If you need to fetch data from an API, use the native \`fetch\` API (available in Node.js 18+) or install a lightweight HTTP client like \`node-fetch\`.`,
      };
    }

    // Detect monolithic entry point files that should be split into controllers/services.
    const entryPointNames = new Set([
      'app.js', 'index.js', 'server.js', 'main.js',
      'app.ts', 'index.ts', 'server.ts', 'main.ts',
      'app.py', 'main.py',
      'app.rb', 'main.rb',
      'app.go', 'main.go',
      'app.rs', 'main.rs',
      'index.php',
      'app.mjs', 'index.mjs',
      'app.cjs', 'index.cjs',
    ]);
    const fileName = path.split('/').pop();
    const isEntryPoint = entryPointNames.has(fileName);
    const contentLines = contentStr.split('\n');
    const lineCount = contentLines.length;

    if (isEntryPoint && lineCount > 80) {
      const funcDefs = contentStr.match(/^(async\s+)?function\s+\w+\s*\(/gm);
      const funcCount = funcDefs ? funcDefs.length : 0;
      const arrowFuncs = contentStr.match(/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/gm);
      const arrowCount = arrowFuncs ? arrowFuncs.length : 0;
      const totalConcerns = funcCount + arrowCount;

      if (totalConcerns >= 3) {
        const appDir = path.split('/')[0];
        return {
          success: false,
          error: `The file "${path}" is a monolithic entry point (${lineCount} lines, ${totalConcerns} function definitions). It should be split into separate modules following the controller pattern:

1. Keep "${fileName}" thin — only imports, config, and the main execution flow (under ~50 lines).
2. Move business logic into controllers/ and services/ directories.
3. Create subdirectories first using create_directory(), then write the individual files.

For example, for a system info app:
  • create_directory("${appDir}/controllers") — for route handlers / menu option handlers
  • create_directory("${appDir}/services") — for business logic (CPU, GPU, memory queries)
  • create_directory("${appDir}/utils") — for helper functions (formatting, display)

Then write the files:
  • write_file("${appDir}/services/systemInfoService.js", ...) — CPU, GPU, memory query functions
  • write_file("${appDir}/controllers/menuController.js", ...) — menu display and option handling
  • write_file("${appDir}/app.js", ...) — thin entry point that imports and calls the controller

CRITICAL — When splitting code into multiple files, you MUST ensure:
  • Each module file exports ALL functions that other files need (use "export function" or "export const")
  • The entry point file imports ALL required functions from each module (use "import { ... } from")
  • Each file imports ALL Node.js built-in modules it uses (fs, path, os, etc.) — do NOT assume they are globally available
  • Do NOT forget to import functions in the entry point that are defined in controller/service files
  • After writing all files, use read_file() to verify the entry point has all necessary imports before calling test_app()

Do NOT write everything into a single file. Split the functionality into separate modules.`,
        };
      }
    }

    // Detect placeholder/stub content
    const placeholderPatterns = [
      /^\/\/\s*(your|todo|placeholder|insert|add|implement|write|put|fill)[^]*$/im,
      /^\/\*\s*(your|todo|placeholder|insert|add|implement|write|put|fill)[^]*\*\/$/im,
      /^#\s*(your|todo|placeholder|insert|add|implement|write|put|fill)/im,
      /^function\s+\w+\s*\(\s*\)\s*\{\s*\}\s*$/m,
      /^const\s+\w+\s*=\s*\(\s*\)\s*=>\s*\{\s*\}\s*$/m,
      /^class\s+\w+\s*\{\s*\}\s*$/m,
    ];
    const isPlaceholder = placeholderPatterns.some(p => p.test(contentStr));
    if (isPlaceholder && contentStr.length < 200) {
      return {
        success: false,
        error: `The content for "${path}" appears to be a placeholder/stub (${contentStr.length} bytes). You must write the COMPLETE implementation, not a placeholder. Delete this file first if needed, then write the full code.`,
      };
    }

    // Fix broken string literals
    let fixedContent = repairStringLiterals(String(content), path, { debugMode: engine.config.debugMode === true });

    // Detect: readFileSync/writeFileSync used without importing from node:fs.
    if (/\.(js|mjs|cjs|ts)$/i.test(path)) {
      const fsFuncPattern = /\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|unlinkSync|rmSync|appendFileSync|copyFileSync|renameSync|statSync|lstatSync|realpathSync|symlinkSync|truncateSync|chmodSync|chownSync|utimesSync|linkSync|mkdtempSync|opendirSync|readlinkSync|fstatSync|lchmodSync|lchownSync)\s*\(/;
      const fsImportPattern = /import\s*\{[^}]*\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|unlinkSync|rmSync|appendFileSync|copyFileSync|renameSync|statSync|lstatSync|realpathSync|symlinkSync|truncateSync|chmodSync|chownSync|utimesSync|linkSync|mkdtempSync|opendirSync|readlinkSync|fstatSync|lchmodSync|lchownSync)\b[^}]*\}\s*from\s*["']node:fs["']/;
      const fsImportAllPattern = /import\s+\*\s+as\s+\w+\s+from\s+["']node:fs["']/;
      const fsRequirePattern = /(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*["'](?:node:)?fs["']\s*\)/;
      const fsDestructureRequirePattern = /(?:const|let|var)\s*\{[^}]*\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|unlinkSync|rmSync|appendFileSync|copyFileSync|renameSync|statSync|lstatSync|realpathSync|symlinkSync|truncateSync|chmodSync|chownSync|utimesSync|linkSync|mkdtempSync|opendirSync|readlinkSync|fstatSync|lchmodSync|lchownSync)\b[^}]*\}\s*=\s*require\s*\(\s*["'](?:node:)?fs["']\s*\)/;

      const hasFsFuncUsage = fsFuncPattern.test(fixedContent);
      const hasFsImport = fsImportPattern.test(fixedContent) || fsImportAllPattern.test(fixedContent) || fsRequirePattern.test(fixedContent) || fsDestructureRequirePattern.test(fixedContent);

      if (hasFsFuncUsage && !hasFsImport) {
        const usedFuncs = new Set();
        let match;
        const funcRegex = /\b(readFileSync|writeFileSync|existsSync|mkdirSync|readdirSync|unlinkSync|rmSync|appendFileSync|copyFileSync|renameSync|statSync|lstatSync|realpathSync|symlinkSync|truncateSync|chmodSync|chownSync|utimesSync|linkSync|mkdtempSync|opendirSync|readlinkSync|fstatSync|lchmodSync|lchownSync)\s*\(/g;
        while ((match = funcRegex.exec(fixedContent)) !== null) {
          usedFuncs.add(match[1]);
        }
        const funcList = Array.from(usedFuncs).join(', ');
        return {
          success: false,
          error: `The file "${path}" uses fs functions (${funcList}) but does not import them from "node:fs". In ES modules, you MUST import these functions explicitly:\n\n` +
            `  import { ${funcList} } from "node:fs";\n\n` +
            `Add the import statement at the top of the file and retry. Do NOT use require("fs") — that is CommonJS syntax and does NOT work in ES modules.`,
        };
      }

      // Detect: __dirname used in ES modules (.js, .mjs files) without importing
      if (/\.(js|mjs)$/i.test(path)) {
        const hasDirnameUsage = /\b__dirname\b/.test(fixedContent);
        const hasFileURLToPathImport = /import\s*\{[^}]*\bfileURLToPath\b[^}]*\}\s*from\s*["']node:url["']/;
        const hasDirnameImport = /import\s*\{[^}]*\bdirname\b[^}]*\}\s*from\s*["']node:path["']/;
        const hasImportMetaUrl = /import\.meta\.url/.test(fixedContent);

        if (hasDirnameUsage && !(hasFileURLToPathImport.test(fixedContent) && hasDirnameImport.test(fixedContent) && hasImportMetaUrl)) {
          return {
            success: false,
            error: `The file "${path}" uses __dirname but this is an ES module (.js file with "type": "module" in package.json). In ES modules, __dirname is NOT available — it is a CommonJS global.\n\n` +
              `To fix this, add the following imports at the top of the file:\n\n` +
              `  import { fileURLToPath } from "node:url";\n` +
              `  import { dirname } from "node:path";\n\n` +
              `Then replace __dirname with:\n\n` +
              `  const __filename = fileURLToPath(import.meta.url);\n` +
              `  const __dirname = dirname(__filename);\n\n` +
              `Or better, use path.resolve(fileURLToPath(import.meta.url), "relative/path") directly without defining __dirname.\n\n` +
              `Do NOT change the file extension to .cjs — .cjs files use CommonJS (require/module.exports), not ESM (import/export). ` +
              `The correct fix is to use import.meta.url in the existing .js file.`,
          };
        }
      }
    }

    ensureDir(join(fullPath, '..'));
    writeFileSync(fullPath, fixedContent, 'utf-8');

    // Verify the file was actually written
    if (!existsSync(fullPath)) {
      return {
        success: false,
        error: `File was not created at ${path} — write operation failed silently`,
      };
    }
    const actualSize = statSync(fullPath).size;
    const expectedSize = Buffer.byteLength(fixedContent, 'utf-8');
    if (actualSize !== expectedSize) {
      return {
        success: false,
        error: `File ${path} was written but size mismatch: expected ${expectedSize} bytes, got ${actualSize} bytes`,
      };
    }

    // Track the app directory as the current working app for auto-cwd in execute_command
    const appName = extractAppName(engine.workspaceDir, path);
    if (appName) {
      engine._currentApp = appName;
    }

    return {
      success: true,
      output: `Written ${String(content).length} bytes to ${path}`,
      data: { path, bytes: String(content).length },
    };
  };
}
