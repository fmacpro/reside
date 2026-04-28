import { OllamaClient } from './ollama.js';
import { ToolEngine } from './tools.js';
import { WorkspaceManager } from './workspace.js';
import { parseToolCalls } from './parser.js';
import { getModelConfig } from './config.js';

/**
 * Convert markdown links `[text](url)` to plain `url` in text output.
 * This prevents LLMs from rendering URLs as `[Link](https://...)` in the CLI.
 * Handles multi-line links where `]` and `(` are on separate lines.
 * Also handles bare URLs wrapped in angle brackets `<url>` or square brackets `[url]`.
 *
 * @param {string} text
 * @returns {string}
 */
function renderText(text) {
  if (!text) return text;

  let result = text;

  // Step 1: Normalize multi-line markdown links by joining bracket-paren pairs
  // that are separated by newlines: [url]\n(url) -> [url](url)
  result = result.replace(/\[([^\]]*)\]\s*\n\s*\(([^)]+)\)/g, '[$1]($2)');

  // Step 2: Convert [text](url) -> url (plain URL, no markdown)
  result = result.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    const trimmedUrl = url.trim();
    const trimmedText = linkText.trim();
    // If link text is a URL or generic like "Link", just return the URL
    if (trimmedText === trimmedUrl || /^https?:\/\//i.test(trimmedText)) {
      return trimmedUrl;
    }
    return trimmedUrl;
  });

  // Step 3: Convert bare URLs in square brackets [url] -> url
  result = result.replace(/\[(https?:\/\/[^\]]+)\]/g, '$1');

  // Step 4: Convert <url> -> url
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Step 5: Collapse "URL:\nhttps://..." -> "URL: https://..." (LLMs sometimes put URLs on a new line after "URL:")
  result = result.replace(/(URL|Link|Website):\s*\n\s*(https?:\/\/[^\s\n]+)/gi, '$1: $2');

  return result;
}

/**
 * Generate a brief one-line status for a successful tool execution result.
 * Instead of dumping raw output, this provides a concise summary per tool type.
 *
 * @param {string} tool - The tool name
 * @param {string} output - The full output from the tool
 * @param {object} [data] - Optional structured data from the tool result
 * @returns {string} A brief status string
 */
function _briefToolStatus(tool, output, data) {
  if (!output) return '(completed)';

  switch (tool) {
    case 'search_web': {
      // Use the data.results array length for accurate count (more reliable than parsing output text)
      let resultCount = 0;
      if (data && Array.isArray(data.results)) {
        resultCount = data.results.length;
      } else {
        // Fallback: count numbered lines in output
        resultCount = (output.match(/^\d+\.\s/m) || []).length;
      }
      const label = resultCount === 1 ? 'result' : 'results';
      return `Found ${resultCount || '?'} ${label}`;
    }
    case 'fetch_url': {
      // Show content length only — the delimiter line is not useful as a title
      const charCount = output.length;
      return `Extracted content (${charCount} chars)`;
    }
    case 'read_file': {
      const lines = output.split('\n').length;
      return `Read ${lines} lines (${output.length} chars)`;
    }
    case 'write_to_file':
    case 'edit_file': {
      return `Written ${output.length} bytes`;
    }
    case 'create_directory': {
      return 'Directory created';
    }
    case 'list_files': {
      const fileCount = (output.match(/^[^\s]/m) || []).length;
      return `Listed ${fileCount || '?'} items`;
    }
    case 'execute_command': {
      // If the command timed out (background process like a server), show the actual output
      // so the operator can see the server URL or startup message.
      if (data && data.timedOut && data.background) {
        // Show the first few lines of output (e.g., "Server running on http://localhost:3000")
        const lines = output.split('\n').filter(l => l.trim());
        const relevantLines = lines.filter(l => !l.includes('⚠️ Command timed out'));
        if (relevantLines.length > 0) {
          return relevantLines.slice(0, 3).join(' | ');
        }
      }
      const lines = output.split('\n').length;
      return `Command completed (${lines} lines, ${output.length} chars)`;
    }
    case 'get_current_time': {
      // Show the date/time in a compact format
      const lines = output.split('\n');
      return lines[0] || output;
    }
    case 'finish': {
      return output;
    }
    default:
      // Generic: show first line truncated
      const first = output.split('\n')[0] || '';
      return first.length > 80 ? first.substring(0, 80) + '...' : first;
  }
}

