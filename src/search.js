/**
 * Puppeteer-based web search module for Reside.
 * Uses puppeteer-extra with stealth plugin to bypass bot detection
 * and search DuckDuckGo Lite for results.
 *
 * @module search
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { extractFromHtml } from './fetchUrl.js';

puppeteer.use(StealthPlugin());

/** Shared browser instance (lazy-initialized) */
let _browser = null;
let _browserRefCount = 0;

/**
 * Known Cloudflare challenge indicators in page content/title.
 */
const CF_CHALLENGE_INDICATORS = [
  'Just a moment...',
  'Checking your browser',
  'Please wait while we verify',
  'Attention Required! | Cloudflare',
  'cf-browser-verification',
  'challenge-form',
  'cf-challenge',
  '_cf_chl_opt',
  'cdn-cgi/challenge-platform',
];

/**
 * Known Cloudflare challenge selectors in the DOM.
 */
const CF_CHALLENGE_SELECTORS = [
  '#cf-challenge-container',
  '#challenge-form',
  '#cf-please-wait',
  '#cf-error-details',
  '[id^="cf-challenge-"]',
  'iframe[src*="challenge-platform"]',
];

/**
 * Detect if the current page is showing a Cloudflare challenge.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function isCloudflareChallenge(page) {
  try {
    const title = await page.title();
    for (const indicator of CF_CHALLENGE_INDICATORS) {
      if (title.includes(indicator)) return true;
    }

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    for (const indicator of CF_CHALLENGE_INDICATORS) {
      if (bodyText.includes(indicator)) return true;
    }

    // Check for challenge-specific elements
    for (const selector of CF_CHALLENGE_SELECTORS) {
      const el = await page.$(selector);
      if (el) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Wait for a Cloudflare challenge to complete.
 * Polls the page until the challenge is resolved or timeout is reached.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} timeout - Max time to wait in ms
 * @returns {Promise<boolean>} - Whether the challenge was resolved
 */
