/**
 * URL fetching and article content extraction.
 * Zero external dependencies — uses only Node.js built-in modules.
 * Content detection algorithm adapted from horseman-article-parser's contentDetector.js.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// ─── Content Detection Constants ────────────────────────────────────────────

const POSITIVE_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '[itemtype*="Article"]',
];

const NEGATIVE_TAGS = new Set([
  'nav', 'aside', 'footer', 'header', 'form', 'noscript', 'template',
  'script', 'style',
]);

const NEGATIVE_CLASS_PATTERNS = [
  'comment', 'comments', 'related', 'recirculation', 'share', 'social',
  'promo', 'sponsor', 'newsletter', 'consent', 'cookie', 'sidebar',
  'widget', 'advertisement', 'ad-', 'ad_', 'menu', 'nav-', 'footer',
  'header', 'breadcrumb', 'tags', 'tag-',
];

const CONTENT_CLASS_PATTERNS = [
  'entry-content', 'post-body', 'post-content', 'article-content',
  'content__body', 'content-body', 'story-body', 'article-body',
  'article__body', 'post__content', 'entry__content',
];

// ─── HTTP Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL and return its HTML content.
 * @param {string} url
 * @param {number} [timeout=15000]
 * @returns {Promise<{html: string, finalUrl: string, status: number}>}
 */
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requester = isHttps ? httpsRequest : httpRequest;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.google.com/',
      },
      // Follow up to 5 redirects
      maxRedirects: 5,
    };

    const req = requester(options, (res) => {
      // Handle redirects manually for Node 18 compatibility
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(fetchUrl(redirectUrl, timeout));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf-8');
        resolve({
          html,
          finalUrl: res.headers.location || url,
          status: res.statusCode,
        });
      });
    });

    req.on('error', (err) => reject(new Error(`Fetch failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeout}ms`));
    });

    req.end();
  });
}

// ─── Lightweight HTML Parser ────────────────────────────────────────────────

/**
 * A minimal HTML parser that builds a tree of TagNode objects.
 * This avoids needing JSDOM or any external parser.
 */
class TagNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.children = [];
    this.text = '';
    this.parent = null;
  }

  get id() { return this.attributes.id || ''; }
  get classList() { return (this.attributes.class || '').split(/\s+/).filter(Boolean); }
  get role() { return this.attributes.role || ''; }
  get itemtype() { return this.attributes.itemtype || ''; }

  /**
   * Get all descendant elements matching a tag name.
   */
  querySelectorAll(tagName) {
    const results = [];
    const upper = tagName.toUpperCase();
    for (const child of this.children) {
      if (child instanceof TagNode) {
        if (child.tagName === upper) results.push(child);
        results.push(...child.querySelectorAll(tagName));
      }
    }
    return results;
  }

  /**
   * Get the first descendant matching a tag name.
   */
  querySelector(tagName) {
    const upper = tagName.toUpperCase();
    for (const child of this.children) {
      if (child instanceof TagNode) {
        if (child.tagName === upper) return child;
        const found = child.querySelector(tagName);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Get all text content from this node and its descendants.
   */
  get textContent() {
    let result = this.text || '';
    for (const child of this.children) {
      if (child instanceof TagNode) {
        result += ' ' + child.textContent;
      } else if (typeof child === 'string') {
        result += ' ' + child;
      }
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  /**
   * Check if this element matches a simple CSS selector.
   * Supports: tag, .class, #id, [attr], [attr*="val"]
   */
  matches(selector) {
    const parts = selector.split(/(?=[.#\[])/);
    for (const part of parts) {
      if (part.startsWith('.')) {
        const cls = part.slice(1);
        if (!this.classList.includes(cls)) return false;
      } else if (part.startsWith('#')) {
        if (this.id !== part.slice(1)) return false;
      } else if (part.startsWith('[')) {
        const match = part.match(/^\[([\w-]+)([*^$]?)=?"([^"]*)"?\]$/);
        if (match) {
          const [, attr, op, val] = match;
          const attrVal = this.attributes[attr] || '';
          if (op === '*') { if (!attrVal.includes(val)) return false; }
          else if (op === '^') { if (!attrVal.startsWith(val)) return false; }
          else if (op === '$') { if (!attrVal.endsWith(val)) return false; }
          else { if (attrVal !== val) return false; }
        } else {
          const simple = part.match(/^\[([\w-]+)\]$/);
          if (simple && !(simple[1] in this.attributes)) return false;
        }
      } else {
        if (this.tagName !== part.toUpperCase()) return false;
      }
    }
    return true;
  }

  /**
   * Remove a child node.
   */
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  /**
   * Clone this node deeply.
   */
  cloneNode(deep = true) {
    const clone = new TagNode(this.tagName, { ...this.attributes });
    clone.text = this.text;
    if (deep) {
      for (const child of this.children) {
        if (child instanceof TagNode) {
          const childClone = child.cloneNode(true);
          childClone.parent = clone;
          clone.children.push(childClone);
        } else {
          clone.children.push(child);
        }
      }
    }
    return clone;
  }
}

/**
 * Parse HTML string into a tree of TagNode objects.
 * This is a simplified parser that handles common cases.
 */
function parseHtml(html) {
  const root = new TagNode('ROOT');
  const stack = [root];
  let current = root;
  let i = 0;

  // Remove comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\/?>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    // Add text before this tag
    if (match.index > lastIndex) {
      const text = html.slice(lastIndex, match.index).trim();
      if (text) {
        current.children.push(text);
      }
    }

    const fullTag = match[0];
    const tagName = match[1].toUpperCase();
    const attrString = match[2].trim();
    const isClosing = fullTag.startsWith('</');
    const isSelfClosing = fullTag.endsWith('/>') || SELF_CLOSING.has(tagName);

    if (isClosing) {
      // Closing tag — pop stack
      if (stack.length > 1) {
        stack.pop();
        current = stack[stack.length - 1];
      }
    } else {
      // Opening tag
      const attributes = parseAttributes(attrString);
      const node = new TagNode(tagName, attributes);
      node.parent = current;
      current.children.push(node);

      if (!isSelfClosing) {
        stack.push(node);
        current = node;
      }
    }

    lastIndex = match.index + fullTag.length;
  }

  // Add remaining text
  if (lastIndex < html.length) {
    const text = html.slice(lastIndex).trim();
    if (text) {
      current.children.push(text);
    }
  }

  return root;
}

const SELF_CLOSING = new Set([
  'BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK', 'AREA', 'BASE',
  'COL', 'EMBED', 'SOURCE', 'TRACK', 'WBR',
]);

function parseAttributes(str) {
  const attrs = {};
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = attrRegex.exec(str)) !== null) {
    attrs[m[1]] = m[2] || m[3] || m[4] || '';
  }
  return attrs;
}

// ─── Content Detection ──────────────────────────────────────────────────────

/**
 * Get clean text from a node, stripping excessive whitespace.
 */
function getText(node) {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * Count characters and punctuation in text.
 */
function charCounts(text) {
  const len = text.length;
  const punct = (text.match(/[.!?,;:]/g) || []).length;
  return { len, punct };
}

/**
 * Calculate link density — ratio of link text to total text.
 */
function linkDensity(node) {
  const total = getText(node);
  const links = node.querySelectorAll('A');
  const linkText = links.map(a => getText(a)).join(' ');
  const denom = total.length || 1;
  return linkText.length / denom;
}

/**
 * Count paragraph-like elements.
 */
function paragraphCount(node) {
  return node.querySelectorAll('P').length + node.querySelectorAll('BR').length;
}

/**
 * Check if node has semantic container tags/attributes.
 */
function containsSemantic(node) {
  if (!node) return 0;
  if (node.tagName === 'ARTICLE' || node.tagName === 'MAIN') return 1;
  if (node.role === 'main') return 1;
  if (node.itemtype && /Article/i.test(node.itemtype)) return 1;
  return 0;
}

/**
 * Count direct children of a given tag name.
 */
function countDirect(node, tagName) {
  if (!node || !node.children) return 0;
  const upper = tagName.toUpperCase();
  return node.children.filter(c => c instanceof TagNode && c.tagName === upper).length;
}

const BLOCK_TAGS = new Set(['P', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'FIGURE', 'BLOCKQUOTE', 'PRE', 'TABLE']);

function countDirectBlocks(node) {
  if (!node || !node.children) return 0;
  return node.children.filter(c => c instanceof TagNode && BLOCK_TAGS.has(c.tagName)).length;
}

function averageDirectPTextLen(node) {
  if (!node || !node.children) return 0;
  const ps = node.children.filter(c => c instanceof TagNode && c.tagName === 'P');
  if (!ps.length) return 0;
  const sum = ps.reduce((acc, p) => acc + getText(p).length, 0);
  return sum / ps.length;
}

function headingChildrenCount(node) {
  if (!node || !node.children) return 0;
  return node.children.filter(c =>
    c instanceof TagNode && (c.tagName === 'H2' || c.tagName === 'H3' || c.tagName === 'H4')
  ).length;
}

function depthOf(node) {
  let d = 0;
  let n = node;
  while (n && n.parent) {
    d++;
    if (n.parent.tagName === 'BODY' || n.parent.tagName === 'HTML' || n.parent.tagName === 'ROOT') break;
    n = n.parent;
  }
  return d;
}

/**
 * Check if a node or its ancestors have negative class/id patterns.
 */
function hasNegativePatterns(node) {
  let n = node;
  while (n && n instanceof TagNode) {
    const cls = n.classList.join(' ');
    const id = n.id;
    for (const pattern of NEGATIVE_CLASS_PATTERNS) {
      if (cls.includes(pattern) || id.includes(pattern)) return true;
    }
    n = n.parent;
  }
  return false;
}

/**
 * Compute feature vector for a node.
 */
function computeFeatures(node) {
  const text = getText(node);
  const { len, punct } = charCounts(text);
  const ld = linkDensity(node);
  const pc = paragraphCount(node);
  const sem = containsSemantic(node);
  const dp = countDirect(node, 'P');
  const db = countDirectBlocks(node);
  const dr = db > 0 ? dp / db : (dp > 0 ? 1 : 0);
  const avgP = averageDirectPTextLen(node);
  const depth = depthOf(node);
  const heads = headingChildrenCount(node);
  const negPatterns = hasNegativePatterns(node) ? 1 : 0;

  // Consent/cookie keyword penalty
  let consentPenalty = 0;
  try {
    const lower = text.toLowerCase();
    const hits = [
      'cookie', 'cookies', 'consent', 'gdpr', 'privacy',
      'manage preferences', 'advertising partners',
    ].reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0);
    consentPenalty = hits >= 2 ? Math.min(6, hits * 1.5) : 0;
  } catch {}

  return { len, punct, ld, pc, sem, dp, db, dr, avgP, depth, heads, negPatterns, consentPenalty };
}

/**
 * Compute heuristic score from features.
 */
function heuristicScore(f) {
  const lengthScore = Math.log(1 + f.len);
  const punctScore = Math.min(f.punct / 10, 5);
  const paraScore = Math.min(f.pc / 5, 5);
  const semBonus = f.sem ? 2 : 0;
  const linkPenalty = Math.min(f.ld * 10, 6);
  const directPScore = Math.min(f.dp / 3, 6);
  const ratioScore = Math.min(f.dr * 6, 6);
  const avgPScore = Math.min(Math.log(1 + f.avgP), 4);
  const headingScore = Math.min(f.heads, 3) * 0.5;
  const depthScore = Math.min(f.depth, 8) * 0.3;
  const wrapperPenalty = (f.dp === 0 && f.db > 0) ? 2 : 0;
  const negPenalty = f.negPatterns ? 3 : 0;

  return lengthScore + punctScore + paraScore + semBonus
    + directPScore + ratioScore + avgPScore + headingScore + depthScore
    - linkPenalty - wrapperPenalty - negPenalty - (f.consentPenalty || 0);
}

/**
 * Gather candidate content nodes from the document.
 */
function gatherCandidates(root) {
  const candidates = [];

  // Positive selectors
  for (const sel of POSITIVE_SELECTORS) {
    if (sel.startsWith('[')) {
      // Attribute selector
      const match = sel.match(/^\[([\w-]+)([*^$]?)=?"([^"]*)"?\]$/);
      if (match) {
        const [, attr, op, val] = match;
        const nodes = collectByAttribute(root, attr, op, val);
        candidates.push(...nodes);
      }
    } else {
      const nodes = root.querySelectorAll(sel);
      candidates.push(...nodes);
    }
  }

  // Content class patterns
  for (const node of collectByClassPattern(root, CONTENT_CLASS_PATTERNS)) {
    candidates.push(node);
  }

  // Large divs (> 400 chars)
  const divs = root.querySelectorAll('DIV');
  for (const div of divs) {
    if (getText(div).length > 400) {
      candidates.push(div);
    }
  }

  return candidates;
}

function collectByAttribute(root, attr, op, val) {
  const results = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child instanceof TagNode) {
        const attrVal = child.attributes[attr] || '';
        if (op === '*') { if (attrVal.includes(val)) results.push(child); }
        else if (op === '^') { if (attrVal.startsWith(val)) results.push(child); }
        else if (op === '$') { if (attrVal.endsWith(val)) results.push(child); }
        else { if (attrVal === val) results.push(child); }
        walk(child);
      }
    }
  };
  walk(root);
  return results;
}

function collectByClassPattern(root, patterns) {
  const results = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child instanceof TagNode) {
        const cls = child.classList.join(' ');
        for (const pattern of patterns) {
          if (cls.includes(pattern)) {
            results.push(child);
            break;
          }
        }
        walk(child);
      }
    }
  };
  walk(root);
  return results;
}

