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

    // First, try parsing the ENTIRE content as a single JSON value.
    // This handles cases where the LLM outputs nothing but a JSON object
    // or array with deeply nested content strings (e.g., write_file with
    // JS code containing many levels of braces that would break the regex).
    //
    // IMPORTANT: Only use JSON.parse directly here, NOT tryParseJson.
    // tryParseJson uses tryParseWithTrailingGarbage which returns early
    // when it finds the first balanced JSON structure. For content with
    // multiple JSON objects separated by newlines (e.g., two tool calls),
    // this would only capture the first one. The regex fallback below
    // handles multiple JSON objects correctly.
    const trimmedContent = content.trim();
    if (trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) {
      try {
        const fullParsed = JSON.parse(trimmedContent);
        if (fullParsed) {
          const calls = extractToolCalls(fullParsed);
          if (calls.length > 0) {
            result.toolCalls.push(...calls);
            result.text = '';
            return result;
          }
        }
      } catch {
        // Not valid JSON as a whole — fall through to regex-based extraction
      }
    }

    // Fallback: Match top-level JSON objects or arrays using regex.
    // This regex handles up to 3 levels of nesting, which is sufficient
    // for most tool calls (e.g., write_file with simple content).
    // For deeply nested content, the full-content parse above handles it.
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
 * First attempts standard JSON.parse, then tries to repair common LLM mistakes.
 *
 * Also handles trailing garbage after valid JSON (e.g., extra `}` or `]`
 * that the regex captured). It progressively trims trailing characters
 * that would make JSON invalid.
 *
 * @param {string} str
 * @returns {any|null}
 */
function tryParseJson(str) {
  if (!str || typeof str !== 'string') return null;

  // First attempt: standard JSON.parse
  try {
    return JSON.parse(str);
  } catch {
    // Fall through to repair attempts
  }

  // Second attempt: handle trailing garbage after valid JSON.
  // The regex may capture extra characters like `}}}]` when the LLM
  // outputs malformed JSON with extra braces. We progressively trim
  // trailing characters that would make JSON invalid.
  const trimmed = tryParseWithTrailingGarbage(str);
  if (trimmed !== null) return trimmed;

  // Third attempt: repair common LLM JSON mistakes
  const repaired = repairJson(str);
  if (repaired !== null) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Also try with trailing garbage handling on the repaired string
      return tryParseWithTrailingGarbage(repaired);
    }
  }

  return null;
}

/**
 * Try to parse JSON by extracting the valid portion using brace/bracket
 * matching. This handles cases where the regex captured extra trailing
 * characters like an extra `}` before `]` (e.g., `...}}}]` instead of
 * `...}}]`).
 *
 * Strategy: walk through the string character by character, tracking
 * brace/bracket depth and respecting string boundaries. Build the valid
 * JSON string by only including characters that contribute to balanced
 * braces/brackets. Extra closing braces/brackets (when depth is 0) are
 * excluded from the result.
 *
 * @param {string} str
 * @returns {any|null}
 */
function tryParseWithTrailingGarbage(str) {
  if (!str) return null;

  // Find the start of the JSON structure
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{' || ch === '[') {
      start = i;
      break;
    }
    // Skip leading whitespace
    if (!/\s/.test(ch)) break;
  }
  if (start === -1) return null;

  // Walk forward from start, building valid JSON by tracking depth.
  // Extra closing braces/brackets (when depth is 0) are excluded.
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  let result = '';

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      result += ch;
    } else if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
        result += ch;
        if (braceDepth === 0 && bracketDepth === 0) {
          // Successfully parsed valid JSON
          try {
            return JSON.parse(result);
          } catch {
            // Even though depth is 0, JSON is invalid — continue
            // looking for a longer valid match
          }
        }
      }
      // If braceDepth is 0, this is an extra closing brace — skip it
    } else if (ch === '[') {
      bracketDepth++;
      result += ch;
    } else if (ch === ']') {
      if (bracketDepth > 0) {
        bracketDepth--;
        result += ch;
        if (braceDepth === 0 && bracketDepth === 0) {
          try {
            return JSON.parse(result);
          } catch {
            // Continue looking
          }
        }
      }
      // If bracketDepth is 0, this is an extra closing bracket — skip it
    } else {
      result += ch;
    }
  }

  return null;
}

