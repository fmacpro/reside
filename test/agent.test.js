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
      m.content.includes('Project initialized successfully') &&
      m.content.includes('structure your app with controllers')
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
      m.content.includes('Dependencies installed successfully') || m.content.includes('Project initialized successfully')
    );
    assert.equal(guidanceMessage, undefined, 'Should NOT inject proactive guidance when entry point exists');

    cleanup(dir);
  });
});

describe('Agent — test_app retry without code changes (Issue 3 fix)', () => {
  it('re-prompts instead of force-ending when test_app is called without code changes', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write a BROKEN app.js (throws at runtime)
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "throw new Error(\\"bug\\");"}}',
      // Second LLM response: call test_app (first time, FAILS)
      '{"tool": "test_app", "arguments": {}}',
      // Third LLM response: call test_app AGAIN without any code changes — should re-prompt, not force-end
      '{"tool": "test_app", "arguments": {}}',
      // Fourth LLM response: text-only (simulating LLM acknowledging the re-prompt)
      'I need to read the file and fix the code first.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response (not force-ended)
    assert.equal(result.finished, true, 'Session should end with text response');

    // Verify the agent injected a re-prompt message (not a force-end)
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('did NOT modify any code since the last test')
    );
    assert.ok(repromptMessage, 'Should inject re-prompt message about not modifying code');

    // Verify the session did NOT end with finished=true from the test_app handler
    // (it should have ended naturally with the text-only response)
    assert.equal(agent._hasModifiedCodeSinceLastTest, false, 'Flag should remain false since no code was modified');

    cleanup(dir);
  });

  it('allows test_app to proceed when code WAS modified since last test', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + write app.js
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"v1\\");"}}',
      // Second LLM response: call test_app (first time, succeeds)
      '{"tool": "test_app", "arguments": {}}',
      // Third LLM response: write_file to overwrite the file (modifies code — write_file always succeeds)
      '{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"v2\\");"}}',
      // Fourth LLM response: call test_app again — should be allowed (code was modified via write_file)
      '{"tool": "test_app", "arguments": {}}',
      // Fifth LLM response: text-only
      'Done.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response
    assert.equal(result.finished, true, 'Session should end');

    // Verify the agent tracked the code modification (write_file sets _hasModifiedCodeSinceLastTest = true)
    // After test_app runs, the flag should be reset to false
    assert.equal(agent._hasModifiedCodeSinceLastTest, false, 'Flag should be reset after test_app');

    cleanup(dir);
  });
});

describe('Agent — text-only response after npm init guidance (Issue 2 fix)', () => {
  it('re-prompts when LLM responds with text-only after npm init guidance', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir + npm init
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "execute_command", "arguments": {"command": "npm init -y", "cwd": "my-app"}}',
      // Second LLM response: text-only (simulating Qwen 3.5 stopping after npm init)
      'The project is initialized. I should now write the source code file.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response
    assert.equal(result.finished, true, 'Session should end');

    // Verify the agent injected a re-prompt for text-only after npm init guidance
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('STOP responding with text') &&
      m.content.includes('call write_file() NOW')
    );
    assert.ok(repromptMessage, 'Should inject re-prompt telling LLM to stop with text and call write_file()');

    cleanup(dir);
  });

  it('re-prompts when LLM responds with text-only after create_directory guidance', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: create dir only (triggers create_directory guidance)
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}',
      // Second LLM response: text-only (simulating LLM stopping after create_directory)
      'I have created the directory. Now I need to write the source code.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response
    assert.equal(result.finished, true, 'Session should end');

    // Verify the agent injected a re-prompt for text-only after create_directory guidance
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('STOP responding with text') &&
      m.content.includes('call write_file() NOW')
    );
    assert.ok(repromptMessage, 'Should inject re-prompt telling LLM to stop with text and call write_file()');

  });
});

