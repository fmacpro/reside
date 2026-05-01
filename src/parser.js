/**
 * Tool call parser for Qwen and DeepSeek models.
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
 * DeepSeek (XML-like with Unicode delimiters):
 *   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>tool_name
 *   <｜tool▁sep｜>arg_name
 *   <｜tool▁sep｜>arg_value
 *   <｜tool▁call▁end｜><｜tool▁calls▁end｜>
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
    //
    // However, we DO attempt repairJson first if JSON.parse fails, since
    // the LLM may output raw backticks or invalid escape sequences inside
    // JSON string values (e.g., JavaScript template literals in code content).
    // repairJson handles these cases without the early-return issue of
    // tryParseWithTrailingGarbage.
    //
    // Also handles cases where the content starts with text before the JSON
    // (e.g., "I can see the issue...\n\n{"tool": "edit_file", ...}").
    // In this case, we find the first '{' or '[' and try parsing from there.
    const trimmedContent = content.trim();
    
    // Find the start of the first JSON structure (may be after text)
    let jsonStartIdx = -1;
    for (let i = 0; i < trimmedContent.length; i++) {
      const ch = trimmedContent[i];
      if (ch === '{' || ch === '[') {
        jsonStartIdx = i;
        break;
      }
    }
    
    if (jsonStartIdx >= 0) {
      const jsonContent = trimmedContent.substring(jsonStartIdx);
      // Try direct JSON.parse first
      let fullParsed = null;
      try {
        fullParsed = JSON.parse(jsonContent);
      } catch {
        // Direct parse failed — try repairing common LLM mistakes
        const repaired = repairJson(jsonContent);
        if (repaired !== null) {
          try {
            fullParsed = JSON.parse(repaired);
          } catch {
            // Repair didn't help either — fall through
          }
        }
      }
      
      if (fullParsed) {
        const calls = extractToolCalls(fullParsed);
        if (calls.length > 0) {
          result.toolCalls.push(...calls);
          // Any text before the JSON is the text response
          result.text = trimmedContent.substring(0, jsonStartIdx).trim();
          return result;
        }
        
        // If the full content parsed as valid JSON but extractToolCalls returned
        // no results (e.g., the JSON is an array of objects without "tool" property,
        // or a single object without valid tool structure), don't return early.
        // Fall through to the regex fallback below which may find tool calls
        // embedded in text content.
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

  // Strategy 3: DeepSeek XML-like format with Unicode delimiters
  // Format: <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>tool_name
  //         <｜tool▁sep｜>arg_name
  //         <｜tool▁sep｜>arg_value
  //         <｜tool▁call▁end｜><｜tool▁calls▁end｜>
  //
  // Also handles hybrid format where the tool name is in XML tags and
  // arguments are in a JSON fence inside the block:
  //   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>tool_name
  //   ```json
  //   {"key": "value"}
  //   ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
  if (result.toolCalls.length === 0) {
    const deepseekCalls = parseDeepSeekToolCalls(content);
    if (deepseekCalls.length > 0) {
      result.toolCalls.push(...deepseekCalls);
      // Extract text before/after the DeepSeek tags
      const deepseekTagRegex = /<｜tool▁calls▁begin｜>[\s\S]*?<｜tool▁calls▁end｜>/g;
      let lastIdx = 0;
      const textParts2 = [];
      let match;
      while ((match = deepseekTagRegex.exec(content)) !== null) {
        const beforeText = content.slice(lastIdx, match.index).trim();
        if (beforeText) textParts2.push(beforeText);
        lastIdx = match.index + match[0].length;
      }
      const remaining = content.slice(lastIdx).trim();
      if (remaining) textParts2.push(remaining);
      result.text = textParts2.join('\n').trim();
      return result;
    }
  }

  result.text = textParts.join('\n').trim();
  return result;
}

/**
 * Parse DeepSeek XML-like tool call format with Unicode delimiters.
 *
 * Format:
 *   <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>tool_name
 *   <｜tool▁sep｜>arg_name
 *   <｜tool▁sep｜>arg_value
 *   <｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * The Unicode characters used as delimiters:
 *   ｜ = U+FF5C (Fullwidth Vertical Line)
 *   ▁ = U+2581 (Lower One Eighth Block)
 *
 * @param {string} content - The raw response content
 * @returns {ToolCall[]}
 */
