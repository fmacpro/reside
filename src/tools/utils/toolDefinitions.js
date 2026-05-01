/**
 * Get tool definitions with metadata.
 * @returns {Object} Tool definitions keyed by tool name
 */
export function getToolDefinitions() {
  return {
    read_file: {
      desc: 'Read the contents of a file',
      params: ['path'],
    },
    write_file: {
      desc: 'Write content to a file (creates directories if needed). Files must be inside an app subdirectory, not directly in the workdir root.',
      params: ['path', 'content'],
    },
    edit_file: {
      desc: "Edit an existing file by replacing text. Use write_file to create NEW files. Provide ONLY the new code with enough surrounding context (e.g., the function signature) so the tool can locate the right section using diff-based matching. Do NOT include old_string — it is NOT a valid parameter and will be ignored. The tool automatically finds the best match. IMPORTANT: If edit_file fails with 'Could not find a matching section', do NOT retry edit_file — use write_file() to rewrite the ENTIRE file instead.",
      params: ['path', 'file_path', 'new_string'],
    },
    list_files: {
      desc: 'List files and directories in a path',
      params: ['path'],
    },
    search_files: {
      desc: 'Search for patterns in files using regex',
      params: ['path', 'regex', 'file_pattern'],
    },
    execute_command: {
      desc: 'Run a shell command (10s timeout, 5s for run commands like node app.js). Automatically runs inside the current app directory if one has been created. Use cwd to override and run in a different app. Each call starts fresh — cd does NOT persist between calls. CLI/TUI apps (node app.js) will run and complete normally. Server commands (npm start, npm run dev) are blocked — tell the user the command to run instead.',
      params: ['command', 'cwd?'],
    },
    create_directory: {
      desc: 'Create a directory (and parent directories if needed)',
      params: ['path'],
    },
    delete_file: {
      desc: 'Delete a file or directory',
      params: ['path'],
    },
    search_npm_packages: {
      desc: 'Search the npm registry for packages matching a query. Returns a list of packages with name, description, version, and keywords. Use this INSTEAD of search_web() when you need to find npm packages — the npm registry has its own search that is more accurate and up-to-date than web search. Always use this tool before running npm install to verify a package exists and find the correct package name.',
      params: ['query'],
    },
    search_web: {
      desc: 'Search the web for information. Returns a list of results with titles, snippets, and URLs. Use this when you need current information, documentation, or answers not in your training data.',
      params: ['query'],
    },
    fetch_url: {
      desc: 'Fetch a URL and extract its main article content. Returns clean text with the title and body content, stripped of navigation, ads, and other boilerplate. Use this ONLY when the user explicitly asks for the full text of a specific article or page. Do NOT call fetch_url() on URLs returned by search_web() — search_web() already fetches article content and returns summaries. Automatically falls back to a real browser (Puppeteer) if the HTTP request gets blocked (403/401). For JavaScript-heavy pages, set useBrowser=true to force browser rendering.',
      params: ['url', 'useBrowser?'],
    },
    get_current_time: {
      desc: 'Get the current system date and/or time. Use format to request specific parts: "full" (default) for complete date+time+timezone, "date" for just the date, "time" for just the time, "day" for day of week, "month" for month name, "year" for the year, "timestamp" for Unix timestamp. Returns structured data with all fields regardless of format.',
      params: ['format?'],
    },
    test_app: {
      desc: 'Test the application by running it and checking for errors. Use this AFTER writing the source code to verify the app works. For apps that need command-line arguments, pass them in the "args" parameter (e.g., "London" for a weather app). Use cwd to specify which app directory to test when multiple apps exist. Returns the app output or any error messages.',
      params: ['args?', 'cwd?'],
    },
    finish: {
      desc: 'Call this when the task is complete',
      params: ['message'],
    },
  };
}
