import { searchWeb } from './utils/search.js';

/**
 * Search the web for information.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createSearchWebHandler(engine) {
  return async ({ query }) => {
    if (!query) return { success: false, error: 'Missing required argument: query' };

    const result = await searchWeb(query, { debugMode: engine.config.debugMode === true });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      output: result.output,
      data: result.data,
    };
  };
}
