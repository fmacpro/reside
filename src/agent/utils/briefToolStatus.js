/**
 * Generate a brief one-line status for a successful tool execution result.
 * Instead of dumping raw output, this provides a concise summary per tool type.
 *
 * @param {string} tool - The tool name
 * @param {string} output - The full output from the tool
 * @param {object} [data] - Optional structured data from the tool result
 * @returns {string} A brief status string
 */
export function briefToolStatus(tool, output, data) {
  if (!output) return '(completed)';

  switch (tool) {
    case 'search_npm_packages': {
      const pkgCount = data?.count || data?.packages?.length || 0;
      const label = pkgCount === 1 ? 'package' : 'packages';
      return `Found ${pkgCount} ${label}`;
    }
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
      const fromCache = data?.fromCache ? ' (from search_web cache)' : '';
      return `Extracted content (${charCount} chars${fromCache})`;
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
