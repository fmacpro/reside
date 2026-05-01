import { execSync } from 'node:child_process';

/**
 * Search the npm registry for packages matching a query.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createSearchNpmHandler(engine) {
  return async ({ query }) => {
    if (!query) return { success: false, error: 'Missing required argument: query' };

    try {
      // Run npm search with a timeout. The output format is:
      // NAME | DESCRIPTION | AUTHOR | DATE | VERSION | KEYWORDS
      const result = execSync(`npm search "${query}" --json 2>/dev/null || npm search "${query}" 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });

      if (!result || !result.trim()) {
        return {
          success: true,
          output: `No packages found matching "${query}". Try a different search term.`,
          data: { query, packages: [] },
        };
      }

      // Try JSON format first (npm 10+ supports --json)
      let packages = [];
      try {
        const parsed = JSON.parse(result.trim());
        if (Array.isArray(parsed)) {
          packages = parsed.slice(0, 20).map(pkg => ({
            name: pkg.name || '',
            version: pkg.version || '',
            description: pkg.description || '',
            keywords: Array.isArray(pkg.keywords) ? pkg.keywords.join(', ') : (pkg.keywords || ''),
            date: pkg.date || '',
            author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || ''),
          }));
        }
      } catch {
        // Fallback: parse the table format
        // Format: NAME │ DESCRIPTION │ AUTHOR │ DATE │ VERSION │ KEYWORDS
        const lines = result.trim().split('\n').filter(l => l.trim() && !l.includes('───') && !l.includes('NAME │'));
        for (const line of lines.slice(0, 20)) {
          const parts = line.split('│').map(p => p.trim());
          if (parts.length >= 5) {
            packages.push({
              name: parts[0] || '',
              version: parts[4] || '',
              description: parts[1] || '',
              keywords: parts[5] || '',
              date: parts[3] || '',
              author: parts[2] || '',
            });
          }
        }
      }

      if (packages.length === 0) {
        return {
          success: true,
          output: `No packages found matching "${query}". Try a different search term.`,
          data: { query, packages: [] },
        };
      }

      // Format the output for the LLM
      const output = packages.map((pkg, i) => {
        let entry = `${i + 1}. **${pkg.name}** v${pkg.version}`;
        if (pkg.description) entry += ` — ${pkg.description}`;
        if (pkg.keywords) entry += `\n   Keywords: ${pkg.keywords}`;
        if (pkg.date) entry += `\n   Updated: ${pkg.date}`;
        return entry;
      }).join('\n\n');

      return {
        success: true,
        output: `Found ${packages.length} package(s) matching "${query}":\n\n${output}\n\nTo install a package, use: npm install <package-name> (with cwd set to your app directory).`,
        data: { query, packages, count: packages.length },
      };
    } catch (err) {
      // npm search may fail if the npm registry is unreachable or npm is not installed
      return {
        success: false,
        error: `npm search failed: ${err.message}. You can also try fetch_url({"url":"https://www.npmjs.com/search?q=${encodeURIComponent(query)}"}) to search npmjs.com directly.`,
      };
    }
  };
}
