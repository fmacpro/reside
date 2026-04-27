import { OllamaClient } from './ollama.js';
import { ToolEngine } from './tools.js';
import { WorkspaceManager } from './workspace.js';
import { parseToolCalls } from './parser.js';

/**
 * Convert markdown links `[text](url)` to plain `url` in text output.
 * This prevents LLMs from rendering URLs as `[Link](https://...)` in the CLI.
 * Also handles bare URLs wrapped in angle brackets `<url>`.
 *
 * @param {string} text
 * @returns {string}
 */
function renderText(text) {
  if (!text) return text;

  let result = text;

  // Convert [text](url) -> url (plain URL, no markdown)
  result = result.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    const trimmedUrl = url.trim();
    const trimmedText = linkText.trim();
    if (trimmedText === trimmedUrl || /^https?:\/\//i.test(trimmedText)) {
      return trimmedUrl;
    }
    return trimmedUrl;
  });

  // Convert <url> -> url
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  return result;
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
        response = await this.ollama.chat(this.config.model, this.messages, {
          temperature: 0.1,
        });
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
          console.log(`\n🤖 ${renderText(lastText)}`);
        }
        finished = true;
        break;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        console.log(`\n🔧 ${tc.tool}(${JSON.stringify(tc.arguments)})`);

        const result = await this.toolEngine.execute(tc.tool, tc.arguments);

        if (result.success) {
          const outputPreview = result.output
            ? (result.output.length > 500 ? result.output.substring(0, 500) + '...' : result.output)
            : '(completed)';
          console.log(`   ✅ ${outputPreview}`);
        } else {
          console.log(`   ❌ ${result.error}`);
        }

        const resultContent = result.success
          ? (result.output || '(completed successfully)')
          : `Error: ${result.error}`;

        this.messages.push({
          role: 'tool',
          content: JSON.stringify({
            tool: tc.tool,
            arguments: tc.arguments,
            result: result.success ? 'success' : 'error',
            output: resultContent,
          }),
        });

        if (tc.tool === 'finish') {
          finished = true;
          console.log(`\n✅ ${result.output}`);
          break;
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
