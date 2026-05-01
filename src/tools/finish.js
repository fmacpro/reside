/**
 * Call this when the task is complete.
 * @param {import('./index.js').ToolEngine} engine - The ToolEngine instance
 * @returns {Function} Handler function
 */
export function createFinishHandler(engine) {
  return async ({ message = 'Task completed' }) => {
    return {
      success: true,
      output: message,
      data: { finished: true, message },
    };
  };
}
