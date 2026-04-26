import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, containsToolCalls } from '../src/parser.js';

describe('parseToolCalls', () => {
  it('returns empty toolCalls for plain text', () => {
    const result = parseToolCalls('Hello, how can I help?');
    assert.equal(result.text, 'Hello, how can I help?');
    assert.deepEqual(result.toolCalls, []);
  });

  it('parses a single Qwen 2.5 style tool call in markdown fence', () => {
    const input = 'I will create a file.\n```json\n{"tool": "write_file", "arguments": {"path": "test.txt", "content": "hello"}}\n```';
    const result = parseToolCalls(input);
    assert.match(result.text, /I will create a file/);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'test.txt', content: 'hello' });
  });

  it('parses a single Qwen 3.5 style raw JSON tool call', () => {
    const input = '{"tool": "read_file", "arguments": {"path": "index.js"}}';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'index.js' });
  });

  it('parses a Qwen 3.5 style tool call with thinking field', () => {
    const input = '{"thinking": "I need to read the file first", "tool": "list_files", "arguments": {"path": "."}}';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'list_files');
    assert.deepEqual(result.toolCalls[0].arguments, { path: '.' });
  });

  it('parses multiple tool calls as a JSON array (Qwen 2.5 style)', () => {
    const input = '```json\n[\n{"tool": "create_directory", "arguments": {"path": "my-app"}},\n{"tool": "write_file", "arguments": {"path": "my-app/index.js", "content": "console.log(1)"}}\n]\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].tool, 'create_directory');
    assert.equal(result.toolCalls[1].tool, 'write_file');
  });

  it('parses multiple tool calls as a raw JSON array (Qwen 3.5 style)', () => {
    const input = '[\n{"tool": "create_directory", "arguments": {"path": "test"}},\n{"tool": "finish", "arguments": {"message": "done"}}\n]';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].tool, 'create_directory');
    assert.equal(result.toolCalls[1].tool, 'finish');
  });

  it('handles text before and after tool calls', () => {
    const input = 'Let me start.\n{"tool": "write_file", "arguments": {"path": "a.js", "content": "// code"}}\nDone!';
    const result = parseToolCalls(input);
    assert.match(result.text, /Let me start/);
    assert.match(result.text, /Done!/);
    assert.equal(result.toolCalls.length, 1);
  });

  it('returns empty for invalid JSON in fence', () => {
    const input = '```json\n{invalid json}\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 0);
  });

  it('returns empty for empty input', () => {
    const result = parseToolCalls('');
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, []);
  });

  it('handles tool calls with numeric and boolean arguments', () => {
    const input = '{"tool": "execute_command", "arguments": {"command": "node test.js"}}';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].arguments.command, 'node test.js');
  });

  it('prefers fenced JSON over raw JSON when both present', () => {
    const input = 'Some text\n```json\n{"tool": "finish", "arguments": {"message": "from fence"}}\n```\n{"tool": "finish", "arguments": {"message": "from raw"}}';
    const result = parseToolCalls(input);
    // Should find the fenced one
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].arguments.message, 'from fence');
  });
});

describe('containsToolCalls', () => {
  it('returns true for fenced JSON', () => {
    assert.equal(containsToolCalls('text ```json {"tool":"x"} ```'), true);
  });

  it('returns true for raw JSON tool call', () => {
    assert.equal(containsToolCalls('{"tool": "read_file", "arguments": {}}'), true);
  });

  it('returns true for raw JSON array of tool calls', () => {
    assert.equal(containsToolCalls('[{"tool":"a"},{"tool":"b"}]'), true);
  });

  it('returns false for plain text', () => {
    assert.equal(containsToolCalls('Just some text'), false);
  });

  it('returns false for non-tool JSON objects', () => {
    assert.equal(containsToolCalls('{"name": "test"}'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(containsToolCalls(''), false);
  });
});
