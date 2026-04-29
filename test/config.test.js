import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Save original env
const ORIGINAL_ENV = { ...process.env };

describe('config', () => {
  const configDir = join(homedir(), '.config', 'reside');
  const configPath = join(configDir, 'config.json');

  before(() => {
    // Ensure clean state
    if (existsSync(configPath)) {
      rmSync(configPath);
    }
    // Clear env vars
    delete process.env.RESIDE_MODEL;
    delete process.env.RESIDE_WORKDIR;
    delete process.env.RESIDE_OLLAMA_HOST;
  });

  after(() => {
    // Restore env
    for (const key of Object.keys(ORIGINAL_ENV)) {
      process.env[key] = ORIGINAL_ENV[key];
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
  });

  it('loads default config when no file or env vars exist', async () => {
    // Dynamic import to get fresh module state
    const config = await import('../src/config.js');
    const cfg = config.loadConfig();
    assert.equal(cfg.ollamaHost, 'http://localhost:11434');
    assert.equal(cfg.model, 'qwen3.5:latest');
    assert.match(cfg.workdir, /workdir$/);
    assert.equal(cfg.maxIterations, 25);
    assert.equal(cfg.autoCommit, true);
    assert.ok(cfg.systemPrompt.includes('Reside'));
  });

  it('reads config from file', async () => {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify({ model: 'test-model:latest', maxIterations: 5 }), 'utf-8');

    const config = await import('../src/config.js');
    const cfg = config.loadConfig();
    assert.equal(cfg.model, 'test-model:latest');
    assert.equal(cfg.maxIterations, 5);
    // Should still have defaults for other fields
    assert.equal(cfg.ollamaHost, 'http://localhost:11434');

    // Cleanup
    rmSync(configPath);
  });

  it('env vars override file config', async () => {
    process.env.RESIDE_MODEL = 'env-model:latest';
    process.env.RESIDE_OLLAMA_HOST = 'http://other:11434';

    const config = await import('../src/config.js');
    const cfg = config.loadConfig();
    assert.equal(cfg.model, 'env-model:latest');
    assert.equal(cfg.ollamaHost, 'http://other:11434');

    delete process.env.RESIDE_MODEL;
    delete process.env.RESIDE_OLLAMA_HOST;
  });

  it('saves config to file', async () => {
    const config = await import('../src/config.js');
    config.saveConfig({ model: 'saved-model:7b' });

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(saved.model, 'saved-model:7b');

    // Cleanup
    rmSync(configPath);
  });

  it('merges saved config with existing', async () => {
    const config = await import('../src/config.js');
    config.saveConfig({ model: 'first:latest' });
    config.saveConfig({ maxIterations: 10 });

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(saved.model, 'first:latest');
    assert.equal(saved.maxIterations, 10);

    // Cleanup
    rmSync(configPath);
  });
});
