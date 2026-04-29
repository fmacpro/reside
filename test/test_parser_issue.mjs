import { parseToolCalls } from '../src/parser.js';

// Test 1: Raw JSON with extra closing brace (the actual Qwen 3.5 response)
const content1 = `{"tool": "edit_file", "arguments":
{"file_path": "random-number-test-2/app.js", "new_string": "function main() {\\n  console.log('test');\\n}", "path": "random-number-test-2/app.js"}
}}`;

console.log('=== Test 1: Raw JSON with extra brace ===');
const result1 = parseToolCalls(content1);
console.log('toolCalls:', result1.toolCalls.length);
console.log('text:', JSON.stringify(result1.text));
console.log('');

// Test 2: Text before JSON (LLM explains then calls tool)
const content2 = `I'll fix the app by adding date/time display.

{"tool": "edit_file", "arguments": {"file_path": "random-number-test-2/app.js", "new_string": "function main() {\\n  console.log('test');\\n}"}}
}}`;

console.log('=== Test 2: Text before JSON ===');
const result2 = parseToolCalls(content2);
console.log('toolCalls:', result2.toolCalls.length);
console.log('text:', JSON.stringify(result2.text));
console.log('');

// Test 3: The actual response from the agent output
// The LLM responded with text after read_file re-prompt
// The response was: {"tool": "edit_file", "arguments": {...}}
// But the agent showed it as text (🤖 prefix)
// This means the parser returned toolCalls: [] and text containing the JSON
// Let's check what happens when the JSON has unescaped double quotes inside
const content3 = `{"tool": "edit_file", "arguments": {"file_path": "random-number-test-2/app.js", "new_string": "function main() {
  console.log("test");
}"}}`;

console.log('=== Test 3: Unescaped double quotes in content ===');
const result3 = parseToolCalls(content3);
console.log('toolCalls:', result3.toolCalls.length);
console.log('text:', JSON.stringify(result3.text));
console.log('');

// Test 4: What if the LLM's response had the JSON on one line with actual newlines?
const content4 = `{"tool": "edit_file", "arguments":
{"file_path": "random-number-test-2/app.js", "new_string": "function main() {
  console.log('test');
}", "path": "random-number-test-2/app.js"}
}}`;

console.log('=== Test 4: Multi-line with actual newlines in content ===');
const result4 = parseToolCalls(content4);
console.log('toolCalls:', result4.toolCalls.length);
console.log('text:', JSON.stringify(result4.text));
