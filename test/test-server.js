/**
 * Local test HTTP server for integration tests.
 * Serves fixture HTML files so tests don't need to make real network requests.
 *
 * Usage:
 *   const server = new TestServer();
 *   await server.start();
 *   // ... run tests using server.url ...
 *   await server.stop();
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const FIXTURES_DIR = join(__dirname, 'fixtures');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export class TestServer {
  constructor() {
    this._server = null;
    this._port = null;
    this._url = null;
  }

  /**
   * Start the server on a random available port.
   * @returns {Promise<string>} The base URL of the server (e.g., http://localhost:12345)
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        // Parse the request path
        let path = req.url || '/';
        // Remove query string
        const qIndex = path.indexOf('?');
        if (qIndex !== -1) path = path.slice(0, qIndex);

        // Map URL path to fixture file
        let fixturePath;
        if (path === '/' || path === '/index.html') {
          fixturePath = join(FIXTURES_DIR, 'simple.html');
        } else {
          // Remove leading slash
          const relativePath = path.replace(/^\//, '');
          fixturePath = join(FIXTURES_DIR, relativePath);
        }

        // Security: ensure the resolved path is within the fixtures directory
        const resolved = join(FIXTURES_DIR, relative(FIXTURES_DIR, fixturePath));
        if (!resolved.startsWith(FIXTURES_DIR)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        if (!existsSync(fixturePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = extname(fixturePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        try {
          const content = readFileSync(fixturePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });

      // Listen on port 0 to get a random available port
      this._server.listen(0, '127.0.0.1', () => {
        const addr = this._server.address();
        this._port = addr.port;
        this._url = `http://127.0.0.1:${this._port}`;
        resolve(this._url);
      });

      this._server.on('error', reject);
    });
  }

  /**
   * Get the base URL of the running server.
   */
  get url() {
    return this._url;
  }

  /**
   * Get the port the server is running on.
   */
  get port() {
    return this._port;
  }

  /**
   * Stop the server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this._server) {
        resolve();
        return;
      }
      this._server.close(() => {
        this._server = null;
        this._port = null;
        this._url = null;
        resolve();
      });
    });
  }
}

/**
 * Helper to compute relative path for security check.
 */
function relative(from, to) {
  const fromParts = from.replace(/\\/g, '/').split('/');
  const toParts = to.replace(/\\/g, '/').split('/');

  // Remove common prefix
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }

  const result = [];
  for (let j = i; j < fromParts.length; j++) {
    result.push('..');
  }
  for (let j = i; j < toParts.length; j++) {
    result.push(toParts[j]);
  }

  return result.join('/');
}
