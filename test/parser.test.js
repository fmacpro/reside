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
  it('parses DeepSeek XML-like format with single tool call (no args)', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.deepEqual(result.toolCalls[0].arguments, {});
  });

  it('parses DeepSeek XML-like format with single tool call and args on same line', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n<｜tool▁sep｜>path<｜tool▁sep｜>test-app/app.js\n<｜tool▁sep｜>content<｜tool▁sep｜>console.log("hello");\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.equal(result.toolCalls[0].arguments.path, 'test-app/app.js');
    assert.equal(result.toolCalls[0].arguments.content, 'console.log("hello");');
  });

  it('parses DeepSeek XML-like format with multi-line argument value', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n<｜tool▁sep｜>path\n<｜tool▁sep｜>test-app/app.js\n<｜tool▁sep｜>content\n<｜tool▁sep｜>const x = 1;\nconst y = 2;\nconsole.log(x + y);\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.equal(result.toolCalls[0].arguments.path, 'test-app/app.js');
    assert.equal(result.toolCalls[0].arguments.content, 'const x = 1;\nconst y = 2;\nconsole.log(x + y);');
  });

  it('parses DeepSeek XML-like format with text before and after', () => {
    const input = 'Let me search for that.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n<｜tool▁sep｜>query<｜tool▁sep｜>current weather\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>\nI will use the results.';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.equal(result.toolCalls[0].arguments.query, 'current weather');
    assert.match(result.text, /Let me search for that/);
    assert.match(result.text, /I will use the results/);
  });

  it('parses DeepSeek XML-like format with multiple tool calls', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>create_directory\n<｜tool▁sep｜>path<｜tool▁sep｜>my-app\n<｜tool▁call▁end｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_file\n<｜tool▁sep｜>path<｜tool▁sep｜>my-app/app.js\n<｜tool▁sep｜>content<｜tool▁sep｜>console.log("hello");\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].tool, 'create_directory');
    assert.equal(result.toolCalls[0].arguments.path, 'my-app');
    assert.equal(result.toolCalls[1].tool, 'write_file');
    assert.equal(result.toolCalls[1].arguments.path, 'my-app/app.js');
    assert.equal(result.toolCalls[1].arguments.content, 'console.log("hello");');
  });

  it('parses DeepSeek XML-like format with execute_command and cwd', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>execute_command\n<｜tool▁sep｜>command<｜tool▁sep｜>npm init -y\n<｜tool▁sep｜>cwd<｜tool▁sep｜>my-app\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'execute_command');
    assert.equal(result.toolCalls[0].arguments.command, 'npm init -y');
    assert.equal(result.toolCalls[0].arguments.cwd, 'my-app');
  });

  it('parses DeepSeek hybrid format: XML tags for tool name, JSON fence for args', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n```json\n{"query": "current population of the world"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'current population of the world' });
  });

  it('parses DeepSeek hybrid format with text before', () => {
    const input = 'Let me search for that.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n```json\n{"query": "current population"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.equal(result.toolCalls[0].arguments.query, 'current population');
    assert.match(result.text, /Let me search for that/);
  });

  it('parses DeepSeek hybrid format with multiple tool calls', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n```json\n{"query": "current population"}\n```<｜tool▁call▁end｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_current_time\n```json\n{"timezone": "UTC"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.equal(result.toolCalls[0].arguments.query, 'current population');
    assert.equal(result.toolCalls[1].tool, 'get_current_time');
    assert.equal(result.toolCalls[1].arguments.timezone, 'UTC');
  });

  it('parses DeepSeek hybrid format with no args (just tool name)', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'search_web');
    assert.deepEqual(result.toolCalls[0].arguments, {});
  });

  it('repairs template literal backtick strings in JSON (single line)', () => {
    // LLM often uses backticks instead of double quotes for string values
    const input = '```json\n{"tool": "write_file", "arguments": {"path": "test.txt", "content": `hello world`}}\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.equal(result.toolCalls[0].arguments.path, 'test.txt');
    assert.equal(result.toolCalls[0].arguments.content, 'hello world');
  });

  it('repairs template literal backtick strings with multi-line content', () => {
    // LLM often uses multi-line template literals for code content
    const input = '```json\n{"tool": "write_file", "arguments": {"path": "app.js", "content": `const x = 1;\nconst y = 2;\nconsole.log(x + y);`}}\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.equal(result.toolCalls[0].arguments.path, 'app.js');
    assert.equal(result.toolCalls[0].arguments.content, 'const x = 1;\nconst y = 2;\nconsole.log(x + y);');
  });

  it('repairs template literal with ${} interpolation markers', () => {
    // LLM sometimes includes ${variable} in template literals
    const input = '```json\n{"tool": "write_file", "arguments": {"path": "app.js", "content": `const port = ${PORT};`}}\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].arguments.content, 'const port = ${PORT};');
  });

  it('repairs JSON with trailing commas', () => {
    const input = '{"tool": "write_file", "arguments": {"path": "test.txt", "content": "hello",}}';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].arguments.content, 'hello');
  });

  it('repairs JSON with single quotes', () => {
    const input = "{'tool': 'write_file', 'arguments': {'path': 'test.txt', 'content': 'hello'}}";
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].arguments.content, 'hello');
  });

  it('repairs the exact LLM output from the snake-game test', () => {
    // This is the exact pattern the LLM outputs — backtick template literal for code content
    const input = '```json\n{"tool": "write_file", "arguments": {"path": "snake-game/app.js", "content": `\nconst readline = require(\'readline\');\n\nconst rl = readline.createInterface(\n{\n  input: process.stdin,\n  output: process.stdout\n}\n);\n\nconst width = 20;\nconst height = 20;\nlet snake =\n[{ x: 10, y: 10 }]\n;\nlet direction = \'right\';\nlet food =\n{ x: Math.floor(Math.random() * width), y: Math.floor(Math.random() * height) }\n;\n\nfunction drawBoard()\n{\n  const board = Array.from({ length: height }, () => Array(width).fill(\' \'));\n  snake.forEach(segment => board[segment.y][segment.x] = \'O\');\n  board[food.y][food.x] = \'*\';\n  console.clear();\n  board.forEach(row => console.log(row.join(\'\')));\n}\n`}}\n```';
    const result = parseToolCalls(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].tool, 'write_file');
    assert.equal(result.toolCalls[0].arguments.path, 'snake-game/app.js');
    // Should contain the code content (backtick string converted to JSON string)
    assert.ok(result.toolCalls[0].arguments.content.includes('readline'));
    assert.ok(result.toolCalls[0].arguments.content.includes('drawBoard'));
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

  it('returns true for DeepSeek XML-like format', () => {
    assert.equal(containsToolCalls('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>'), true);
  });

  it('returns true for DeepSeek format with text before', () => {
    assert.equal(containsToolCalls('Let me search.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>'), true);
  });
});
