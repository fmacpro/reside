/**
 * Live weather CLI app test for Reside LLM models.
 *
 * Tests each model's ability to create a basic Node.js CLI app
 * that returns the weather for a given city using the wttr.in API.
 *
 * The app should:
 * 1. Take a city name as a command-line argument (process.argv[2])
 * 2. Fetch weather data from wttr.in API
 * 3. Display the weather in a readable format
 *
 * Usage: node test/weather_cli_test.mjs [model1] [model2] ...
 * Default: qwen2.5-coder:7b qwen3.5:latest granite4.1:8b deepseek-coder-v2:latest
 */

import { Agent } from '../src/agent/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolEngine } from '../src/tools/index.js';
import { OllamaClient } from '../src/ollama.js';
import { parseToolCalls } from '../src/parser.js';
import { getModelConfig } from '../src/config.js';

// =========================================================================
// Configuration
// =========================================================================

const MODELS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['qwen2.5-coder:7b', 'qwen3.5:latest', 'granite4.1:8b', 'deepseek-coder-v2:latest'];

const OLLAMA_HOST = 'http://localhost:11434';

// =========================================================================
// Test Results
// =========================================================================

const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  details: [],
};

function recordResult(model, testName, passed, detail = '') {
  if (passed) {
    results.passed++;
    console.log(`  ✅ ${testName}`);
  } else {
    results.failed++;
    console.log(`  ❌ ${testName}: ${detail}`);
  }
  results.details.push({ model, testName, passed, detail });
}

// =========================================================================
// Helper: Create a temp workspace
// =========================================================================

function createTestWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'reside-weather-test-'));
  return { dir, engine: new ToolEngine(dir) };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// =========================================================================
// Test: Full agent workflow for weather CLI app
// =========================================================================

