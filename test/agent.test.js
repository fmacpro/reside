/**
 * Tests for the Agent class, specifically the finish() interception logic.
 * These tests mock the OllamaClient to simulate LLM responses without
 * requiring a real Ollama server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/agent.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/**
 * Create a mock OllamaClient that returns predefined responses.
 * This allows testing the Agent loop without a real Ollama server.
 */
function createMockOllama(responses) {
  let callIndex = 0;
  return {
    chat: async (_model, _messages, _options) => {
      if (callIndex >= responses.length) {
        // Default: return a text-only response to end the loop
        return { message: { content: 'Task completed.' } };
      }
      const response = responses[callIndex];
      callIndex++;
      return { message: { content: response } };
    },
  };
}

/**
 * Create a temporary workspace and Agent for testing.
 */
function createTestAgent(responses, configOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reside-agent-test-'));
  const config = {
    ...DEFAULT_CONFIG,
    workdir: dir,
    autoCommit: false,
    maxIterations: 10,
    ...configOverrides,
  };
  const agent = new Agent(config);
  agent.ollama = createMockOllama(responses);
  return { dir, agent };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('Agent — finish() interception', () => {
  it('allows finish() when an entry point file (app.js) was written', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write app.js entry point
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}',
      // Second LLM response: call finish()
      '{"tool": "finish", "arguments": {"message": "App created"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create a simple app');

    // Should have finished successfully (entry point was written)
    assert.equal(result.finished, true, 'Session should finish when entry point exists');
    assert.ok(result.toolCalls >= 2, 'Should have executed at least 2 tool calls');

    // Verify the file was actually created
    assert.equal(existsSync(join(dir, 'my-app', 'app.js')), true, 'app.js should exist');

    cleanup(dir);
  });

  it('intercepts finish() when no code files were written at all', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: only write a data file (no code)
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/recipes.json", "content": "{}"}}',
      // Second LLM response: call finish() — should be intercepted
      '{"tool": "finish", "arguments": {"message": "Done"}}',
      // Third LLM response: text-only (simulating LLM acknowledging the guidance)
      'I understand, I need to write the code file first.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create a recipe app');

    // Should NOT have finished — finish() was intercepted
    assert.equal(result.finished, true, 'Session should end (text-only response after interception)');

    // Verify the agent injected the interception system message
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const interceptionMessage = systemMessages.find(m =>
      m.content.includes('called finish() without writing') &&
      m.content.includes('entry point')
    );
    assert.ok(interceptionMessage, 'Should inject interception system message mentioning entry point');

    // Verify the agent tracked the interception
    assert.equal(agent._finishWithoutSourceCount, 1, 'Should have intercepted finish() once');

    cleanup(dir);
  });

  it('intercepts finish() when only helper modules (not entry point) were written', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write helper modules but NOT an entry point
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/recipes.js", "content": "export const recipes = [];"}}',
      // Second LLM response: call finish() — should be intercepted because no entry point
      '{"tool": "finish", "arguments": {"message": "Done"}}',
      // Third LLM response: text-only
      'I see, I need to write the entry point.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create a recipe app');

    // Should NOT have finished — finish() was intercepted
    assert.equal(result.finished, true, 'Session should end (text-only response after interception)');

    // Verify the interception system message mentions entry point
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const interceptionMessage = systemMessages.find(m =>
      m.content.includes('called finish() without writing') &&
      m.content.includes('entry point')
    );
    assert.ok(interceptionMessage, 'Should inject interception system message mentioning entry point');

    // Verify the agent tracked the interception
    assert.equal(agent._finishWithoutSourceCount, 1, 'Should have intercepted finish() once');

    // Verify the helper module WAS written (it's a valid code file, just not an entry point)
    assert.equal(existsSync(join(dir, 'my-app', 'recipes.js')), true, 'recipes.js should exist');

    cleanup(dir);
  });

  it('allows finish() when entry point is written after helper modules', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write helper module
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/recipes.js", "content": "export const recipes = [];"}}',
      // Second LLM response: write the entry point
      '{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "import { recipes } from \\"./recipes.js\\";\\nconsole.log(recipes);"}}',
      // Third LLM response: call finish() — should be allowed now
      '{"tool": "finish", "arguments": {"message": "App created"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create a recipe app');

    // Should have finished successfully (entry point was written after helpers)
    assert.equal(result.finished, true, 'Session should finish when entry point exists');

    // Verify both files exist
    assert.equal(existsSync(join(dir, 'my-app', 'recipes.js')), true, 'recipes.js should exist');
    assert.equal(existsSync(join(dir, 'my-app', 'app.js')), true, 'app.js should exist');

    cleanup(dir);
  });

  it('force-ends session after repeated finish() calls without entry point', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write data file only
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/data.json", "content": "{}"}}',
      // Second LLM response: call finish() — first interception
      '{"tool": "finish", "arguments": {"message": "Done"}}',
      // Third LLM response: call finish() AGAIN without writing entry point — force end
      '{"tool": "finish", "arguments": {"message": "Done for real"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have finished (force-ended after second finish() call)
    assert.equal(result.finished, true, 'Session should end after repeated finish() calls');

    // Verify the agent tracked the interception count
    assert.equal(agent._finishWithoutSourceCount, 2, 'Should have intercepted finish() twice');

    cleanup(dir);
  });

  it('does NOT intercept finish() when entry point was written via edit_file', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write a stub entry point
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "// stub"}}',
      // Second LLM response: edit the entry point to add real code
      '{"tool": "edit_file", "arguments": {"path": "my-app/app.js", "old_string": "// stub", "new_string": "console.log(\\"Hello\\");"}}',
      // Third LLM response: call finish() — should be allowed (entry point exists)
      '{"tool": "finish", "arguments": {"message": "Done"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have finished successfully
    assert.equal(result.finished, true, 'Session should finish when entry point exists');

    cleanup(dir);
  });

  it('injects proactive guidance after npm install when no entry point exists', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + npm init
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "execute_command", "arguments": {"command": "npm init -y", "cwd": "my-app"}}',
      // Second LLM response: npm install (should trigger proactive guidance)
      '{"tool": "execute_command", "arguments": {"command": "npm install left-pad", "cwd": "my-app"}}',
      // Third LLM response: text-only (simulating LLM acknowledging guidance)
      'I need to write the entry point file now.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response
    assert.equal(result.finished, true, 'Session should end');

    // Verify proactive guidance was injected after npm install
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const guidanceMessage = systemMessages.find(m =>
      m.content.includes('Dependencies installed successfully') &&
      m.content.includes('write the main application entry point')
    );
    assert.ok(guidanceMessage, 'Should inject proactive guidance after npm install');

    cleanup(dir);
  });

  it('does NOT inject proactive guidance after npm install when entry point already exists', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write entry point
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}',
      // Second LLM response: npm install (entry point already exists, no guidance needed)
      '{"tool": "execute_command", "arguments": {"command": "npm install left-pad", "cwd": "my-app"}}',
      // Third LLM response: call finish()
      '{"tool": "finish", "arguments": {"message": "Done"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have finished successfully
    assert.equal(result.finished, true, 'Session should finish');

    // Verify NO proactive guidance was injected (entry point already existed)
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const guidanceMessage = systemMessages.find(m =>
      m.content.includes('Dependencies installed successfully')
    );
    assert.equal(guidanceMessage, undefined, 'Should NOT inject proactive guidance when entry point exists');

    cleanup(dir);
  });
});
