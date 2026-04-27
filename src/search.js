/**
 * Puppeteer-based web search module for Reside.
 * Uses puppeteer-extra with stealth plugin to bypass bot detection
 * and search DuckDuckGo Lite for results.
 *
 * @module search
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

/** Shared browser instance (lazy-initialized) */
let _browser = null;
let _browserRefCount = 0;

/**
 * Get or create the shared Puppeteer browser instance.
 * Uses reference counting so the browser stays open across multiple searches.
 */
async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
    _browserRefCount = 0;
  }
  _browserRefCount++;
  return _browser;
}

/**
 * Release a browser reference. Closes the browser when no references remain.
 */
async function releaseBrowser() {
  _browserRefCount--;
  if (_browserRefCount <= 0 && _browser && _browser.connected) {
    try {
      await _browser.close();
    } catch {
      // ignore close errors
    }
    _browser = null;
    _browserRefCount = 0;
  }
}

/**
 * Extract the real URL from a DuckDuckGo redirect URL.
 * DDG wraps result links in: https://duckduckgo.com/l/?uddg=<encoded-url>&rut=...
 */
function extractRealUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {
    // fall through
  }
  return url;
}

/**
 * Search the web using DuckDuckGo Lite via Puppeteer.
 *
 * @param {string} query - The search query
 * @param {object} [options] - Optional settings
 * @param {number} [options.timeout=15000] - Navigation timeout in ms
 * @param {number} [options.maxResults=8] - Maximum number of results to return
 * @returns {Promise<{success: boolean, results?: Array, error?: string, output?: string}>}
 */
export async function searchWeb(query, options = {}) {
  const timeout = options.timeout ?? 15_000;
  const maxResults = options.maxResults ?? 8;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return { success: false, error: 'Missing required argument: query' };
  }

  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();

    // Mobile viewport + stealth headers to avoid bot detection
    await page.setViewport({
      width: 768,
      height: 2048,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    await page.setExtraHTTPHeaders({ Referer: 'https://www.google.com/' });
    await page.setBypassCSP(true);

    const encodedQuery = encodeURIComponent(query.trim());
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout,
    });

    // Check for captcha challenge
    const content = await page.content();
    if (content.includes('anomaly-modal') || content.includes('challenge-form')) {
      return {
        success: false,
        error: 'DuckDuckGo returned a CAPTCHA challenge. Try a different query or try again later.',
      };
    }

    // Extract results from the HTML, filtering out ads
    const results = await page.evaluate((max) => {
      const items = [];
      const linkNodes = document.querySelectorAll('a.result-link');
      const snippetNodes = document.querySelectorAll('td.result-snippet');

      const count = Math.min(linkNodes.length, max * 2); // grab extra to account for filtered ads
      for (let i = 0; i < count; i++) {
        const link = linkNodes[i];
        const snippet = snippetNodes[i];
        const url = link.href || '';
        const title = (link.textContent || '').trim();

        // Skip ads: DDG ads use /y.js tracking URLs (possibly URL-encoded),
        // or have "more info" disclosure titles, or are wrapped in /l/?uddg= containing /y.js
        const decodedUrl = decodeURIComponent(url);
        if (decodedUrl.includes('/y.js') || title.toLowerCase() === 'more info') {
          continue;
        }

        items.push({
          title,
          url,
          snippet: snippet ? (snippet.textContent || '').trim() : '',
        });

        if (items.length >= max) break;
      }
      return items;
    }, maxResults);

    if (results.length === 0) {
      return {
        success: true,
        output: 'No search results found.',
        data: { results: [] },
      };
    }

    // Clean up DuckDuckGo redirect URLs to get the actual page URLs
    for (const result of results) {
      result.url = extractRealUrl(result.url);
    }

    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
      .join('\n\n');

    return {
      success: true,
      output,
      data: { results },
    };
  } catch (err) {
    return {
      success: false,
      error: `Search failed: ${err.message}`,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore close errors
      }
    }
    await releaseBrowser();
  }
}

/**
 * Fetch a URL and extract its content using Puppeteer.
 * Useful for pages that require JavaScript rendering.
 *
 * @param {string} url - The URL to fetch
 * @param {object} [options] - Optional settings
 * @param {number} [options.timeout=20000] - Navigation timeout in ms
 * @returns {Promise<{success: boolean, title?: string, content?: string, error?: string}>}
 */
export async function fetchUrlWithBrowser(url, options = {}) {
  const timeout = options.timeout ?? 20_000;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { success: false, error: 'Missing required argument: url' };
  }

  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();

    await page.setViewport({
      width: 768,
      height: 2048,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    await page.setExtraHTTPHeaders({ Referer: 'https://www.google.com/' });
    await page.setBypassCSP(true);

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });

    // Extract page title and text content
    const result = await page.evaluate(() => {
      const title = document.title || '';

      // Try to get main content, falling back to body
      const main =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.querySelector('[role="main"]') ||
        document.body;

      // Get all text, preserving structure
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null, false);
      const textParts = [];
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;

        // Skip hidden elements, scripts, styles, nav, footer
        const tag = parent.tagName?.toLowerCase() || '';
        if (['script', 'style', 'noscript', 'nav', 'footer', 'header'].includes(tag)) continue;
        const style = parent.style;
        if (style?.display === 'none' || style?.visibility === 'hidden') continue;

        const text = (node.textContent || '').trim();
        if (!text) continue;

        // Add structural spacing
        const blockTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'div', 'section'];
        const prefix = blockTags.includes(tag) ? '\n\n' : ' ';
        textParts.push(prefix + text);
      }

      return {
        title,
        content: textParts.join('').trim(),
      };
    });

    if (!result.content || result.content.length < 50) {
      return {
        success: false,
        error: 'Page appears to have no readable content.',
        data: { title: result.title, url, contentLength: 0 },
      };
    }

    return {
      success: true,
      title: result.title,
      content: result.content,
      url,
      contentLength: result.content.length,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to fetch URL: ${err.message}`,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore close errors
      }
    }
    await releaseBrowser();
  }
}
