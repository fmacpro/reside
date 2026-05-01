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

  return `${config.systemPrompt}\n\n## Available Tools\n\n${toolDescriptions}\n\n## Workdir\nYou are working in: ${workspaceManager.getPath()}\nCreate each app in its own subdirectory (e.g., my-app/). Each app directory gets its own git repository automatically when created via create_directory.${appsList}\nAlways use relative paths.`;
}