async function waitForChallengeResolution(page, timeout = 30_000) {
  const start = Date.now();
  const pollInterval = 500;

  while (Date.now() - start < timeout) {
    const stillChallenge = await isCloudflareChallenge(page);
    if (!stillChallenge) {
      // Give the page a moment to load actual content after challenge
      await new Promise(r => setTimeout(r, 1000));
      return true;
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return false;
}

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
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
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
 * Search the web using DuckDuckGo HTML via Puppeteer.
 * After getting search results, follows the top N links to fetch actual
 * article titles and content summaries using the browser (handles Cloudflare).
 *
 * @param {string} query - The search query
 * @param {object} [options] - Optional settings
 * @param {number} [options.timeout=15000] - Navigation timeout in ms
 * @param {number} [options.maxResults=8] - Maximum number of results to return
 * @param {number} [options.followLinks=5] - Number of top results to follow for content (0 to disable)
 * @returns {Promise<{success: boolean, results?: Array, error?: string, output?: string}>}
 */
export async function searchWeb(query, options = {}) {
  const timeout = options.timeout ?? 15_000;
  const maxResults = options.maxResults ?? 8;
  const followLinks = options.followLinks ?? 5;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return { success: false, error: 'Missing required argument: query' };
  }

  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();

    // Desktop viewport for richer search results
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });

    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Referer': 'https://www.google.com/',
    });
    await page.setBypassCSP(true);

    const encodedQuery = encodeURIComponent(query.trim());
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

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
      const resultNodes = document.querySelectorAll('.result');

      for (const result of resultNodes) {
        const link = result.querySelector('.result__a');
        const snippet = result.querySelector('.result__snippet');
        const urlEl = result.querySelector('.result__url');

        if (!link) continue;

        const url = link.href || '';
        const title = (link.textContent || '').trim();

        // Skip ads: DDG ads use /y.js tracking URLs
        const decodedUrl = decodeURIComponent(url);
        if (decodedUrl.includes('/y.js') || title.toLowerCase() === 'more info') {
          continue;
        }

        items.push({
          title,
          url,
          snippet: snippet ? (snippet.textContent || '').trim() : '',
          displayedUrl: urlEl ? (urlEl.textContent || '').trim() : '',
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

    // Follow top N links to fetch actual article content
    const followCount = Math.min(followLinks, results.length);
    const followedResults = [];

    for (let i = 0; i < followCount; i++) {
      const result = results[i];
      console.log(`   📄 Fetching content from: ${result.title}`);

      // Use fetchUrlWithBrowser to handle Cloudflare and JS rendering
      const fetched = await fetchUrlWithBrowser(result.url, {
        timeout: 20_000,
        challengeTimeout: 15_000,
      });

      if (fetched.success) {
        // Truncate content to a reasonable summary length
        const summary = fetched.content.length > 400
          ? fetched.content.slice(0, 400) + '...'
          : fetched.content;

        followedResults.push({
          ...result,
          articleTitle: fetched.title || result.title,
          summary,
          contentLength: fetched.contentLength,
        });
      } else {
        // If fetch fails, fall back to the DDG snippet
        followedResults.push({
          ...result,
          articleTitle: result.title,
          summary: result.snippet || '(content unavailable)',
          contentLength: 0,
        });
      }
    }

    // Build output with actual article content
    const output = followedResults
      .map((r, i) => {
        const lines = [
          `${i + 1}. ${r.articleTitle}`,
          `   ${r.summary}`,
          `   ${r.url}`,
        ];
        return lines.join('\n');
      })
      .join('\n\n');

    return {
      success: true,
      output,
      data: { results: followedResults },
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
 * Apply stealth enhancements to a page to avoid bot detection.
 * Overrides navigator.webdriver, adds realistic plugins, etc.
 *
 * @param {import('puppeteer').Page} page
 */
async function applyStealthEnhancements(page) {
  // Override navigator properties that bots leak
  await page.evaluateOnNewDocument(() => {
    // Remove the webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // Add realistic plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    // Add realistic languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-GB', 'en-US', 'en'],
    });

    // Override chrome runtime
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  });
}

/**
 * Fetch a URL and extract its content using Puppeteer.
 * Includes Cloudflare challenge detection and automatic resolution.
 * Useful for pages that require JavaScript rendering.
 *
 * @param {string} url - The URL to fetch
 * @param {object} [options] - Optional settings
 * @param {number} [options.timeout=30000] - Navigation timeout in ms
 * @param {number} [options.challengeTimeout=30000] - Max time to wait for Cloudflare challenge resolution
 * @returns {Promise<{success: boolean, title?: string, content?: string, error?: string}>}
 */
export async function fetchUrlWithBrowser(url, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const challengeTimeout = options.challengeTimeout ?? 30_000;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return { success: false, error: 'Missing required argument: url' };
  }

  const browser = await getBrowser();
  let page = null;

  try {
    page = await browser.newPage();

    // Use a desktop-like viewport for better compatibility with news sites
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });

    // Set realistic browser headers
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': 'https://www.google.com/',
      'Sec-Ch-Ua': '"Google Chrome";v="120", "Chromium";v="120", "Not?A_Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    await page.setBypassCSP(true);
    await applyStealthEnhancements(page);

    // Navigate with a longer timeout and 'load' event first (more reliable than networkidle2 for challenged pages)
    await page.goto(url, {
      waitUntil: 'load',
      timeout,
    });

    // Check for Cloudflare challenge
    const hasChallenge = await isCloudflareChallenge(page);

    if (hasChallenge) {
      console.log(`   ⚠️ Cloudflare challenge detected for ${url}, waiting for resolution...`);

      // Wait for the challenge to resolve
      const resolved = await waitForChallengeResolution(page, challengeTimeout);

      if (!resolved) {
        return {
          success: false,
          error: `Cloudflare challenge did not resolve within ${challengeTimeout}ms. The site may be blocking automated access.`,
          data: { url, challengeDetected: true },
        };
      }

      // After challenge resolves, wait for network to settle
      try {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 5000 });
      } catch {
        // Non-critical, continue anyway
      }
    }

    // Wait a bit more for dynamic content to render
    await new Promise(r => setTimeout(r, 1000));

    // Get the full page HTML and use the same heuristic-based content extraction
    // as the HTTP fetch path for consistent results
    const html = await page.content();
    const { title, content } = extractFromHtml(html);

    if (!content) {
      return {
        success: false,
        error: 'Page appears to have no readable content.',
        data: { title, url, contentLength: 0 },
      };
    }

    return {
      success: true,
      title,
      content,
      url,
      contentLength: content.length,
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