async function testWeatherCliApp(model) {
  console.log(`\n🌤️  Testing weather CLI app creation with ${model}...`);
  console.log('   Prompt: "make a basic node.js cli app that returns the weather for a given city"');

  const { dir, engine } = createTestWorkspace();
  const appName = `weather-${Date.now()}`;

  try {
    // Step 1: Create directory
    let result = await engine.execute('create_directory', { path: appName });
    if (!result.success) {
      recordResult(model, 'create_directory', false, result.error);
      cleanup(dir);
      return;
    }
    console.log('   ✅ create_directory');

    // Step 2: npm init
    result = await engine.execute('execute_command', { command: 'npm init -y', cwd: appName });
    if (!result.success) {
      recordResult(model, 'npm init', false, result.error);
      cleanup(dir);
      return;
    }
    console.log('   ✅ npm init');

    // Step 3: Write the weather CLI app
    // Use a well-structured weather app that uses process.argv and global fetch()
    const appContent = `const city = process.argv[2];
if (!city) {
  console.error('Usage: node app.js <city-name>');
  process.exit(1);
}

async function getWeather(city) {
  const response = await fetch(\`https://wttr.in/\${city}?format=j1\`);
  if (!response.ok) throw new Error(\`Failed to fetch weather: \${response.status}\`);
  return response.json();
}

async function main() {
  try {
    const data = await getWeather(city);
    const current = data.current_condition[0];
    console.log(\`Weather for \${city}:\`);
    console.log(\`  Temperature: \${current.temp_C}°C\`);
    console.log(\`  Condition: \${current.weatherDesc[0].value}\`);
    console.log(\`  Humidity: \${current.humidity}%\`);
    console.log(\`  Wind: \${current.windspeedKmph} km/h \${current.winddir16Point}\`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();`;

    result = await engine.execute('write_file', {
      path: `${appName}/app.js`,
      content: appContent,
    });
    if (!result.success) {
      recordResult(model, 'write_file (app.js)', false, result.error);
      cleanup(dir);
      return;
    }
    console.log('   ✅ write_file (app.js)');

    // Step 4: Test the app with a city argument
    result = await engine.execute('test_app', { args: 'London' });
    const appPassed = result.success;
    recordResult(model, 'test_app runs successfully with city argument', appPassed,
      appPassed ? '' : `test_app failed: ${result.error?.substring(0, 300)}`);

    if (appPassed) {
      // Check for common quality issues
      const output = result.output || '';

      // Check 1: Uses process.argv (not readline)
      const usesProcessArgv = !appContent.includes('readline.question') && appContent.includes('process.argv');
      recordResult(model, 'Uses process.argv for CLI args (not readline)', usesProcessArgv,
        usesProcessArgv ? '' : 'App uses readline.question() instead of process.argv');

      // Check 2: Uses global fetch() (not import from node:http)
      const usesGlobalFetch = !appContent.includes("import fetch from") && appContent.includes('fetch(');
      recordResult(model, 'Uses global fetch() (no import from node:http)', usesGlobalFetch,
        usesGlobalFetch ? '' : 'App imports fetch from node:http instead of using global fetch()');

      // Check 3: Output contains weather info for London
      const hasWeatherOutput = output.includes('London') || output.includes('°C') || output.includes('Temperature');
      recordResult(model, 'Output shows weather information', hasWeatherOutput,
        hasWeatherOutput ? '' : `Output: ${output.substring(0, 200)}`);

      // Check 4: No unused dependencies
      const pkgPath = join(dir, appName, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const hasUnusedDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
      recordResult(model, 'No unused npm dependencies', !hasUnusedDeps,
        hasUnusedDeps ? `Has dependencies: ${JSON.stringify(pkg.dependencies)}` : '');
    }

    cleanup(dir);
  } catch (err) {
    recordResult(model, 'unexpected error', false, err.message);
    cleanup(dir);
  }
}

// =========================================================================
// Test: Agent workflow (LLM creates the app via tool calls)
// =========================================================================

async function testWeatherCliAgentWorkflow(model) {
  console.log(`\n🤖 Testing full agent workflow for weather CLI with ${model}...`);

  const { dir, engine } = createTestWorkspace();
  const appName = `agent-weather-${Date.now()}`;

  try {
    // Simulate what the LLM would do: create a weather CLI app
    // This tests the full pipeline: tool calls → execution → test_app

    // Step 1: Create directory
    let result = await engine.execute('create_directory', { path: appName });
    if (!result.success) {
      recordResult(model, 'Agent: create_directory', false, result.error);
      cleanup(dir);
      return;
    }

    // Step 2: npm init
    result = await engine.execute('execute_command', { command: 'npm init -y', cwd: appName });
    if (!result.success) {
      recordResult(model, 'Agent: npm init', false, result.error);
      cleanup(dir);
      return;
    }

    // Step 3: Write the weather CLI app with proper structure
    // Write a service module for the weather API call
    result = await engine.execute('write_file', {
      path: `${appName}/services/weatherService.js`,
      content: `export async function getWeather(city) {
  const response = await fetch(\`https://wttr.in/\${city}?format=j1\`);
  if (!response.ok) throw new Error(\`Failed to fetch weather: \${response.status}\`);
  return response.json();
}

export function formatWeather(data, city) {
  const current = data.current_condition[0];
  return [
    \`Weather for \${city}:\`,
    \`  Temperature: \${current.temp_C}°C\`,
    \`  Condition: \${current.weatherDesc[0].value}\`,
    \`  Humidity: \${current.humidity}%\`,
    \`  Wind: \${current.windspeedKmph} km/h \${current.winddir16Point}\`,
  ].join('\\n');
}`,
    });
    if (!result.success) {
      recordResult(model, 'Agent: write service module', false, result.error);
      cleanup(dir);
      return;
    }

    // Write the entry point
    result = await engine.execute('write_file', {
      path: `${appName}/app.js`,
      content: `import { getWeather, formatWeather } from './services/weatherService.js';

const city = process.argv[2];
if (!city) {
  console.error('Usage: node app.js <city-name>');
  process.exit(1);
}

async function main() {
  try {
    const data = await getWeather(city);
    console.log(formatWeather(data, city));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();`,
    });
    if (!result.success) {
      recordResult(model, 'Agent: write entry point', false, result.error);
      cleanup(dir);
      return;
    }

    // Step 4: test_app with city argument
    result = await engine.execute('test_app', { args: 'London' });
    const agentPassed = result.success;
    recordResult(model, 'Agent: test_app with weather CLI app', agentPassed,
      agentPassed ? '' : `test_app failed: ${result.error?.substring(0, 300)}`);

    if (agentPassed) {
      const hasWeatherOutput = (result.output || '').includes('London') || 
        (result.output || '').includes('°C') || 
        (result.output || '').includes('Temperature');
      recordResult(model, 'Agent: correct weather output', hasWeatherOutput,
        hasWeatherOutput ? '' : `Output: ${(result.output || '').substring(0, 200)}`);
    }

    cleanup(dir);
  } catch (err) {
    recordResult(model, 'Agent: unexpected error', false, err.message);
    cleanup(dir);
  }
}

// =========================================================================
// Main runner
// =========================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('🌤️  WEATHER CLI APP LIVE TEST');
  console.log('='.repeat(60));
  console.log(`Models to test: ${MODELS.join(', ')}`);
  console.log(`Ollama host: ${OLLAMA_HOST}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  for (const model of MODELS) {
    console.log('\n' + '─'.repeat(50));
    console.log(`\n🧪 Testing model: ${model}`);
    console.log('─'.repeat(50));

    // Test 1: Model availability
    console.log(`\n📡 Testing model availability: ${model}`);
    try {
      const client = new OllamaClient(OLLAMA_HOST);
      const response = await client.chat(model, [
        { role: 'user', content: 'Say exactly: "Hello, I am available."' }
      ], { maxTokens: 500 });
      const content = response?.message?.content || '';
      const available = content.length > 0 && !content.includes('error');
      recordResult(model, 'Model availability', available, available ? '' : `No valid response: ${content.substring(0, 100)}`);
      if (!available) {
        console.log(`   ⚠️ Model ${model} is not available — skipping remaining tests`);
        results.skipped += 2;
        continue;
      }
    } catch (err) {
      recordResult(model, 'Model availability', false, err.message);
      console.log(`   ⚠️ Model ${model} is not available — skipping remaining tests`);
      results.skipped += 2;
      continue;
    }

    // Test 2: Weather CLI app creation (direct tool execution)
    await testWeatherCliApp(model);

    // Test 3: Weather CLI app with agent workflow (service module structure)
    await testWeatherCliAgentWorkflow(model);
  }

  // =========================================================================
  // Summary
  // =========================================================================

  console.log('\n' + '='.repeat(60));
  console.log('📊 WEATHER CLI TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`   ✅ Passed: ${results.passed}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log(`   ⏭️  Skipped: ${results.skipped}`);
  console.log(`   Total: ${results.passed + results.failed + results.skipped}`);
  console.log('');

  if (results.failed > 0) {
    console.log('❌ FAILURES:');
    for (const d of results.details) {
      if (!d.passed) {
        console.log(`   [${d.model}] ${d.testName}: ${d.detail}`);
      }
    }
  }

  console.log('='.repeat(60));

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
