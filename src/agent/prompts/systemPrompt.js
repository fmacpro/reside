import { ToolEngine } from '../../tools/index.js';

/**
 * Build the system prompt with tool descriptions and workspace context.
 *
 * @param {import('../../workspace.js').WorkspaceManager} workspaceManager
 * @param {import('../../config.js').ResideConfig} config
 * @returns {string}
 */
export function buildSystemPrompt(workspaceManager, config) {
  const toolDescriptions = new ToolEngine('/tmp').getToolDescriptions();
  const apps = workspaceManager.listApps();
  const appsList = apps.length > 0
    ? `\nExisting apps/projects in this workdir:\n${apps.map(a => `  - ${a.name}/`).join('\n')}`
    : '\nThe workdir is empty. Create new app directories as needed.';

  // Add model-specific instructions for DeepSeek models
  // DeepSeek models are trained to use a specific XML-like tool call format
  // (<｜tool▁calls▁begin｜>) but Reside uses a JSON-based format. We need to
  // explicitly tell DeepSeek to use JSON format instead.
  const modelName = config.model || '';
  const isDeepSeek = /^deepseek/i.test(modelName);
  // Models that tend to default to CommonJS require() syntax instead of ESM import/export.
  // These models need explicit, forceful instructions to use ESM syntax.
  const needsEsmForce = /^qwen2\.5-coder|^codellama|^starcoder|^phi/i.test(modelName);

  let modelSpecificPrompt = '';
  if (isDeepSeek) {
    modelSpecificPrompt = `
 
## CRITICAL — Tool Call Format
 
You MUST use the JSON format for ALL tool calls. Do NOT use any other format.
 
CORRECT format for a single tool call:
{"tool": "tool_name", "arguments": {"arg1": "val1"}}
 
CORRECT format for multiple tool calls:
[{"tool": "tool_name", "arguments": {...}}, {"tool": "tool_name2", "arguments": {...}}]
 
You can include normal text before or after tool calls.
 
When you receive a tool result, it will be in this format:
{"tool": "tool_name", "arguments": {...}, "result": "success", "output": "..."}
 
The "result" field will be "success" or "error". The "output" field contains the result data.
 
IMPORTANT: Do NOT use <｜tool▁calls▁begin｜> or <｜tool▁call▁begin｜> or <｜tool▁sep｜> or <｜tool▁call▁end｜> or <｜tool▁calls▁end｜> tags. These are NOT valid in this system. Only use the JSON format shown above.
 
IMPORTANT: Do NOT wrap tool calls in \`\`\`json code fences. Just output the raw JSON object or array directly.
 
Example of what you should output:
{"tool": "search_web", "arguments": {"query": "current population of the world"}}
 
Example of what you should NOT output (wrong format):
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web
\`\`\`json
{"query": "current population of the world"}
\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 
Always use the JSON format. Never use the XML-like format.`;
  } else if (needsEsmForce) {
    modelSpecificPrompt = `
 
## CRITICAL — ES Module (ESM) Syntax Required
 
All new Node.js apps use ES modules ("type": "module" in package.json). The system automatically adds "type": "module" after npm init -y.
 
You MUST use import/export syntax. You MUST NOT use require() or module.exports.
 
  ✅ CORRECT — ESM syntax (use this):
    import { readFileSync, writeFileSync } from "node:fs";
    import axios from "axios";
    export function getWeather(city) { ... }
    export default class App { ... }
 
  ❌ WRONG — CommonJS syntax (will crash with "require is not defined in ES module scope"):
    const fs = require("fs");              // ❌ require() does NOT work in ESM
    const axios = require("axios");        // ❌ require() does NOT work in ESM
    module.exports = { getWeather };       // ❌ module.exports does NOT work in ESM
    exports.getWeather = ...;              // ❌ exports does NOT work in ESM
 
  ❌ WRONG — node-fetch (will crash with ERR_REQUIRE_ESM):
    const fetch = require("node-fetch");   // ❌ node-fetch v3+ is ESM-only
    import fetch from "node-fetch";        // ❌ fetch() is globally available, no import needed
 
  ✅ CORRECT — use global fetch() (available in Node.js 18+, no import needed):
    const response = await fetch("https://wttr.in/London?format=j1");
    const data = await response.json();
 
  ✅ CORRECT — JSON imports in ESM (use "with { type: 'json' }" assertion):
    import data from "./file.json" with { type: "json" };
 
  ✅ CORRECT — __dirname replacement in ESM:
    import { fileURLToPath } from "node:url";
    import { dirname } from "node:path";
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
 
  ✅ CORRECT — dynamic import in ESM:
    const module = await import("some-package");
 
  ✅ CORRECT — using require() in ESM (only when absolutely necessary):
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const pkg = require("./some-commonjs-package.cjs");
 
REMEMBER:
  - Do NOT edit package.json to remove "type": "module" — that is NEVER the right fix
  - Do NOT create .cjs files as a workaround — .cjs files use CommonJS (require/module.exports), NOT ESM
  - If you get "require is not defined in ES module scope", fix the code to use import/export — do NOT change package.json
  - fetch() is globally available in Node.js 18+ — do NOT install or import node-fetch
  - For JSON file imports, ALWAYS use "with { type: 'json' }" assertion`;
  }

  return `${config.systemPrompt}\n\n## Available Tools\n\n${toolDescriptions}\n\n## Workdir\nYou are working in: ${workspaceManager.getPath()}\nCreate each app in its own subdirectory (e.g., my-app/). Each app directory gets its own git repository automatically when created via create_directory.${appsList}\nAlways use relative paths.${modelSpecificPrompt}`;
}
