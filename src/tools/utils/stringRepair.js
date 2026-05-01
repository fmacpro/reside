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
 * For template literals: repair broken template literals where a \n escape was
 * converted to an actual newline by JSON parsing.
 *
 * Uses splitIntoSegments to identify template literal boundaries, then checks
 * each template literal for the broken pattern: a newline where the content
 * after the last newline is only whitespace followed by the closing backtick.
 *
 * Legitimate multi-line template literals (with actual newlines in the middle
 * of content) are NOT repaired.
 *
 * @param {string} str
 * @returns {string}
 */
export function fixTemplate(str) {
  const segments = splitIntoSegments(str);
  let rebuilt = '';
  for (const seg of segments) {
    if (seg.type === 'template') {
      // Check if this template literal has the broken pattern:
      // content, newline, whitespace, closing backtick
      // e.g., `Adding a fish...
      //        `
      const content = seg.content;
      // Remove the opening and closing backticks
      const inner = content.slice(1, -1);
      if (inner.includes('\n')) {
        // Find the last newline
        const lastNewlineIdx = inner.lastIndexOf('\n');
        const afterLastNewline = inner.slice(lastNewlineIdx + 1);
        // If the content after the last newline is only whitespace,
        // this is a broken template literal — repair all newlines
        if (afterLastNewline.trim() === '') {
          // Replace all newlines with \n
          rebuilt += '`' + inner.replace(/\n\s*/g, '\\n') + '`';
        } else {
          // Legitimate multi-line template literal — leave untouched
          rebuilt += seg.content;
        }
      } else {
        rebuilt += seg.content;
      }
    } else {
      rebuilt += seg.content;
    }
  }
  return rebuilt;
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