function parseDeepSeekToolCalls(content) {
  if (!content || typeof content !== 'string') return [];
  if (!content.includes('<｜tool▁calls▁begin｜>')) return [];

  const toolCalls = [];

  // Regex to find each tool call block between <｜tool▁call▁begin｜> and <｜tool▁call▁end｜>
  const toolCallRegex = /<｜tool▁call▁begin｜>([\s\S]*?)<｜tool▁call▁end｜>/g;
  let match;

  while ((match = toolCallRegex.exec(content)) !== null) {
    const block = match[1].trim();

    // Parse the block: first line should be "function<｜tool▁sep｜>tool_name"
    // Subsequent lines are either:
    //   - JSON fence with arguments: ```json\n{"key": "value"}\n```
    //   - Key-value pairs separated by <｜tool▁sep｜>
    const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length === 0) continue;

    // First line: function<｜tool▁sep｜>tool_name
    const firstLine = lines[0];
    const functionMatch = firstLine.match(/^function<｜tool▁sep｜>(.+)$/);
    if (!functionMatch) continue;

    const toolName = functionMatch[1].trim();
    if (!toolName) continue;

    // Check if the remaining block contains a JSON fence with arguments
    // DeepSeek sometimes uses a hybrid format:
    //   function<｜tool▁sep｜>tool_name
    //   ```json
    //   {"key": "value"}
    //   ```
    const remainingBlock = lines.slice(1).join('\n');
    const jsonFenceMatch = remainingBlock.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    let args = {};

    if (jsonFenceMatch) {
      // Try to parse the JSON fence content as arguments
      const jsonStr = jsonFenceMatch[1].trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed;
        }
      } catch {
        // JSON parse failed — try repair
        const repaired = tryParseJson(jsonStr);
        if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
          args = repaired;
        }
      }
    }

    // If no JSON fence found or it didn't yield args, fall back to <｜tool▁sep｜> key-value parsing
    if (Object.keys(args).length === 0) {
      // Remaining lines: key-value pairs in one of two formats:
      // Format A: <｜tool▁sep｜>key<｜tool▁sep｜>value (key and value on same line)
      // Format B: <｜tool▁sep｜>key\n<｜tool▁sep｜>value (key and value on separate lines, alternating)
      // Format C: <｜tool▁sep｜>key\n<｜tool▁sep｜>value\nvalue_cont (multi-line value, continuation lines without <｜tool▁sep｜>)
      let currentKey = null;
      let currentValue = null;
      let expectingValue = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Skip lines that are part of a JSON fence
        if (line.startsWith('```')) continue;

        // Check if this line starts with <｜tool▁sep｜>
        const sepMatch = line.match(/^<｜tool▁sep｜>(.+)$/);
        if (sepMatch) {
          const rest = sepMatch[1].trim();

          if (expectingValue) {
            // We're expecting a value for the current key
            // Check if this line has a second <｜tool▁sep｜> (key<｜tool▁sep｜>value on same line)
            const secondSepIdx = rest.indexOf('<｜tool▁sep｜>');
            if (secondSepIdx >= 0) {
              // This is key<｜tool▁sep｜>value on same line — save previous key and start new one
              if (currentKey !== null && currentValue !== null) {
                args[currentKey] = currentValue;
              }
              currentKey = rest.substring(0, secondSepIdx).trim();
              currentValue = rest.substring(secondSepIdx + '<｜tool▁sep｜>'.length).trim();
              expectingValue = false;
            } else {
              // This is the value for the current key (Format B: key and value on separate lines)
              if (currentValue) currentValue += '\n';
              currentValue += rest;
              // After getting a value, we expect the next <｜tool▁sep｜> line to be a key
              expectingValue = false;
            }
          } else {
            // We're expecting a key
            // If we have a pending key-value pair, save it
            if (currentKey !== null && currentValue !== null) {
              args[currentKey] = currentValue;
            }

            // Check if this line has a second <｜tool▁sep｜> (key<｜tool▁sep｜>value on same line)
            const secondSepIdx = rest.indexOf('<｜tool▁sep｜>');
            if (secondSepIdx >= 0) {
              // key<｜tool▁sep｜>value on same line (Format A)
              currentKey = rest.substring(0, secondSepIdx).trim();
              currentValue = rest.substring(secondSepIdx + '<｜tool▁sep｜>'.length).trim();
              expectingValue = false;
            } else {
              // Just a key, value follows on next line (Format B)
              currentKey = rest;
              currentValue = '';
              expectingValue = true;
            }
          }
        } else {
          // Continuation of the current value (multi-line value without <｜tool▁sep｜> prefix)
          if (currentKey !== null) {
            if (currentValue) currentValue += '\n';
            currentValue += line;
          }
        }
      }

      // Save the last key-value pair
      if (currentKey !== null && currentValue !== null) {
        args[currentKey] = currentValue;
      }
    }

    if (Object.keys(args).length > 0 || toolName) {
      toolCalls.push({
        tool: toolName,
        arguments: args,
      });
    }
  }

  return toolCalls;
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
 * 5. Invalid escape sequences inside JSON strings (e.g., \` and \$)
 *    The LLM sometimes outputs JavaScript template literal escapes inside
 *    JSON string values, like:
 *      {"content": "reject(new Error(\`API failed with status \${code}\`));"}
 *    Here \` and \$ are NOT valid JSON escape sequences.
 * 6. Unescaped control characters (literal newlines, tabs, etc.) inside
 *    JSON string values. The LLM may output actual newline characters
 *    inside JSON string values instead of escaping them as \n.
 *    e.g., {"content": "line1\nline2"} instead of {"content": "line1\\nline2"}
 * 7. Unescaped double quotes inside JSON string values. The LLM sometimes
 *    outputs code content with unescaped double quotes, like:
 *      {"content": "console.log("Hello");"}
 *    instead of:
 *      {"content": "console.log(\"Hello\");"}
 *    This happens when the LLM generates JSON with JavaScript/HTML code
 *    that contains double quotes, but forgets to escape them.
 *
 * Strategy: extract the JSON structure, find backtick-delimited values,
 * and convert them to properly escaped JSON strings. Then fix invalid
 * escape sequences inside regular JSON strings. Then escape any
 * unescaped control characters inside JSON strings. Finally, detect and
 * escape unescaped double quotes inside JSON string values.
 *
 * @param {string} str
 * @returns {string|null}
 */
function repairJson(str) {
  if (!str || typeof str !== 'string') return null;

  let result = str;

  // Fix 1: Replace single quotes with double quotes, but ONLY for single quotes
  // that are used as JSON string delimiters (outside double-quoted JSON strings).
  // Single quotes INSIDE double-quoted JSON string values (e.g., in JavaScript code
  // content like "import https from 'https'") must NOT be converted, as that would
  // introduce unescaped double quotes that break the JSON structure.
  //
  // Strategy: Walk through the string tracking whether we're inside a double-quoted
  // JSON string. Only replace single quotes found OUTSIDE double-quoted strings.
  {
    let fixedResult = '';
    let inJsonString = false;
    let escape = false;
    
    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      
      if (escape) {
        escape = false;
        fixedResult += ch;
        continue;
      }
      
      if (ch === '\\' && inJsonString) {
        escape = true;
        fixedResult += ch;
        continue;
      }
      
      if (ch === '"') {
        inJsonString = !inJsonString;
        fixedResult += ch;
        continue;
      }
      
      if (ch === "'" && !inJsonString) {
        // Single quote outside a JSON string — convert to double quote
        fixedResult += '"';
        continue;
      }
      
      fixedResult += ch;
    }
    
    result = fixedResult;
  }

  // Fix 2: Remove trailing commas before closing braces/brackets
  result = result.replace(/,(\s*[}\]])/g, '$1');

  // Fix 3: Handle template literals (backtick strings) in JSON values.
  // The LLM often outputs something like:
  //   {"tool": "write_file", "arguments": {"path": "x", "content": `code here`}}
  // This is invalid JSON because backticks are not valid string delimiters.
  //
  // However, backticks can ALSO appear INSIDE double-quoted JSON string values
  // when the LLM includes JavaScript template literals in code content:
  //   {"content": "reject(new Error(`API failed with status ${code}`));"}
  // In this case, the backticks are literal characters inside a JSON string,
  // NOT JSON string delimiters.
  //
  // Strategy: Walk through the string tracking whether we're inside a
  // double-quoted JSON string. Backticks found OUTSIDE double-quoted strings
  // are treated as JSON string delimiters and converted to double-quoted strings.
  // Backticks found INSIDE double-quoted strings are escaped as \` to make
  // them valid JSON.

  // First, check if there are backtick strings that need conversion
  if (result.includes('`')) {
    let backtickResult = '';
    let i = 0;
    let inBacktick = false;
    let backtickStart = -1;
    let inJsonString = false;
    let escape = false;
    
    while (i < result.length) {
      const ch = result[i];
      
      // Track whether we're inside a double-quoted JSON string
      if (!inBacktick) {
        if (escape) {
          escape = false;
        } else if (ch === '\\' && inJsonString) {
          escape = true;
        } else if (ch === '"' && !inJsonString) {
          inJsonString = true;
        } else if (ch === '"' && inJsonString) {
          inJsonString = false;
        }
      }
      
      if (ch === '`' && !inBacktick && !inJsonString) {
        // Backtick found OUTSIDE a JSON string — treat as JSON string delimiter
        inBacktick = true;
        backtickStart = i;
        i++;
      } else if (ch === '`' && inBacktick) {
        // End of backtick-delimited string
        const rawContent = result.slice(backtickStart + 1, i);
        // Escape the content for JSON: escape backslashes, double quotes, newlines, tabs
        let escaped = rawContent
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        // Note: ${} is valid inside a JSON string value, so we do NOT escape it.
        backtickResult += '"' + escaped + '"';
        inBacktick = false;
        i++;
      } else if (ch === '`' && !inBacktick && inJsonString) {
        // Backtick found INSIDE a JSON string — escape it as \`
        backtickResult += '\\`';
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

  // Fix 4: Fix invalid escape sequences inside JSON strings.
  // The LLM sometimes outputs JavaScript template literal escapes inside
  // JSON string values, like:
  //   {"content": "reject(new Error(\`API failed with status \${code}\`));"}
  // Here \` (escaped backtick) and \$ (escaped dollar sign) are NOT valid
  // JSON escape sequences. JSON only allows: \" \\ \/ \b \f \n \r \t \uXXXX
  //
  // Strategy: Walk through the string character by character, tracking
  // when we're inside a JSON string (between double quotes). When we find
  // a backslash followed by an invalid escape character (like ` or $),
  // remove the backslash to produce the literal character.
  //
  // Valid JSON escape sequences:
  //   \" \\ \/ \b \f \n \r \t \uXXXX
  const VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  
  let fixedResult = '';
  let inString = false;
  let escape = false;
  
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    
    if (escape) {
      // We're after a backslash inside a string
      escape = false;
      if (inString && !VALID_ESCAPES.has(ch)) {
        // Invalid escape sequence — remove the backslash, keep the character
        // e.g., \` -> `, \$ -> $
        fixedResult += ch;
      } else {
        // Valid escape — keep both backslash and character
        fixedResult += '\\' + ch;
      }
      continue;
    }
    
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    
    if (ch === '"' && !escape) {
      inString = !inString;
    }
    
    fixedResult += ch;
  }
  
  // If we were in an escape sequence at the end, add the backslash back
  if (escape) {
    fixedResult += '\\';
  }
  
  result = fixedResult;

  // Fix 4.5: Fix double-escaped newlines and other escape sequences.
  // The LLM sometimes outputs \\n (escaped backslash + n) instead of \n
  // (actual newline) inside JSON string values. For example:
  //   {"content": "line1\\nline2"}
  // instead of:
  //   {"content": "line1\nline2"}
  //
  // In JSON, \\n means a literal backslash followed by 'n' (two characters).
  // But the LLM intended it to be a newline character. We detect this by
  // looking for \\n, \\t, \\r inside JSON strings and converting them to
  // actual newlines/tabs/carriage returns (which will then be re-escaped
  // by Fix 5 below).
  //
  // Strategy: Walk through the string tracking whether we're inside a JSON
  // string. When we find \\n, \\t, or \\r (escaped backslash + n/t/r),
  // replace with the actual control character.
  {
    let fixedResult = '';
    let inStr = false;
    let esc = false;
    
    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      
      if (esc) {
        esc = false;
        // We found a backslash followed by another character.
        // Check if this is \\n, \\t, or \\r (double-escaped control char).
        if (inStr && ch === 'n') {
          fixedResult += '\n'; // Actual newline
        } else if (inStr && ch === 't') {
          fixedResult += '\t'; // Actual tab
        } else if (inStr && ch === 'r') {
          fixedResult += '\r'; // Actual carriage return
        } else {
          fixedResult += '\\' + ch;
        }
        continue;
      }
      
      if (ch === '\\' && inStr) {
        esc = true;
        continue;
      }
      
      if (ch === '"') {
        inStr = !inStr;
      }
      
      fixedResult += ch;
    }
    
    // If we were in an escape sequence at the end, add the backslash back
    if (esc) {
      fixedResult += '\\';
    }
    
    result = fixedResult;
  }

  // Fix 5: Escape unescaped control characters inside JSON strings.
  // The LLM sometimes outputs literal newlines, tabs, carriage returns, etc.
  // inside JSON string values instead of escaping them. For example:
  //   {"content": "line1
  //   line2"}
  // instead of:
  //   {"content": "line1\nline2"}
  //
  // JSON does not allow literal control characters (U+0000-U+001F) inside
  // string values. They must be escaped as \n, \t, \r, etc.
  //
  // Strategy: Walk through the string character by character, tracking
  // when we're inside a JSON string (between double quotes). When we find
  // a control character (code < 32, excluding \t which is allowed in some
  // contexts), escape it as the appropriate JSON escape sequence.
  {
    let escapedResult = '';
    let inStr = false;
    let esc = false;
    
    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      
      if (esc) {
        esc = false;
        escapedResult += ch;
        continue;
      }
      
      if (ch === '\\' && inStr) {
        esc = true;
        escapedResult += ch;
        continue;
      }
      
      if (ch === '"') {
        inStr = !inStr;
        escapedResult += ch;
        continue;
      }
      
      if (inStr) {
        const code = ch.charCodeAt(0);
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
          // Other control characters — escape as \uXXXX
          escapedResult += '\\u' + code.toString(16).padStart(4, '0');
          continue;
        } else if (code === 10) {
          // Newline — escape as \n
          escapedResult += '\\n';
          continue;
        } else if (code === 13) {
          // Carriage return — escape as \r
          escapedResult += '\\r';
          continue;
        } else if (code === 9) {
          // Tab — escape as \t
          escapedResult += '\\t';
          continue;
        }
      }
      
      escapedResult += ch;
    }
    
    result = escapedResult;
  }

  // Fix 6: Escape unescaped double quotes inside JSON string values.
  // The LLM sometimes outputs code content with unescaped double quotes,
  // like:
  //   {"content": "console.log("Hello");"}
  // instead of:
  //   {"content": "console.log(\"Hello\");"}
  //
  // Strategy: Walk through the string tracking whether we're inside a
  // JSON string. When we encounter a '"' that would close a string, check
  // if the next non-whitespace character suggests this is actually content
  // (e.g., followed by a letter/digit and then another '"'). If so, escape
  // the '"' as '\"' instead of treating it as a string delimiter.
  //
  // In valid JSON, after a '"' that closes a string value, the next
  // meaningful character should be one of: , } ] : or whitespace.
  // If it's a letter, digit, or other content character, the '"' is
  // likely part of the content and should be escaped.
  {
    let fixedResult = '';
    let inStr = false;
    let esc = false;
    
    for (let i = 0; i < result.length; i++) {
      const ch = result[i];
      
      if (esc) {
        esc = false;
        fixedResult += ch;
        continue;
      }
      
      if (ch === '\\' && inStr) {
        esc = true;
        fixedResult += ch;
        continue;
      }
      
      if (ch === '"') {
        if (inStr) {
          // We're inside a string and found a '"' that would close it.
          // Look ahead to see if this is actually content.
          // Find the next non-whitespace character.
          let nextNonWs = '';
          for (let j = i + 1; j < result.length; j++) {
            const nc = result[j];
            if (!/\s/.test(nc)) {
              nextNonWs = nc;
              break;
            }
          }
          
          // If the next non-whitespace char is a letter, digit, or other
          // content character (not a valid JSON structural character),
          // this '"' is likely unescaped content — escape it.
          // Valid JSON structural chars after a string value: , } ] :
          if (nextNonWs && !',}]::'.includes(nextNonWs) && nextNonWs !== '') {
            // This '"' is likely unescaped content — escape it
            fixedResult += '\\"';
            continue;
          }
        }
        inStr = !inStr;
        fixedResult += ch;
        continue;
      }
      
      fixedResult += ch;
    }
    
    result = fixedResult;
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

  // Check for DeepSeek XML-like format with Unicode delimiters
  if (content.includes('<｜tool▁calls▁begin｜>')) return true;

  return false;
}
