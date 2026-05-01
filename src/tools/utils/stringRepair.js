/**
 * Split content into segments: template literal parts and non-template-literal parts.
 * Template literals are delimited by backticks (`...`).
 * We need to handle nested backticks inside ${} expressions.
 * @param {string} str
 * @returns {Array<{type: string, content: string}>}
 */
export function splitIntoSegments(str) {
  const segments = [];
  let i = 0;
  let current = '';

  while (i < str.length) {
    if (str[i] === '`') {
      // Start of a template literal — flush current non-template segment
      if (current) {
        segments.push({ type: 'code', content: current });
        current = '';
      }
      // Find the matching closing backtick, accounting for ${...} nesting
      let j = i + 1;
      let tplDepth = 0;
      let newlineCount = 0;
      let mismatched = false;
      while (j < str.length) {
        if (str[j] === '`' && tplDepth === 0) {
          break;
        } else if (str[j] === '$' && j + 1 < str.length && str[j + 1] === '{') {
          tplDepth++;
          j += 2;
        } else if (str[j] === '}' && tplDepth > 0) {
          tplDepth--;
          j++;
        } else {
          if (str[j] === '\n') newlineCount++;
          // Safety: if a template literal spans more than 20 lines, it's likely
          // a mismatched quote (e.g., the LLM wrote `... with a " instead of `).
          // Treat the opening backtick as a regular character and continue.
          if (newlineCount > 20) {
            mismatched = true;
            break;
          }
          j++;
        }
      }
      if (mismatched) {
        // Treat the opening backtick as a regular character
        current += '`';
        i++;
      } else if (j < str.length && str[j] === '`') {
        // Found a closing backtick — create template segment
        const tplContent = str.slice(i, j + 1);
        segments.push({ type: 'template', content: tplContent });
        i = j + 1;
      } else {
        // No closing backtick found — treat as regular character
        current += '`';
        i++;
      }
    } else {
      current += str[i];
      i++;
    }
  }
  if (current) {
    segments.push({ type: 'code', content: current });
  }
  return segments;
}

/**
 * For double-quoted strings: match "..." and replace \n inside with \\n
 * @param {string} str
 * @returns {string}
 */
export function fixDouble(str) {
  return str.replace(/"([^"]*)"/g, (m) => m.replace(/\n/g, '\\n'));
}

/**
 * For single-quoted strings: match '...' and replace \n inside with \\n
 * @param {string} str
 * @returns {string}
 */
export function fixSingle(str) {
  return str.replace(/'([^']*)'/g, (m) => m.replace(/\n/g, '\\n'));
}

/**
 * For template literals: only repair when the continuation starts with a backtick
 * (indicating a broken template literal, not a legitimate multi-line one).
 * Legitimate multi-line template literals (with actual newlines) should NOT be repaired.
 * @param {string} str
 * @returns {string}
 */
export function fixTemplate(str) {
  return str.replace(/(`[^`\n]*?)\n(\s*`[^`\n]*)/g, (m, b, a) =>
    a.trimStart().startsWith('`') ? b + '\\n' + a.trimStart() : m
  );
}

/**
 * Repair broken JavaScript string literals that were broken by JSON parsing.
 * When the LLM writes code like: console.log("Adding a fish...\n");
 * the \n in the JSON string value gets parsed as an actual newline character.
 * This results in a broken JavaScript file with a literal newline inside a string.
 *
 * @param {string} content - The file content to repair
 * @param {string} path - File path (used to determine if it's a JS file)
 * @param {object} [options]
 * @param {boolean} [options.debugMode] - Whether to log debug messages
 * @returns {string} The repaired content
 */
export function repairStringLiterals(content, path, options = {}) {
  let fixedContent = String(content);
  if (!/\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(path)) {
    return fixedContent;
  }

  // Apply repairs iteratively until stable
  let prev;
  do {
    prev = fixedContent;

    // Split into segments, apply fixSingle/fixDouble only to code segments
    const segments = splitIntoSegments(fixedContent);
    let rebuilt = '';
    for (const seg of segments) {
      if (seg.type === 'template') {
        rebuilt += seg.content; // Template literals are left untouched
      } else {
        let code = seg.content;
        code = fixDouble(code);
        code = fixSingle(code);
        rebuilt += code;
      }
    }
    fixedContent = rebuilt;

    // Apply fixTemplate on the whole content (it only matches broken template literals)
    fixedContent = fixTemplate(fixedContent);
  } while (fixedContent !== prev);

  // Detect and AUTO-FIX template literal syntax used inside regular strings.
  // The LLM often writes `${variable}` inside double-quoted or single-quoted strings,
  // which prints the literal text "${variable}" instead of the variable value.
  const segments = splitIntoSegments(fixedContent);
  let hasTemplateLiteralBug = false;
  let rebuilt = '';
  for (const seg of segments) {
    if (seg.type === 'template') {
      rebuilt += seg.content;
    } else {
      const templateLiteralInString = /(["'])(?:[^"']*?)\$\{[^}]+\}(?:[^"']*?)\1/;
      if (templateLiteralInString.test(seg.content)) {
        hasTemplateLiteralBug = true;
        let fixed = seg.content;
        fixed = fixed.replace(/(["'])((?:[^"']*?)\$\{[^}]+\}(?:[^"']*?))\1/g, (_match, _quote, inner) => {
          return `\`${inner}\``;
        });
        rebuilt += fixed;
      } else {
        rebuilt += seg.content;
      }
    }
  }

  if (hasTemplateLiteralBug) {
    if (options.debugMode) {
      console.log(`   ⚠️ Auto-fixed template literal bug in "${path}" — converted \${} inside regular strings to backtick template literals`);
    }
    fixedContent = rebuilt;
  }

  return fixedContent;
}
