/**
 * Tool call parser for Qwen models.
 *
 * Handles multiple formats:
 *
 * Qwen 2.5 Coder:
 *   ```json
 *   {"tool": "name", "arguments": {...}}
 *   ```
 *   or array:
 *   ```json
 *   [{"tool": "name", "arguments": {...}}, ...]
 *   ```
 *
 * Qwen 3.5:
 *   {"tool": "name", "arguments": {...}}
 *   (raw JSON, no markdown fences)
 *
 * Also handles mixed content where text and tool calls appear together.
 *
 * @typedef {Object} ToolCall
 * @property {string} tool - The tool name
 * @property {Object} arguments - The tool arguments
 */

/**
 * Parse tool calls from a model response string.
 * Returns an object with any text content and any tool calls found.
 *
 * @param {string} content - The raw response content from the model
 * @returns {{ text: string, toolCalls: ToolCall[] }}
 */
export function parseToolCalls(content) {
  if (!content || typeof content !== 'string') {
    return { text: '', toolCalls: [] };
  }

  const result = { text: '', toolCalls: [] };

  // Strategy 1: Try to find JSON in markdown code fences (Qwen 2.5 format)
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let match;
  let lastIndex = 0;
  let textParts = [];
  let foundInFence = false;

  while ((match = fenceRegex.exec(content)) !== null) {
    // Text before this fence
    const beforeText = content.slice(lastIndex, match.index).trim();
    if (beforeText) textParts.push(beforeText);

    const jsonStr = match[1].trim();
    const parsed = tryParseJson(jsonStr);
    if (parsed) {
      foundInFence = true;
      const calls = extractToolCalls(parsed);
      result.toolCalls.push(...calls);
    } else {
      // Not valid JSON in fence, treat as text
      textParts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last fence
  const remaining = content.slice(lastIndex).trim();
  if (remaining) textParts.push(remaining);

  // Strategy 2: If no fence-wrapped JSON found, try raw JSON (Qwen 3.5 format)
  if (!foundInFence) {
    // Reset and try to find raw JSON objects/arrays
    textParts = [];
    result.toolCalls = [];
    lastIndex = 0;

    // Match top-level JSON objects or arrays
    const jsonRegex = /(\{(?:[^{}]|(?:\{(?:[^{}]|(?:\{[^{}]*\}))*\}))*\}|\[(?:[^\[\]]|(?:\[(?:[^\[\]]|(?:\[[^\[\]]*\]))*\]))*\])/g;
    
    while ((match = jsonRegex.exec(content)) !== null) {
      const beforeText = content.slice(lastIndex, match.index).trim();
      if (beforeText) textParts.push(beforeText);

      const jsonStr = match[1];
      const parsed = tryParseJson(jsonStr);
      if (parsed) {
        const calls = extractToolCalls(parsed);
        if (calls.length > 0) {
          result.toolCalls.push(...calls);
        } else {
          // Valid JSON but not a tool call - treat as text
          textParts.push(match[0]);
        }
      } else {
        textParts.push(match[0]);
      }

      lastIndex = match.index + match[0].length;
    }

    const remaining2 = content.slice(lastIndex).trim();
    if (remaining2) textParts.push(remaining2);
  }

  result.text = textParts.join('\n').trim();
  return result;
}

/**
 * Try to parse a JSON string, returning null on failure.
 * @param {string} str
 * @returns {any|null}
 */
function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Extract tool calls from a parsed JSON value.
 * Handles both single object and array formats.
 *
 * @param {any} parsed
 * @returns {ToolCall[]}
 */
function extractToolCalls(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.flatMap(item => extractSingleToolCall(item)).filter(Boolean);
  }

  const single = extractSingleToolCall(parsed);
  return single ? [single] : [];
}

/**
 * Extract a single tool call from a parsed object.
 * Validates the structure has 'tool' and 'arguments' fields.
 *
 * @param {any} obj
 * @returns {ToolCall|null}
 */
function extractSingleToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.tool || typeof obj.tool !== 'string') return null;
  if (!obj.arguments || typeof obj.arguments !== 'object') return null;

  return {
    tool: obj.tool,
    arguments: obj.arguments,
  };
}

/**
 * Check if a string contains any tool call patterns.
 * Useful for quick detection before full parsing.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function containsToolCalls(content) {
  if (!content) return false;

  // Check for fence-wrapped JSON with tool property
  if (/```(?:json)?\s*\n?\s*[\{\[].*?"tool"\s*:/s.test(content)) return true;

  // Check for raw JSON with tool property
  if (/["']tool["']\s*:/s.test(content)) return true;

  return false;
}