/**
 * Strip negative (boilerplate) containers from a cloned node.
 */
function stripBadContainers(node) {
  const clone = node.cloneNode(true);
  const stripRecursive = (n) => {
    const toRemove = [];
    for (const child of n.children) {
      if (child instanceof TagNode) {
        if (NEGATIVE_TAGS.has(child.tagName)) {
          toRemove.push(child);
        } else if (hasNegativePatterns(child)) {
          toRemove.push(child);
        } else {
          stripRecursive(child);
        }
      }
    }
    for (const r of toRemove) {
      n.removeChild(r);
    }
  };
  stripRecursive(clone);
  return clone;
}

/**
 * Extract text content from HTML, stripping tags but preserving paragraph breaks.
 */
function extractText(node) {
  let result = '';
  for (const child of node.children) {
    if (child instanceof TagNode) {
      const tagName = child.tagName;
      if (NEGATIVE_TAGS.has(tagName)) continue;
      if (hasNegativePatterns(child)) continue;

      if (tagName === 'P' || tagName === 'DIV' || tagName === 'SECTION') {
        const text = getText(child);
        if (text) result += text + '\n\n';
      } else if (tagName === 'H1' || tagName === 'H2' || tagName === 'H3' || tagName === 'H4') {
        const text = getText(child);
        if (text) result += '## ' + text + '\n\n';
      } else if (tagName === 'LI') {
        const text = getText(child);
        if (text) result += '- ' + text + '\n';
      } else if (tagName === 'BLOCKQUOTE') {
        const text = getText(child);
        if (text) result += '> ' + text + '\n\n';
      } else if (tagName === 'PRE' || tagName === 'CODE') {
        const text = getText(child);
        if (text) result += '```\n' + text + '\n```\n\n';
      } else if (tagName === 'BR') {
        result += '\n';
      } else if (tagName === 'IMG') {
        const alt = child.attributes.alt || '';
        if (alt) result += `[Image: ${alt}]\n`;
      } else if (tagName === 'FIGURE') {
        const text = getText(child);
        if (text) result += text + '\n\n';
      } else {
        const text = getText(child);
        if (text) result += text + '\n';
      }
    } else if (typeof child === 'string') {
      const text = child.trim();
      if (text) result += text + ' ';
    }
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Main Extraction Function ───────────────────────────────────────────────

/**
 * Extract the main article content from HTML.
 * Uses heuristic scoring to find the best content container.
 *
 * @param {string} html - Raw HTML
 * @returns {{ title: string|null, content: string, textLength: number }}
 */
function extractContent(html) {
  const root = parseHtml(html);

  // Try to extract title
  let title = null;
  const titleTag = root.querySelector('TITLE');
  if (titleTag) {
    title = getText(titleTag);
  }
  // Prefer og:title or h1
  const h1 = root.querySelector('H1');
  if (h1) {
    const h1Text = getText(h1);
    if (h1Text && h1Text.length > 5) title = h1Text;
  }

  // Gather candidates
  const candidates = gatherCandidates(root);

  if (candidates.length === 0) {
    // Fallback: use body content
    const body = findBody(root);
    if (body) {
      const clean = stripBadContainers(body);
      const content = extractText(clean);
      return { title, content, textLength: content.length };
    }
    // Last resort: strip all tags
    const text = root.textContent.replace(/\s+/g, ' ').trim();
    return { title, content: text, textLength: text.length };
  }

  // Score candidates
  const scored = candidates.map(el => {
    const clean = stripBadContainers(el);
    const f = computeFeatures(clean);
    const score = heuristicScore(f);
    return { el, clean, f, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Pick the best candidate
  let best = scored[0];

  // If best is too weak, try the next one
  if (best && best.f.len < 200 && scored.length > 1) {
    best = scored[1];
  }

  if (!best || !best.clean) {
    const body = findBody(root);
    if (body) {
      const clean = stripBadContainers(body);
      const content = extractText(clean);
      return { title, content, textLength: content.length };
    }
    return { title, content: '', textLength: 0 };
  }

  // Try to find a more specific container within the best candidate
  const refined = drillDownToContent(best.clean);
  const finalNode = refined || best.clean;

  const content = extractText(finalNode);

  // If content is too short, try the full cleaned version
  if (content.length < 200 && best.clean !== finalNode) {
    const fallbackContent = extractText(best.clean);
    return { title, content: fallbackContent, textLength: fallbackContent.length };
  }

  return { title, content, textLength: content.length };
}

/**
 * Find the body-like container in the parsed tree.
 */
function findBody(root) {
  for (const child of root.children) {
    if (child instanceof TagNode && child.tagName === 'HTML') {
      for (const gc of child.children) {
        if (gc instanceof TagNode && gc.tagName === 'BODY') return gc;
      }
    }
  }
  return null;
}

/**
 * Drill down within a container to find a more specific content node.
 */
function drillDownToContent(node, maxDepth = 5) {
  if (!node) return null;
  const CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'MAIN']);
  let best = { node, score: -Infinity };

  const queue = [{ node, depth: 0 }];
  while (queue.length) {
    const { node: current, depth } = queue.shift();
    if (!current || !(current instanceof TagNode)) continue;
    if (!CONTAINER_TAGS.has(current.tagName)) continue;

    const f = computeFeatures(current);
    const lengthScore = Math.log(1 + f.len);
    const directPScore = Math.min(f.dp / 2, 8);
    const ratioScore = Math.min(f.dr * 8, 8);
    const avgPScore = Math.min(Math.log(1 + f.avgP), 5);
    const linkPenalty = Math.min(f.ld * 12, 8);
    const s = directPScore * 2 + ratioScore * 3 + avgPScore + lengthScore * 0.5 - linkPenalty;

    if (f.len >= 200 && f.ld <= 0.65) {
      if (s > best.score) best = { node: current, score: s };
    }

    if (depth < maxDepth) {
      for (const child of current.children) {
        if (child instanceof TagNode) {
          queue.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }

  return best.node !== node ? best.node : null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract the main article content.
 *
 * @param {string} url - The URL to fetch
 * @param {Object} [options]
 * @param {number} [options.timeout=15000] - Request timeout in ms
 * @param {number} [options.maxLength=50000] - Maximum content length to return
 * @returns {Promise<{success: boolean, title?: string, content?: string, url?: string, error?: string}>}
 */
export async function fetchAndExtract(url, options = {}) {
  const timeout = options.timeout || 15000;
  const maxLength = options.maxLength || 50000;

  if (!url || typeof url !== 'string') {
    return { success: false, error: 'URL is required' };
  }

  // Basic URL validation
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { success: false, error: 'Only http and https URLs are supported' };
    }
  } catch {
    return { success: false, error: 'Invalid URL format' };
  }

  try {
    const { html, finalUrl, status } = await fetchUrl(url, timeout);

    if (status >= 400) {
      return {
        success: false,
        error: `HTTP ${status}: Server returned error status`,
        url: finalUrl,
      };
    }

    if (!html || html.length < 100) {
      return {
        success: false,
        error: 'Response contains no meaningful content',
        url: finalUrl,
      };
    }

    const { title, content } = extractContent(html);

    if (!content || content.length < 50) {
      return {
        success: false,
        error: 'Could not extract meaningful content from the page',
        url: finalUrl,
      };
    }

    // Truncate if too long
    const truncated = content.length > maxLength
      ? content.slice(0, maxLength) + `\n\n[...content truncated at ${maxLength} characters]`
      : content;

    return {
      success: true,
      title: title || '',
      content: truncated,
      url: finalUrl,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      url,
    };
  }
}
