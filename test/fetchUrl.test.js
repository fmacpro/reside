import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndExtract } from '../src/fetchUrl.js';
import { TestServer } from './test-server.js';

describe('fetchUrl - extractContent (no network)', () => {
  it('rejects missing URL', async () => {
    const result = await fetchAndExtract();
    assert.equal(result.success, false);
    assert.match(result.error, /URL is required/);
  });

  it('rejects empty URL', async () => {
    const result = await fetchAndExtract('');
    assert.equal(result.success, false);
    assert.match(result.error, /URL is required/);
  });

  it('rejects invalid URL format', async () => {
    const result = await fetchAndExtract('not-a-url');
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid URL format/);
  });

  it('rejects non-http protocol', async () => {
    const result = await fetchAndExtract('ftp://example.com');
    assert.equal(result.success, false);
    assert.match(result.error, /Only http and https URLs are supported/);
  });

  it('rejects javascript: URLs', async () => {
    const result = await fetchAndExtract('javascript:void(0)');
    assert.equal(result.success, false);
    assert.match(result.error, /Only http and https URLs are supported/);
  });

  it('fails gracefully on unreachable host', async () => {
    const result = await fetchAndExtract('https://192.0.2.1/nonexistent', { timeout: 1000 });
    assert.equal(result.success, false);
    assert.ok(result.error); // Should have some error message
  });
});

describe('fetchUrl - local test server', () => {
  let server;

  before(async () => {
    server = new TestServer();
    await server.start();
  });

  after(async () => {
    if (server) await server.stop();
  });

  it('extracts content from a simple page', async () => {
    const result = await fetchAndExtract(server.url + '/simple.html');
    assert.equal(result.success, true);
    assert.ok(result.title, 'Should extract a title');
    assert.ok(result.content.length > 100, 'Should extract substantial content');
    assert.match(result.content, /Simple Test Page/, 'Content should include the page heading');
  });

  it('extracts content from an article page', async () => {
    const result = await fetchAndExtract(server.url + '/article.html');
    assert.equal(result.success, true);
    assert.equal(result.title, 'Node.js 22 Released with New Features');
    assert.ok(result.content.length > 500, 'Should extract substantial article content');
    assert.match(result.content, /Node\.js 22/, 'Content should mention Node.js 22');
    assert.match(result.content, /V8 JavaScript engine/, 'Content should mention V8');
    assert.match(result.content, /WebSocket/, 'Content should mention WebSocket');
  });

  it('returns error for 404 page', async () => {
    const result = await fetchAndExtract(server.url + '/nonexistent.html');
    assert.equal(result.success, false);
    assert.match(result.error, /HTTP 404/, 'Should report 404 error');
  });
});