/**
 * The main agent loop.
 * Orchestrates the conversation with the LLM, parses tool calls,
 * executes them, and feeds results back to the model.
 *
 * The workdir is the git root. Apps/projects are subdirectories within it.
 * All tool operations are relative to the workdir.
 */
export class Agent {
  /**
   * @param {import('./config.js').ResideConfig} config
   */
  constructor(config) {
    this.config = config;
    this.ollama = new OllamaClient(config.ollamaHost);
    this.workspaceManager = new WorkspaceManager(config.workdir);
    this.toolEngine = null;
    this.messages = [];
    this.iteration = 0;
    this.sessionActive = false;

    // Loop detection state
    this._toolCallHistory = [];
    this._maxLoopHistory = 6;
    this._loopDetectedCount = 0;

    // Track directories created in this session to prevent redundant create_directory calls
    this._createdDirs = new Set();

    // Track npm install without cwd failures to detect repeated failures
    this._npmInstallNoCwdFailures = 0;

    // Track whether any source files were written in this session.
    // Used to detect when the LLM calls finish() without writing any code.
    this._hasWrittenSourceFile = false;

    // Track whether any CODE source files (e.g., .js, .ts, .py) have been
    // written, as opposed to data files (e.g., .json, .csv, .txt). The LLM
    // sometimes writes a data file like recipes.json but still hasn't written
    // the actual application entry point. This flag is stricter: it only
    // counts files with executable code extensions.
    this._hasWrittenCodeFile = false;

    // Track whether a recognized entry point file (e.g., app.js, index.js,
    // server.js, main.py) has been written. The LLM often writes helper
    // modules first (e.g., recipes.js, routes.js) and creates the entry
    // point last. Using this flag instead of _hasWrittenCodeFile ensures
    // proactive guidance and finish() interception don't stop firing until
    // the actual entry point is created.
    this._hasWrittenEntryPoint = false;

    // Recognized entry point filenames — the LLM must write one of these
    // before proactive guidance and finish() interception stop firing.
    this._entryPointNames = new Set([
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

    // Track how many times finish() has been intercepted without source files.
    // After the first interception, if the LLM calls finish() again without
    // writing source files, force-end the session — the LLM has proven it
    // won't follow the guidance to write code.
    this._finishWithoutSourceCount = 0;

    // Track how many times a runtime error has been intercepted for the same
    // run command. After the first interception with guidance, if the LLM
    // retries the same failing command instead of fixing the code, force-end
    // the session — the LLM is stuck in a retry loop.
    this._runtimeErrorCount = 0;
    this._lastRunCommand = '';

  }

  /**
   * Detect if the LLM is stuck in a tool-calling loop.
   * Checks if the same tool has been called 3+ times with the same arguments
   * within the recent history window.
   * @returns {boolean}
   */
  _isLooping() {
    const history = this._toolCallHistory;
    if (history.length < 4) return false;

    // Look at the last N calls and check for repetition
    const last = history[history.length - 1];

    // Count how many times this exact tool+args appears in recent history
    let count = 0;
    for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
      if (history[i].tool === last.tool && history[i].args === last.args) {
        count++;
      }
    }

    // 3+ identical calls = loop
    if (count >= 3) return true;

    // Also check for same tool called 4+ times with different args (e.g., fetch_url on different URLs)
    let sameToolCount = 0;
    for (let i = history.length - 1; i >= Math.max(0, history.length - 6); i--) {
      if (history[i].tool === last.tool) {
        sameToolCount++;
      }
    }

    // 4+ calls to the same tool in a row = loop (e.g., fetch_url on different URLs)
    if (sameToolCount >= 4) return true;

    return false;
  }

  /**
   * Start a session. Initializes the workdir (git root) and system prompt.
   *
   * @param {object} [options]
   * @param {string} [options.initialTask] - First task to run
   */
  async startSession(options = {}) {
    this.workspaceManager.init();
    this.toolEngine = new ToolEngine(this.workspaceManager.getPath(), this.workspaceManager, this.config);

    console.log(`\n📁 Workdir: ${this.workspaceManager.getPath()}`);
    console.log(`🤖 Model: ${this.config.model}`);
    console.log('─'.repeat(50));

    const systemPrompt = this._buildSystemPrompt();
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.sessionActive = true;

    if (options.initialTask) {
      await this.processUserMessage(options.initialTask);
    }
  }

  /**
   * Process a single user message through the agent loop.
   * Can be called repeatedly in conversational mode.
   *
   * @param {string} userMessage
   * @returns {Promise<{finished: boolean, text: string, toolCalls: number}>}
   */
  async processUserMessage(userMessage) {
    if (!this.sessionActive) {
      throw new Error('Session not started. Call startSession() first.');
    }

    this.messages.push({ role: 'user', content: userMessage });

    let finished = false;
    let lastText = '';

    while (this.iteration < this.config.maxIterations && !finished) {
      this.iteration++;

      let response;
      try {
        // Resolve model-specific generation settings from config.
        // Falls back to sensible defaults for unknown models.
        const modelCfg = getModelConfig(this.config.model, this.config);
        const ollamaOptions = {};
        if (modelCfg.maxTokens !== undefined) ollamaOptions.maxTokens = modelCfg.maxTokens;
        if (modelCfg.temperature !== undefined) ollamaOptions.temperature = modelCfg.temperature;
        if (modelCfg.topP !== undefined) ollamaOptions.topP = modelCfg.topP;
        if (modelCfg.topK !== undefined) ollamaOptions.topK = modelCfg.topK;
        if (modelCfg.repeatPenalty !== undefined) ollamaOptions.repeatPenalty = modelCfg.repeatPenalty;
        if (modelCfg.numCtx !== undefined) ollamaOptions.numCtx = modelCfg.numCtx;

        response = await this.ollama.chat(this.config.model, this.messages, ollamaOptions);
      } catch (err) {
        console.error(`\n❌ Model request failed: ${err.message}`);
        console.log('   Make sure Ollama is running and the model is available.');
        break;
      }

      const content = response.message.content || '';
      const { text, toolCalls } = parseToolCalls(content);

      this.messages.push({ role: 'assistant', content });

      // No tool calls = text-only response, return to user
      if (toolCalls.length === 0) {
        lastText = text || content;
        if (lastText) {
          // Detect fabricated placeholder responses — the model is making up info instead of using tools
          const placeholderPatterns = [
            /\[insert[^\]]*\]/i,
            /\[your[^\]]*\]/i,
            /\[placeholder[^\]]*\]/i,
            /\[brief[^\]]*\]/i,
            /\[link[^\]]*\]/i,
            /\[url[^\]]*\]/i,
            /\[source[^\]]*\]/i,
            /\[add[^\]]*\]/i,
            /\[provide[^\]]*\]/i,
            // Template syntax like {{search_results[0].url}} — the model should use real URLs from the output
            /\{\{[^}]+\}\}/,
          ];
          const hasPlaceholders = placeholderPatterns.some(p => p.test(lastText));

          if (hasPlaceholders) {
            // Re-prompt the model to actually use tools instead of fabricating
            console.log('   ⚠️ Response contains placeholder text — re-prompting to use tools');
            this.messages.push({
              role: 'system',
              content: 'Your previous response contained placeholder text like "[Insert Current Event]" or template syntax like "{{search_results[0].url}}" instead of real information. You MUST use the search_web() tool to get current information, then use the REAL URLs from the search results output when calling fetch_url(). Do NOT use template variables like {{...}} — just copy the actual URLs from the search results. Do NOT fabricate or make up information.',
            });
            continue;
          }

          console.log(`\n🤖 ${renderText(lastText)}`);
        }
        finished = true;
        break;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        if (this.config.debugMode) {
          // Debug mode: show full raw JSON arguments
          console.log(`\n🔧 ${tc.tool}(${JSON.stringify(tc.arguments)})`);
        } else {
          // Compact mode: show tool name and first string arg value
          const argPreview = tc.arguments
            ? Object.values(tc.arguments).find(v => typeof v === 'string' && v.length > 0) || ''
            : '';
          const displayArgs = argPreview
            ? `"${argPreview.length > 60 ? argPreview.substring(0, 60) + '...' : argPreview}"`
            : '';
          console.log(`\n🔧 ${tc.tool}${displayArgs ? `(${displayArgs})` : '()'}`);
        }

        // Track tool calls for loop detection
        this._toolCallHistory.push({ tool: tc.tool, args: JSON.stringify(tc.arguments) });
        if (this._toolCallHistory.length > this._maxLoopHistory) {
          this._toolCallHistory.shift();
        }

        // Detect: calling create_directory on a top-level app directory that was already
        // created in this session. Subdirectories within an app (e.g., "time-app/assets/")
        // are allowed freely. Only top-level directories (direct children of workdir)
        // are tracked to prevent the LLM from creating the same app directory twice.
        if (tc.tool === 'create_directory') {
          const dirPath = tc.arguments?.path || '';
          // Only track top-level directories (no '/' in path, or single segment)
          const isTopLevel = !dirPath.includes('/');
          if (isTopLevel && this._createdDirs.has(dirPath)) {
            console.log(`   ⚠️ create_directory("${dirPath}") was already called — ending session.`);
            this.messages.push({
              role: 'tool',
              content: JSON.stringify({
                tool: tc.tool,
                arguments: tc.arguments,
                result: 'error',
                output: `Error: Directory "${dirPath}" was already created in this session. Do NOT call create_directory() more than once for the same app directory.`,
              }),
            });
            finished = true;
            break;
          }
          if (isTopLevel) {
            this._createdDirs.add(dirPath);
          }
        }

        // Detect: calling fetch_url on a URL that was just returned by search_web in the same iteration.
        // search_web already fetches article content — fetch_url is redundant here.
        if (tc.tool === 'fetch_url' && this._lastSearchResults) {
          const url = tc.arguments?.url || '';
          const isFromSearch = this._lastSearchResults.some(r => r.url === url);
          if (isFromSearch) {
            console.log('   ⚠️ fetch_url called on a search result — search_web already fetched this content. Skipping.');
            // Inject a system message telling the LLM to use the search results directly
            this.messages.push({
              role: 'system',
              content: 'You just called fetch_url() on a URL that was already returned by search_web(). search_web() already fetches the full content of each article and returns summaries with URLs. You do NOT need to call fetch_url() on search results. Present the search results directly as a formatted list with titles, summaries, and URLs. Only use fetch_url() if the user asks for the full text of a specific article.',
            });
            continue;
          }
        }

        // Detect loops: same tool called 3+ times with same arguments
        if (this._isLooping()) {
          this._loopDetectedCount++;
          console.log(`   ⚠️ Loop detected (#${this._loopDetectedCount}) — forcing text response`);

          // If loop has been detected multiple times, the LLM is ignoring guidance.
          // Force the session to end — the LLM cannot be trusted to break out of the loop.
          if (this._loopDetectedCount >= 2) {
            console.log('   ⚠️ Repeated loop detection — ending session.');
            finished = true;
            break;
          }

          // Reset history so we don't immediately trigger again
          this._toolCallHistory = [];
          // Inject a system message telling the LLM to respond with text
          this.messages.push({
            role: 'system',
            content: 'You have been calling the same tool repeatedly. STOP calling tools and respond to the user directly with what you know. Use the information you already have.',
          });
          // Skip remaining tool calls in this iteration
          break;
        }

        const result = await this.toolEngine.execute(tc.tool, tc.arguments);

        // Track search results so we can detect redundant fetch_url calls
        if (tc.tool === 'search_web' && result.success && result.data?.results) {
          this._lastSearchResults = result.data.results;
        }

        // Define critical tools list — used both for error handling below
        // and for deciding whether to inject tool results.
        const criticalTools = ['write_file', 'create_directory', 'edit_file'];

        if (result.success) {
          // Track whether any source files have been written in this session.
          // Used to detect when the LLM calls finish() without writing any code.
          if (tc.tool === 'write_file' || tc.tool === 'edit_file') {
            this._hasWrittenSourceFile = true;
            // Track whether a CODE file (not just data like .json) was written.
            // The LLM sometimes writes recipes.json but still hasn't written app.js.
            const filePath = tc.arguments?.path || tc.arguments?.file_path || '';
            const codeExtensions = /\.(js|ts|jsx|tsx|py|rb|php|go|rs|c|cpp|java|mjs|cjs)$/i;
            if (codeExtensions.test(filePath)) {
              this._hasWrittenCodeFile = true;
              // Check if this is a recognized entry point file (e.g., app.js, index.js).
              // The LLM often writes helper modules first (e.g., recipes.js, routes.js)
              // and creates the entry point last. We only stop proactive guidance and
              // finish() interception when an entry point is detected.
              const fileName = filePath.split('/').pop();
              if (this._entryPointNames.has(fileName)) {
                this._hasWrittenEntryPoint = true;
              }
            }
          }

          // After a successful npm install, proactively guide the LLM to write
          // source files next. The LLM often searches the web, tries to run
          // non-existent files, or calls finish() after installing deps — this
          // guidance is injected BEFORE the LLM's next turn to prevent that.
          if (tc.tool === 'execute_command') {
            const cmd = tc.arguments?.command || '';
            if (/^npm\s+install/.test(cmd.trim()) && !this._hasWrittenEntryPoint) {
              this.messages.push({
                role: 'system',
                content: 'Dependencies installed successfully. Now you MUST write the main application entry point file (e.g., app.js, index.js, server.js) using write_file() before doing anything else. This file should contain the actual application logic (routes, handlers, etc.) — not just data files like .json. Do NOT search the web, do NOT try to run the app, and do NOT call finish() — write the main code file first.',
              });
            }
          }

          if (this.config.debugMode) {
            // Debug mode: show full raw output (truncated at 500 chars)
            const outputPreview = result.output
              ? (result.output.length > 500 ? result.output.substring(0, 500) + '...' : result.output)
              : '(completed)';
            console.log(`   ✅ ${outputPreview}`);
          } else {
            // Compact mode: show brief one-line status per tool type
            const briefStatus = _briefToolStatus(tc.tool, result.output, result.data);
            console.log(`   ✅ ${briefStatus}`);
          }
        } else {
          console.log(`   ❌ ${result.error}`);
          // When a critical tool fails, inject guidance to prevent the LLM from
          // blindly continuing to call more tools (e.g., trying to run a file
          // that was never created, or installing deps in a non-existent dir).
          if (criticalTools.includes(tc.tool)) {
            // For create_directory "already exists" errors: inject the error
            // as a tool result so the LLM sees it, then force the session to end.
            // The LLM MUST NOT get another turn to call more tools — it tends to
            // ignore guidance and try different directory names, write to wrong
            // folders, or get stuck in a loop.
            if (tc.tool === 'create_directory' && result.error?.includes('already exists')) {
              const dirName = tc.arguments?.path || '';
              // Inject the tool result so the LLM sees the actual error
              this.messages.push({
                role: 'tool',
                content: JSON.stringify({
                  tool: tc.tool,
                  arguments: tc.arguments,
                  result: 'error',
                  output: `Error: ${result.error}`,
                }),
              });
              // Force the session to end — the LLM does not get another turn.
              // The error message from create_directory already tells the user
              // to specify a different name if they want a new app.
              finished = true;
              break;
            }

            // For other critical tool failures, inject the error as a tool result
            // plus guidance telling the LLM to stop and reassess.
            this.messages.push({
              role: 'tool',
              content: JSON.stringify({
                tool: tc.tool,
                arguments: tc.arguments,
                result: 'error',
                output: `Error: ${result.error}`,
              }),
            });
            const guidance = `The ${tc.tool}() tool just failed with: "${result.error}". Do NOT continue calling more tools — stop and reassess. Check what went wrong (e.g., does the directory exist? was the file created properly?) and fix the issue before proceeding. If you're stuck, explain the problem to the user.`;
            this.messages.push({
              role: 'system',
              content: guidance,
            });
            // Skip remaining tool calls in this iteration so the LLM can respond
            break;
          }
        }

        // For npm install failures, inject guidance telling the LLM what went wrong,
        // then break out of the tool loop so the LLM MUST address the failure before
        // continuing. The LLM consistently ignores guidance and continues writing code
        // that depends on packages that were never installed.
        if (!result.success && tc.tool === 'execute_command') {
          const cmd = tc.arguments?.command || '';
          const errMsg = result.error || '';

          if (/^npm\s+install/.test(cmd.trim())) {
            // Inject the tool result so the LLM sees the actual error
            this.messages.push({
              role: 'tool',
              content: JSON.stringify({
                tool: tc.tool,
                arguments: tc.arguments,
                result: 'error',
                output: `Error: ${result.error}`,
              }),
            });

            // Check if the error is about missing cwd (running in workdir root instead of app dir)
            if (errMsg.includes('should run inside an app directory') || errMsg.includes('cwd')) {
              this._npmInstallNoCwdFailures++;

              // If the LLM has repeatedly failed to use cwd, force the session to end.
              // The LLM consistently ignores guidance and keeps retrying without cwd.
              if (this._npmInstallNoCwdFailures >= 2) {
                console.log('   ⚠️ Repeated npm install without cwd — ending session.');
                finished = true;
                break;
              }

              this.messages.push({
                role: 'system',
                content: `The npm install command failed because you forgot to set the cwd parameter. You MUST always use cwd when running npm commands inside an app directory. For example: execute_command({"command":"${cmd}","cwd":"<app-name>"}). Look at the error message to see which apps are available, then pick the correct one. Do NOT retry without cwd.`,
              });
            } else {
              // Package-related failure (non-existent, incompatible, etc.)
              this.messages.push({
                role: 'system',
                content: `The npm install command failed. Before trying to install a package again, you MUST first verify the package exists on the npm registry by searching the web. Use search_web() to find the correct package name. Do NOT guess package names — many packages have different names than you expect. For example, instead of "curses" (which doesn't work), you might need "blessed", "chalk", or another package. Always search first, install second.`,
              });
            }

            // Break out of the tool loop — the LLM MUST address the failure before continuing.
            // This prevents the LLM from writing code that depends on packages that were never installed.
            break;
          }

          // Detect common API usage errors in run commands (node app.js, python app.py, etc.)
          // The LLM often writes code with API patterns that don't match the installed version.
          // For example, inquirer v9+ is ESM-only and doesn't support require('inquirer').prompt.
          const isRunCommand = /^(node|python3?|deno|bun)\s/.test(cmd.trim());
          if (isRunCommand) {
            const knownErrors = [
              {
                pattern: /inquirer\.prompt is not a function/i,
                guidance: 'The "inquirer" package v9+ is ESM-only and does not support require("inquirer").prompt in CommonJS. To fix this, either: (1) Use dynamic import: const { default: inquirer } = await import("inquirer"); then use inquirer.prompt(), OR (2) Install an older CJS-compatible version: npm install inquirer@8.2.6, OR (3) Set "type": "module" in package.json and use import statements instead of require(). Do NOT reinstall inquirer — the version is fine, the import syntax needs to change.',
              },
              {
                pattern: /MODULE_NOT_FOUND/i,
                guidance: 'The source file does not exist. You forgot to write it! You MUST use write_file() to create the source file BEFORE running it. Do NOT retry the run command — write the source file first.',
              },
              {
                pattern: /require is not defined in ES module scope/i,
                guidance: 'The project uses ES modules ("type": "module" in package.json), which do NOT support require(). You MUST use import/export syntax instead. To fix this: (1) Replace require() calls with import statements, e.g., import axios from "axios"; instead of const axios = require("axios"); (2) If you need require() for some packages, use createRequire: import { createRequire } from "node:module"; const require = createRequire(import.meta.url); (3) For JSON file imports, use: import data from "./file.json" with { type: "json" }; Do NOT edit package.json to remove "type": "module" — that is the wrong fix. Adapt the code to use ESM syntax instead.',
              },
              {
                pattern: /ERR_IMPORT_ATTRIBUTE_MISSING/i,
                guidance: 'Node.js v24 requires the "with { type: \'json\' }" assertion when importing JSON files in ES modules. To fix this, add the assertion to your import statement: import data from "./file.json" with { type: "json" }; Do NOT remove "type": "module" from package.json — that is the wrong fix. Just add the assertion to the import statement.',
              },
              {
                pattern: /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError):/m,
                guidance: 'The application code has a runtime error. Do NOT retry the same command — it will fail again. Instead, use read_file() to examine the source code, identify the bug, and use edit_file() to fix it. Common issues include: accessing properties on undefined values, calling undefined functions, or incorrect API response handling.',
              },
            ];

            const matchedError = knownErrors.find(e => e.pattern.test(errMsg));
            if (matchedError) {
              // Track repeated runtime errors for the same command to prevent
              // the LLM from retrying the same failing command instead of fixing the code.
              // The LLM often ignores the guidance and retries the exact same command.
              if (cmd === this._lastRunCommand) {
                this._runtimeErrorCount++;
              } else {
                this._runtimeErrorCount = 1;
                this._lastRunCommand = cmd;
              }

              // If the LLM has already been told to fix the code and is retrying
              // the same command, force-end the session — the LLM is stuck.
              if (this._runtimeErrorCount >= 2) {
                console.log('   ⚠️ LLM retried the same failing command after guidance — ending session.');
                this.messages.push({
                  role: 'tool',
                  content: JSON.stringify({
                    tool: tc.tool,
                    arguments: tc.arguments,
                    result: 'error',
                    output: `Error: ${result.error}`,
                  }),
                });
                finished = true;
                break;
              }

              this.messages.push({
                role: 'tool',
                content: JSON.stringify({
                  tool: tc.tool,
                  arguments: tc.arguments,
                  result: 'error',
                  output: `Error: ${result.error}`,
                }),
              });
              this.messages.push({
                role: 'system',
                content: matchedError.guidance,
              });
              // Break out of the tool loop so the LLM fixes the code instead of retrying the same command
              break;
            }
          }
        }

        // Only inject tool result + check finish for successful tools or
        // non-critical failures (critical failures already handled above)
        if (result.success || !criticalTools.includes(tc.tool)) {
          const resultContent = result.success
            ? (result.output || '(completed successfully)')
            : `Error: ${result.error}`;

          const toolResult = {
            tool: tc.tool,
            arguments: tc.arguments,
            result: result.success ? 'success' : 'error',
            output: resultContent,
          };
          if (result.data) {
            toolResult.data = result.data;
          }

          this.messages.push({
            role: 'tool',
            content: JSON.stringify(toolResult),
          });

          if (tc.tool === 'finish') {
            // If the LLM calls finish() without ever writing a recognized entry
            // point file (e.g., app.js, index.js, server.js), intercept it and
            // inject guidance instead of ending the session. The LLM often writes
            // helper modules (e.g., recipes.js, routes.js) or data files (.json),
            // then calls finish() without writing the actual entry point.
            if (!this._hasWrittenEntryPoint) {
              this._finishWithoutSourceCount++;
              console.log(`   ⚠️ finish() called but no entry point file was written — intercepting (#${this._finishWithoutSourceCount})`);

              // If the LLM has already been told to write the entry point and is
              // calling finish() again, force-end the session. The LLM has proven
              // it won't follow the guidance.
              if (this._finishWithoutSourceCount >= 2) {
                console.log('   ⚠️ LLM repeatedly called finish() without writing an entry point — ending session.');
                finished = true;
                break;
              }

              this.messages.push({
                role: 'tool',
                content: JSON.stringify({
                  tool: tc.tool,
                  arguments: tc.arguments,
                  result: 'error',
                  output: 'Error: You called finish() but never wrote the main application entry point file (e.g., app.js, index.js, server.js). Writing helper modules or data files like .json is not enough — you MUST use write_file() to create the entry point with the actual application logic before calling finish().',
                }),
              });
              this.messages.push({
                role: 'system',
                content: 'You called finish() without writing the main application entry point file (e.g., app.js, index.js, server.js). Writing helper modules or data files like .json is not enough. You MUST write the entry point file with the actual application logic using write_file() before calling finish(). Do NOT call finish() again until you have created the entry point. Also, do NOT try to run the app (e.g., "node app.js") before writing the file — the file does not exist yet. Write the file first, then run it.',
              });
              // Do NOT set finished = true — the LLM gets one more chance to write the code
              break;
            }
            finished = true;
            console.log(`\n✅ ${result.output}`);
            break;
          }
        }
      }

      // Auto-commit in each dirty app directory
      if (this.config.autoCommit) {
        const dirtyApps = this.workspaceManager.findDirtyApps();
        for (const appPath of dirtyApps) {
          this.workspaceManager.autoCommit(
            appPath,
            `Iteration ${this.iteration}: ${toolCalls.map(t => t.tool).join(', ')}`
          );
        }
      }
    }

    return {
      finished,
      text: lastText,
      toolCalls: this.messages.filter(m => m.role === 'tool').length,
    };
  }

  /**
   * End the session and print summary.
   */
  endSession() {
    this.sessionActive = false;
    console.log('\n' + '═'.repeat(50));
    console.log(`📊 Session Summary:`);
    console.log(`   Iterations: ${this.iteration}`);
    console.log(`   Messages: ${this.messages.length}`);
    console.log(`   Workdir: ${this.workspaceManager.getPath()}`);

    const apps = this.workspaceManager.listApps();
    if (apps.length > 0) {
      console.log(`   Apps in workdir:`);
      for (const app of apps) {
        const gitStatus = app.hasGit ? '📜' : '📁';
        console.log(`     ${gitStatus} ${app.name}`);
        if (app.hasGit) {
          const gitLog = this.workspaceManager.getGitLog(app.path, 3);
          if (gitLog && !gitLog.startsWith('(no')) {
            const lines = gitLog.split('\n');
            for (const line of lines) {
              console.log(`       ${line}`);
            }
          }
        }
      }
    }
  }

  /**
   * Build the system prompt with tool descriptions.
   * @private
   */
  _buildSystemPrompt() {
    const toolDescriptions = new ToolEngine('/tmp').getToolDescriptions();
    const apps = this.workspaceManager.listApps();
    const appsList = apps.length > 0
      ? `\nExisting apps/projects in this workdir:\n${apps.map(a => `  - ${a.name}/`).join('\n')}`
      : '\nThe workdir is empty. Create new app directories as needed.';

    return `${this.config.systemPrompt}\n\n## Available Tools\n\n${toolDescriptions}\n\n## Workdir\nYou are working in: ${this.workspaceManager.getPath()}\nCreate each app in its own subdirectory (e.g., my-app/). Each app directory gets its own git repository automatically when created via create_directory.${appsList}\nAlways use relative paths.`;
  }
}