describe('Agent — single tool call without test/finish (Issue 5 fix)', () => {
  it('re-prompts when LLM writes code but does not test or finish', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write a file but NO test_app or finish
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}',
      // Second LLM response: text-only (simulating LLM acknowledging the re-prompt)
      'I need to test the app now.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create a simple app');

    // Should have ended with text response (not force-ended)
    assert.equal(result.finished, true, 'Session should end with text response');

    // Verify the agent injected a re-prompt message about testing/finishing
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('did NOT test the app or call finish()')
    );
    assert.ok(repromptMessage, 'Should inject re-prompt message about testing/finishing');

    // Verify the tracking state was set
    assert.equal(agent._hadWriteInCurrentIteration, true, 'Should have tracked write in current iteration');
    assert.equal(agent._hadTestOrFinishInCurrentIteration, false, 'Should NOT have tracked test/finish');
    // Counter stays at 0 because app.js is a new file — progress is detected, counter is reset
    assert.equal(agent._singleToolCallRepromptCount, 0, 'Should reset counter when new file is written (progress detected)');

    cleanup(dir);
  });

  it('force-ends session after repeated single-tool-call without test/finish (same file, no progress)', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write a file but NO test_app or finish
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}',
      // Second LLM response: text-only (first write is a NEW file — counter resets to 0)
      'I wrote the app.js file. Let me continue.',
      // Third LLM response: write the SAME file again (no progress — same path, counter = 1)
      '{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}',
      // Fourth LLM response: text-only (triggers re-prompt #1)
      'I updated the app.js file.',
      // Fifth LLM response: write the SAME file again (no progress — same path, counter = 2)
      '{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello World\\");"}}',
      // Sixth LLM response: text-only (triggers re-prompt #2)
      'I updated the app.js file again.',
      // Seventh LLM response: write the SAME file again (no progress — same path, counter = 3 — force-end)
      '{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello World Again\\");"}}',
      // Eighth LLM response: text-only (triggers re-prompt #3 — force-end)
      'I updated the app.js file once more.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have finished (force-ended after 3 re-prompts)
    assert.equal(result.finished, true, 'Session should end after repeated single-tool-call');

    // Verify the agent tracked the reprompt count
    // First write is a new file (counter reset to 0), then 3 writes of the same file (counter = 3)
    assert.equal(agent._singleToolCallRepromptCount, 3, 'Should have reprompted 3 times');

    // Verify the force-end system message was injected
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const forceEndMessage = systemMessages.find(m =>
      m.content.includes('written code multiple times without testing')
    );
    assert.ok(forceEndMessage, 'Should inject force-end message after 3 re-prompts');

    cleanup(dir);
  });

  it('does NOT re-prompt when test_app is called after write_file', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write a file AND call test_app
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}\n{"tool": "test_app", "arguments": {}}',
      // Second LLM response: text-only
      'Done.',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have ended with text response
    assert.equal(result.finished, true, 'Session should end');

    // Verify NO re-prompt was injected (test_app was called)
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('did NOT test the app or call finish()')
    );
    assert.equal(repromptMessage, undefined, 'Should NOT inject re-prompt when test_app was called');

    cleanup(dir);
  });

  it('does NOT re-prompt when finish is called after write_file', async () => {
    const { dir, agent } = createTestAgent([
      // First LLM response: write a file AND call finish
      '{"tool": "create_directory", "arguments": {"path": "my-app"}}\n{"tool": "write_file", "arguments": {"path": "my-app/app.js", "content": "console.log(\\"Hello\\");"}}\n{"tool": "finish", "arguments": {"message": "Done"}}',
    ]);

    await agent.startSession();
    const result = await agent.processUserMessage('Create an app');

    // Should have finished (entry point was written)
    assert.equal(result.finished, true, 'Session should finish');

    // Verify NO re-prompt was injected (finish was called)
    const systemMessages = agent.messages.filter(m => m.role === 'system');
    const repromptMessage = systemMessages.find(m =>
      m.content.includes('did NOT test the app or call finish()')
    );
    assert.equal(repromptMessage, undefined, 'Should NOT inject re-prompt when finish was called');

    cleanup(dir);
  });
});

describe('Agent — system prompt modification guidance (Issue 1 fix)', () => {
  it('includes modification guidance in the system prompt', async () => {
    const { dir, agent } = createTestAgent([
      '{"tool": "finish", "arguments": {"message": "Done"}}',
    ]);

    await agent.startSession();

    // Find the system prompt message
    const systemMessage = agent.messages.find(m => m.role === 'system');
    assert.ok(systemMessage, 'System prompt should exist');

    // Verify the system prompt includes guidance about reading the full file first
    assert.ok(
      systemMessage.content.includes('read_file() to read the FULL source code'),
      'System prompt should include guidance about reading the full file first'
    );
    assert.ok(
      systemMessage.content.includes('identify ALL the changes needed'),
      'System prompt should include guidance about identifying all changes'
    );

    cleanup(dir);
  });
});