/**
 * Attempt to repair common JSON mistakes made by LLMs.
 *
 * Common issues:
 * 1. Template literals (backtick strings) used instead of JSON strings
 *    e.g., {"content": `const x = ${y};`} — backticks and ${} are NOT valid JSON
 * 2. Trailing commas in objects/arrays
 * 3. Single quotes instead of double quotes for property names/string values
 * 4. Missing quotes around property names
 *
 * Strategy: extract the JSON structure, find backtick-delimited values,
 * and convert them to properly escaped JSON strings.
 *
 * @param {string} str
 * @returns {string|null}
 */
function repairJson(str) {
  if (!str || typeof str !== 'string') return null;

  let result = str;

  // Fix 1: Replace single quotes with double quotes for property names
  // e.g., {'tool': 'value'} -> {"tool": "value"}
  // But be careful not to break apostrophes inside strings
  result = result.replace(/'/g, '"');

  // Fix 2: Remove trailing commas before closing braces/brackets
  result = result.replace(/,(\s*[}\]])/g, '$1');

  // Fix 3: Handle template literals (backtick strings) in JSON values.
  // The LLM often outputs something like:
  //   {"tool": "write_file", "arguments": {"path": "x", "content": `code here`}}
  // This is invalid JSON because backticks are not valid string delimiters.
  //
  // Strategy: Find backtick-delimited values and convert them to JSON strings.
  // We need to handle:
  //   - Simple backtick strings: `hello` -> "hello"
  //   - Multi-line backtick strings: `line1\nline2` -> "line1\nline2"
  //   - Backtick strings with ${} interpolation: `${x}` -> must escape the ${
  //
  // The approach: find the outermost JSON object structure, then within it,
  // replace backtick-delimited sections with properly escaped double-quoted strings.

  // First, check if there are backtick strings that need conversion
  if (result.includes('`')) {
    // We need to be smart about this. The structure is typically:
    // {"tool": "name", "arguments": {"key": `value`}}
    // We'll convert backtick-delimited content to JSON strings.
    
    // Find all backtick-delimited sections and replace them
    // A backtick string starts after a colon+space and ends before a comma, brace, or bracket
    // But multi-line backtick strings can contain anything including commas and braces.
    // So we need to match balanced backticks.
    
    let backtickResult = '';
    let i = 0;
    let inBacktick = false;
    let backtickStart = -1;
    
    while (i < result.length) {
      const ch = result[i];
      if (ch === '`' && !inBacktick) {
        inBacktick = true;
        backtickStart = i;
        i++;
      } else if (ch === '`' && inBacktick) {
        // End of backtick string
        const rawContent = result.slice(backtickStart + 1, i);
        // Escape the content for JSON: escape backslashes, double quotes, newlines, tabs
        let escaped = rawContent
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        // Note: ${} is valid inside a JSON string value, so we do NOT escape it.
        // The only issue was the backtick delimiter, which we're converting to double quotes.
        // Escaping $ would produce \$ which is NOT a valid JSON escape sequence.
        backtickResult += '"' + escaped + '"';
        inBacktick = false;
        i++;
      } else if (inBacktick) {
        // Skip characters inside backtick — they'll be captured by slice above
        i++;
      } else {
        backtickResult += ch;
        i++;
      }
    }
    
    if (!inBacktick) {
      result = backtickResult;
    }
    // If we're still in a backtick (unclosed), return null — can't repair
  }

  return result;
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
/**
 * Map of tool names to their expected single string argument name.
 * Some models (like Gemma3) output "arguments" as a plain string
 * instead of an object, e.g.:
 *   {"tool": "search_web", "arguments": "current price of bitcoin"}
 * instead of:
 *   {"tool": "search_web", "arguments": {"query": "current price of bitcoin"}}
 *
 * This map tells us which argument name to use when converting
 * a string arguments value to the proper object format.
 */
const TOOL_STRING_ARG_MAP = {
  search_web: 'query',
  fetch_url: 'url',
  read_file: 'path',
  write_file: 'path',
  edit_file: 'file_path',
  list_files: 'path',
  search_files: 'path',
  create_directory: 'path',
  delete_file: 'path',
  execute_command: 'command',
  get_current_time: 'format',
  test_app: 'args',
  finish: 'message',
};

function extractSingleToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.tool || typeof obj.tool !== 'string') return null;

  // Handle case where "arguments" is a plain string instead of an object.
  // Some models (e.g., Gemma3) output:
  //   {"tool": "search_web", "arguments": "current price of bitcoin"}
  // We convert this to the proper object format based on the tool name.
  if (typeof obj.arguments === 'string') {
    const argName = TOOL_STRING_ARG_MAP[obj.tool];
    if (argName) {
      obj.arguments = { [argName]: obj.arguments };
    } else {
      // Unknown tool with string arguments — can't convert, reject
      return null;
    }
  }

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
