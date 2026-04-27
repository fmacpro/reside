import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndExtract } from '../src/fetchUrl.js';

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
