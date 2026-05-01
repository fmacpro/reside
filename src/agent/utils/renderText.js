/**
 * Convert markdown links `[text](url)` to plain `url` in text output.
 * This prevents LLMs from rendering URLs as `[Link](https://...)` in the CLI.
 * Handles multi-line links where `]` and `(` are on separate lines.
 * Also handles bare URLs wrapped in angle brackets `<url>` or square brackets `[url]`.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderText(text) {
  if (!text) return text;

  let result = text;

  // Step 1: Normalize multi-line markdown links by joining bracket-paren pairs
  // that are separated by newlines: [url]\n(url) -> [url](url)
  result = result.replace(/\[([^\]]*)\]\s*\n\s*\(([^)]+)\)/g, '[$1]($2)');

  // Step 2: Convert [text](url) -> url (plain URL, no markdown)
  result = result.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    const trimmedUrl = url.trim();
    const trimmedText = linkText.trim();
    // If link text is a URL or generic like "Link", just return the URL
    if (trimmedText === trimmedUrl || /^https?:\/\//i.test(trimmedText)) {
      return trimmedUrl;
    }
    return trimmedUrl;
  });

  // Step 3: Convert bare URLs in square brackets [url] -> url
  result = result.replace(/\[(https?:\/\/[^\]]+)\]/g, '$1');

  // Step 4: Convert <url> -> url
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Step 5: Collapse "URL:\nhttps://..." -> "URL: https://..." (LLMs sometimes put URLs on a new line after "URL:")
  result = result.replace(/(URL|Link|Website):\s*\n\s*(https?:\/\/[^\s\n]+)/gi, '$1: $2');

  return result;
}
