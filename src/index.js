#!/usr/bin/env node

import { loadConfig, saveConfig } from './config.js';
import { Agent } from './agent.js';
import { OllamaClient } from './ollama.js';
import { WorkspaceManager } from './workspace.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const HELP_TEXT = `
Reside - A simplified Node.js agentic IDE for local LLMs via Ollama

USAGE:
  reside <task>                          Run a single task and exit
  reside --model <name> <task>           Run with a specific model
  reside --file <path>                   Run with task from a file
  reside --chat                          Start an interactive conversational session
  reside --list-models                   List available Ollama models
  reside --list-apps                     List apps in the workdir
  reside --set <key> <value>             Set a config value
  reside --help                          Show this help

EXAMPLES:
  reside "Create a simple Express.js API server"
  reside --model qwen3.5:latest "Build a React todo app"
  reside --chat                          # Start interactive chat
  reside --file task.txt
  reside --set model qwen3.5:latest
  reside --list-models

CONFIGURATION:
  Config file: ~/.config/reside/config.json
  Environment variables: RESIDE_MODEL, RESIDE_WORKDIR, RESIDE_OLLAMA_HOST
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP_TEXT);
    return;
  }

  const config = loadConfig();

  // Parse flags
  let task = '';
  let modelOverride = null;
  let chatMode = false;
  let i = 0;

  while (i < args.length) {
    switch (args[i]) {
      case '--model':
        modelOverride = args[++i];
        i++;
        break;
      case '--chat':
        chatMode = true;
        i++;
        break;
      case '--file': {
        const filePath = resolve(process.cwd(), args[++i]);
        if (!existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exit(1);
        }
        task = readFileSync(filePath, 'utf-8').trim();
        i++;
        break;
      }
      case '--list-models': {
        await listModels(config);
        return;
      }
      case '--list-apps': {
        await listApps(config);
        return;
      }
      case '--set': {
        const key = args[++i];
        const value = args[++i];
        if (key && value) {
          saveConfig({ [key]: value });
          console.log(`Set config: ${key} = ${value}`);
        } else {
          console.error('Usage: reside --set <key> <value>');
        }
        return;
      }
      default:
        task = args.slice(i).join(' ');
        i = args.length;
        break;
    }
  }

  // Apply model override
  if (modelOverride) config.model = modelOverride;

  // Ensure model is available
  await ensureModel(config);

  if (chatMode) {
    await startChatSession(config, task || null);
  } else if (task) {
    await runSingleTask(config, task);
  } else {
    console.error('No task provided. Use --help for usage.');
    process.exit(1);
  }
}

/**
 * Run a single task and exit.
 */
async function runSingleTask(config, task) {
  const agent = new Agent(config);
  try {
    await agent.startSession({ initialTask: task });
    agent.endSession();
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Start an interactive conversational session.
 */
async function startChatSession(config, initialTask) {
  const agent = new Agent(config);

  try {
    await agent.startSession({ initialTask: initialTask || undefined });
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }

  // Enter REPL loop
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n💬 > ',
    terminal: true,
  });

  console.log('\nInteractive mode. Type your messages or commands:');
  console.log('  /exit    - End session and quit');
  console.log('  /sum     - Show session summary');
  console.log('  /git     - Show git log');
  console.log('  /apps    - List apps in workdir');
  console.log('  /clear   - Clear conversation history (keeps system prompt)');
  console.log('  /model   - Show current model');
  console.log('  /help    - Show this help');

  let running = true;

  rl.on('close', () => {
    running = false;
  });

  const prompt = () => {
    if (running) rl.prompt();
  };

  prompt();

  for await (const line of rl) {
    if (!running) break;

    const input = line.trim();

    if (!input) {
      prompt();
      continue;
    }

    // Handle commands
    if (input.startsWith('/')) {
      switch (input) {
        case '/exit':
        case '/quit':
          console.log('Ending session...');
          agent.endSession();
          rl.close();
          return;

        case '/sum':
        case '/summary':
          agent.endSession();
          break;

        case '/git':
        case '/log': {
          const apps = agent.workspaceManager.listApps();
          const gitApps = apps.filter(a => a.hasGit);
          if (gitApps.length === 0) {
            console.log('\nNo git repositories in any apps yet.');
          } else {
            console.log('');
            for (const app of gitApps) {
              console.log(`📜 ${app.name}:`);
              const gitLog = agent.workspaceManager.getGitLog(app.path);
              if (gitLog && !gitLog.startsWith('(no')) {
                const lines = gitLog.split('\n');
                for (const line of lines) {
                  console.log(`  ${line}`);
                }
              } else {
                console.log('  (no commits)');
              }
              console.log('');
            }
          }
          break;
        }

        case '/apps': {
          const apps = agent.workspaceManager.listApps();
          if (apps.length === 0) {
            console.log('\nNo apps in workdir yet.');
          } else {
            console.log('\nApps in workdir:');
            for (const app of apps) {
              console.log(`  📁 ${app.name}`);
            }
          }
          break;
        }

        case '/clear':
          const systemMsg = agent.messages[0];
          agent.messages = [systemMsg];
          agent.iteration = 0;
          console.log('🧹 Conversation history cleared.');
          break;

        case '/model':
          console.log(`🤖 Model: ${config.model}`);
          break;

        case '/help':
          console.log('Commands:');
          console.log('  /exit    - End session and quit');
          console.log('  /sum     - Show session summary');
          console.log('  /git     - Show git log');
          console.log('  /apps    - List apps in workdir');
          console.log('  /clear   - Clear conversation history');
          console.log('  /model   - Show current model');
          console.log('  /help    - Show this help');
          break;

        default:
          console.log(`Unknown command: ${input}. Type /help for commands.`);
      }

      prompt();
      continue;
    }

    // Process user message through the agent
    try {
      await agent.processUserMessage(input);
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}`);
    }

    prompt();
  }

  if (running) {
    agent.endSession();
  }
}

/**
 * Ensure the configured model is available in Ollama.
 */
async function ensureModel(config) {
  const ollama = new OllamaClient(config.ollamaHost);
  const available = await ollama.isModelAvailable(config.model);
  if (!available) {
    console.log(`Model "${config.model}" not found. Pulling...`);
    try {
      await ollama.pullModel(config.model);
      console.log('Model pulled successfully.');
    } catch (err) {
      console.error(`Failed to pull model: ${err.message}`);
      console.log('Make sure Ollama is running.');
      process.exit(1);
    }
  }
}

async function listModels(config) {
  const ollama = new OllamaClient(config.ollamaHost);
  try {
    const { models } = await ollama.listModels();
    console.log('\nAvailable models:\n');
    for (const m of models) {
      console.log(`  ${m.name}`);
    }
    console.log();
  } catch (err) {
    console.error(`Failed to list models: ${err.message}`);
    console.log('Make sure Ollama is running.');
  }
}

async function listApps(config) {
  const wm = new WorkspaceManager(config.workdir);
  wm.init();
  const apps = wm.listApps();
  if (apps.length === 0) {
    console.log('\nNo apps in workdir.\n');
    return;
  }
  console.log('\nApps in workdir:\n');
  for (const app of apps) {
    const icon = app.hasGit ? '📜' : '📁';
    console.log(`  ${icon} ${app.name}`);
    console.log(`     ${app.path}`);
    if (app.hasGit) {
      const gitLog = wm.getGitLog(app.path, 3);
      if (gitLog && !gitLog.startsWith('(no')) {
        const lines = gitLog.split('\n');
        for (const line of lines) {
          console.log(`     ${line}`);
        }
      }
    }
  }
  console.log();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
