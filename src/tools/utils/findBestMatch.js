import { diffLines } from 'diff';

/**
 * Find the best match for `newCode` within `currentContent` using diff-based matching.
 *
 * Strategy:
 * 1. Extract the first significant line from newCode (the "anchor" — e.g., function signature)
 * 2. Find all occurrences of the anchor in currentContent
 * 3. For each occurrence, compute the diff score between the surrounding context and newCode
 * 4. Return the best match (highest unchanged - changed score)
 *
 * This handles LLM formatting hallucinations naturally — the diff algorithm only
 * counts actual content changes, not whitespace/formatting differences.
 *
 * @param {string} currentContent - The current file content
 * @param {string} newCode - The new code to find a match for
 * @returns {{startChar: number, endChar: number, startLine: number, endLine: number, score: number}|null}
 */
export function findBestMatch(currentContent, newCode) {
  const currentLines = currentContent.split('\n');
  const newLines = newCode.split('\n');

  // Special case: single-line files (or files with very few lines).
  // When the entire file content is being replaced (e.g., changing
  // "version 1" to "version 2"), the anchor line won't match because
  // the old and new content are different. In this case, check if
  // there's any overlap between the old and new content. If there is
  // (e.g., the new_string contains part of the old content), replace
  // the entire file. If the content is completely different, return
  // null so the caller can report a helpful error.
  if (currentLines.length <= 3 && newLines.length <= 3) {
    // Check if there's any overlap between current and new content.
    // If the new content is completely different (no shared lines),
    // return null to indicate no match found.
    const hasOverlap = newLines.some(nl => {
      const trimmed = nl.trim();
      return trimmed && currentLines.some(cl => cl.trim() === trimmed);
    });
    if (hasOverlap) {
      return {
        startChar: 0,
        endChar: currentContent.length,
        startLine: 0,
        endLine: currentLines.length,
        score: 0,
      };
    }
    // No overlap — fall through to normal matching (which will also fail)
  }

  // Find the first significant line in newCode — this is our anchor.
  // Skip comment lines, blank lines, and import/require statements.
  let anchorLine = '';
  let anchorIdx = -1;
  for (let i = 0; i < newLines.length; i++) {
    const trimmed = newLines[i].trim();
    if (trimmed &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/**') &&
        !trimmed.startsWith('import ') &&
        !trimmed.startsWith('from ') &&
        !trimmed.startsWith('#')) {
      anchorLine = trimmed;
      anchorIdx = i;
      break;
    }
  }

  // Fallback: use the first non-empty line
  if (!anchorLine) {
    for (let i = 0; i < newLines.length; i++) {
      if (newLines[i].trim()) {
        anchorLine = newLines[i].trim();
        anchorIdx = i;
        break;
      }
    }
  }

  if (!anchorLine) return null;

  // Also try matching the anchor without a trailing '{' — the LLM may write
  // `function foo()` while the file has `function foo() {`.
  const anchorLineNoBrace = anchorLine.endsWith('{')
    ? anchorLine.slice(0, anchorLine.length - 1).trimEnd()
    : anchorLine + ' {';

  // Also try matching just the function/class/variable name, ignoring
  // modifiers like `async`, `export`, `default`, etc. For example, if the LLM
  // writes `async function fetchWeatherData(city) {` but the file has
  // `function fetchWeatherData(city) {`, we should still find a match.
  //
  // Strategy: extract the keyword + name from the anchor, then try both
  // the anchor's version and a version without `async`/`export`/`default`.
  const anchorKeywords = ['function ', 'class ', 'const ', 'let ', 'var '];
  let anchorMinimal = null;
  let anchorMinimalAlt = null; // version without async/export/default
  for (const kw of anchorKeywords) {
    // Check if anchor starts with a modifier + keyword (e.g., "async function ")
    const modifierPattern = new RegExp(`^(?:async\\s+|export\\s+|default\\s+)*${kw}`);
    const modMatch = anchorLine.match(modifierPattern);
    if (modMatch) {
      const fullPrefix = modMatch[0]; // e.g., "async function "
      const rest = anchorLine.slice(fullPrefix.length);
      const nameMatch = rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (nameMatch) {
        anchorMinimal = fullPrefix.trimEnd() + ' ' + nameMatch[1];
        // Also create a version without async/export/default modifiers
        anchorMinimalAlt = kw.trimEnd() + ' ' + nameMatch[1];
      }
      break;
    }
  }

  // Find all occurrences of the anchor in currentContent
  const candidates = [];
  for (let i = 0; i < currentLines.length; i++) {
    const trimmed = currentLines[i].trim();
    if (trimmed === anchorLine || trimmed === anchorLineNoBrace) {
      candidates.push(i);
    } else if (anchorMinimal && trimmed.startsWith(anchorMinimal)) {
      // Match with the modifier (e.g., "async function fetchWeatherData")
      candidates.push(i);
    } else if (anchorMinimalAlt && trimmed.startsWith(anchorMinimalAlt)) {
      // Match without the modifier (e.g., "function fetchWeatherData")
      candidates.push(i);
    }
  }

  if (candidates.length === 0) return null;

  // For each candidate, compute the diff score.
  // We try multiple context sizes: the exact newCode length, and extended
  // versions that include trailing blank lines (which the LLM may omit).
  let bestScore = -Infinity;
  let bestMatch = null;

  for (const candidateLine of candidates) {
    // The anchor in newCode is at anchorIdx.
    // So the start of the replacement in currentContent should be at candidateLine - anchorIdx.
    const replaceStartLine = candidateLine - anchorIdx;
    if (replaceStartLine < 0) continue;

    // Try a wide range of context sizes. The new code may have significantly more
    // or fewer lines than the original section due to formatting changes (e.g.,
    // braces on new lines add lines, removing blank lines reduces lines).
    // We try from newLines.length - 15 to newLines.length + 5 to handle cases
    // where the LLM's formatting adds many extra lines.
    const contextSizes = [];
    const minSize = Math.max(1, newLines.length - 15);
    const maxSize = newLines.length + 5;
    for (let s = minSize; s <= maxSize; s++) {
      contextSizes.push(s);
    }

    for (const contextSize of contextSizes) {
      const replaceEndLine = Math.min(replaceStartLine + contextSize, currentLines.length);
      const contextLines = currentLines.slice(replaceStartLine, replaceEndLine);
      const contextStr = contextLines.join('\n');

      // Compute diff between context and newCode
      const changes = diffLines(contextStr, newCode);

      // Score: count unchanged lines minus penalty for changes
      let unchangedLines = 0;
      let changedLines = 0;
      for (const change of changes) {
        if (!change.added && !change.removed) {
          unchangedLines += change.count;
        } else {
          changedLines += change.count;
        }
      }

      // Penalize larger context sizes slightly (prefer exact match)
      const sizePenalty = (contextSize - newLines.length) * 0.5;
      const score = unchangedLines - changedLines - sizePenalty;

      if (score > bestScore) {
        bestScore = score;

        // Map line numbers to character positions.
        // startChar = position at the START of the first line (replaceStartLine).
        // endChar = position at the END of the last line (replaceEndLine - 1),
        //           NOT including the trailing newline.
        // This ensures that if the newCode doesn't end with a newline, the
        // trailing newline of the matched section is preserved in the content
        // after the replacement.
        const lineToChar = (lineNum) => {
          let pos = 0;
          for (let i = 0; i < Math.min(lineNum, currentLines.length); i++) {
            pos += currentLines[i].length + 1;
          }
          return pos;
        };

        // endChar = position right after the last character of the last line,
        // excluding the trailing newline. This is lineToChar(endLine) - 1
        // (to skip the trailing newline), unless the last line is empty
        // (in which case lineToChar(endLine) is correct since there's no content).
        const lastLineIdx = replaceEndLine - 1;
        const lastLineLen = lastLineIdx >= 0 && lastLineIdx < currentLines.length
          ? currentLines[lastLineIdx].length
          : 0;
        const endChar = lineToChar(replaceEndLine - 1) + lastLineLen;

        bestMatch = {
          startChar: lineToChar(replaceStartLine),
          endChar,
          startLine: replaceStartLine,
          endLine: replaceEndLine,
          score,
        };
      }
    }
  }

  return bestMatch;
}
