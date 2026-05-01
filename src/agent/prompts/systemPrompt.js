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
  }

  return `${config.systemPrompt}\n\n## Available Tools\n\n${toolDescriptions}\n\n## Workdir\nYou are working in: ${workspaceManager.getPath()}\nCreate each app in its own subdirectory (e.g., my-app/). Each app directory gets its own git repository automatically when created via create_directory.${appsList}\nAlways use relative paths.${modelSpecificPrompt}`;
}
