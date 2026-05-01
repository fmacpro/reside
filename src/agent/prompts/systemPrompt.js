import { ToolEngine } from '../../tools/index.js';

/**
 * Build the system prompt with tool descriptions and workspace context.
 *
 * @param {import('../../workspace.js').WorkspaceManager} workspaceManager
 * @param {import('../../config.js').ResideConfig} config
 * @returns {string}
 */
export function buildSystemPrompt(workspaceManager, config) {
  const toolDescriptions = new ToolEngine('/tmp').getToolDescriptions();
  const apps = workspaceManager.listApps();
  const appsList = apps.length > 0
    ? `\nExisting apps/projects in this workdir:\n${apps.map(a => `  - ${a.name}/`).join('\n')}`
    : '\nThe workdir is empty. Create new app directories as needed.';

  // Add model-specific instructions for DeepSeek models
  // DeepSeek models are trained to use a specific XML-like tool call format
  // (<｜tool▁calls▁begin｜>) but Reside uses a JSON-based format. We need to
  // explicitly tell DeepSeek to use JSON format instead.
  const modelName = config.model || '';
  const isDeepSeek = /^deepseek/i.test(modelName);
  // Models that tend to default to CommonJS require() syntax instead of ESM import/export.
  // These models need explicit, forceful instructions to use ESM syntax.
  const needsEsmForce = /^qwen2\.5-coder|^codellama|^starcoder|^phi/i.test(modelName);

  let modelSpecificPrompt = '';
  if (isDeepSeek) {
    modelSpecificPrompt = `
 
## CRITICAL — Tool Call Format
 
You MUST use the JSON format for ALL tool calls. Do NOT use any other format.
 
CORRECT format for a single tool call:
{"tool": "tool_name", "arguments": {"arg1": "val1"}}
 
CORRECT format for multiple tool calls:
[{"tool": "tool_name", "arguments": {...}}, {"tool": "tool_name2", "arguments": {...}}]
 
You can include normal text before or after tool calls.
 
When you receive a tool result, it will be in this format:
{"tool": "tool_name", "arguments": {...}, "result": "success", "output": "..."}
 
The "result" field will be "success" or "error". The "output" field contains the result data.
 
IMPORTANT: Do NOT use <｜tool▁calls▁begin｜> or <｜tool▁call▁begin｜> or <｜tool▁sep｜> or <｜tool▁call▁end｜> or <｜tool▁calls▁end｜> tags. These are NOT valid in this system. Only use the JSON format shown above.
 
IMPORTANT: Do NOT wrap tool calls in \`\`\`json code fences. Just output the raw JSON object or array directly.
 
Example of what you should output:
{"tool": "search_web", "arguments": {"query": "current population of the world"}}
 
Example of what you should NOT output (wrong format):
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>search_web
\`\`\`json
{"query": "current population of the world"}
\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 
Always use the JSON format. Never use the XML-like format.`;
  } else if (needsEsmForce) {
    modelSpecificPrompt = `
 
## CRITICAL — ES Module (ESM) Syntax Required
 
All new Node.js apps use ES modules ("type": "module" in package.json). The system automatically adds "type": "module" after npm init -y.
 
You MUST use import/export syntax. You MUST NOT use require() or module.exports.
 
  ✅ CORRECT — ESM syntax (use this):
    import { readFileSync, writeFileSync } from "node:fs";
    import axios from "axios";
    export function getWeather(city) { ... }
    export default class App { ... }
 
  ❌ WRONG — CommonJS syntax (will crash with "require is not defined in ES module scope"):
    const fs = require("fs");              // ❌ require() does NOT work in ESM
    const axios = require("axios");        // ❌ require() does NOT work in ESM
    module.exports = { getWeather };       // ❌ module.exports does NOT work in ESM
    exports.getWeather = ...;              // ❌ exports does NOT work in ESM
 
  ❌ WRONG — node-fetch (will crash with ERR_REQUIRE_ESM):
    const fetch = require("node-fetch");   // ❌ node-fetch v3+ is ESM-only
    import fetch from "node-fetch";        // ❌ fetch() is globally available, no import needed
 
  ✅ CORRECT — use global fetch() (available in Node.js 18+, no import needed):
    const response = await fetch("https://wttr.in/London?format=j1");
    const data = await response.json();
 
  ✅ CORRECT — JSON imports in ESM (use "with { type: 'json' }" assertion):
    import data from "./file.json" with { type: "json" };
 
  ✅ CORRECT — __dirname replacement in ESM:
    import { fileURLToPath } from "node:url";
    import { dirname } from "node:path";
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
 
  ✅ CORRECT — dynamic import in ESM:
    const module = await import("some-package");
 
  ✅ CORRECT — using require() in ESM (only when absolutely necessary):
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const pkg = require("./some-commonjs-package.cjs");
 
REMEMBER:
  - Do NOT edit package.json to remove "type": "module" — that is NEVER the right fix
  - Do NOT create .cjs files as a workaround — .cjs files use CommonJS (require/module.exports), NOT ESM
  - If you get "require is not defined in ES module scope", fix the code to use import/export — do NOT change package.json
  - fetch() is globally available in Node.js 18+ — do NOT install or import node-fetch
  - For JSON file imports, ALWAYS use "with { type: 'json' }" assertion

## Node.js Built-in Modules — Do NOT Install These

The following modules are built into Node.js and are available natively. Do NOT try to install them via npm — they are already available without any installation. Simply import them directly:

  import fs from "node:fs";              // File system: readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, watch, createReadStream, createWriteStream
  import path from "node:path";          // Path utilities: join, resolve, dirname, basename, extname, relative, normalize, parse, format, sep, delimiter
  import os from "node:os";              // Operating system: hostname, platform, arch, cpus(), totalmem, freemem, networkInterfaces, homedir, tmpdir, userInfo, type, release, uptime, loadavg, EOL
  import http from "node:http";          // HTTP server/client: createServer, request, get, Server, Agent
  import https from "node:https";        // HTTPS server/client: createServer, request, get, Agent
  import url from "node:url";            // URL parsing: URL, URLSearchParams, fileURLToPath, format, resolve, parse
  import util from "node:util";          // Utilities: promisify, inspect, format, types, deprecate, callbackify
  import events from "node:events";      // Event emitter: EventEmitter, once, on, getEventListeners
  import stream from "node:stream";      // Streams: Readable, Writable, Transform, Duplex, pipeline, finished, PassThrough
  import buffer from "node:buffer";      // Buffer: Buffer, Blob, atob, btoa, resolveObjectURL
  import crypto from "node:crypto";      // Cryptography: randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, randomUUID, generateKeyPair, sign, verify
  import assert from "node:assert";      // Assertion: strict, ok, equal, deepEqual, throws, rejects, doesNotThrow
  import net from "node:net";            // TCP: createServer, createConnection, connect, Socket, Server
  import dns from "node:dns";            // DNS: lookup, resolve, resolve4, resolve6, resolveMx, resolveTxt, resolveSrv, reverse, promises
  import dgram from "node:dgram";        // UDP: createSocket, Socket
  import readline from "node:readline";  // Readline: createInterface, Interface, clearLine, clearScreenDown, cursorTo, emitKeypressEvents, moveCursor
  import tls from "node:tls";            // TLS/SSL: createServer, connect, createSecureContext, TLSSocket, Server
  import zlib from "node:zlib";          // Compression: gzip, gunzip, deflate, inflate, brotliCompress, brotliDecompress, createGzip, createGunzip
  import querystring from "node:querystring";  // Query string: parse, stringify, escape, unescape
  import string_decoder from "node:string_decoder";  // String decoder: StringDecoder
  import timers from "node:timers";      // Timers: setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate, promises
  import tty from "node:tty";            // TTY: WriteStream, ReadStream, isatty
  import vm from "node:vm";              // Virtual machine: runInThisContext, runInNewContext, runInContext, compileFunction, Script
  import worker_threads from "node:worker_threads";  // Workers: Worker, isMainThread, parentPort, workerData, threadId, MessageChannel, MessagePort
  import cluster from "node:cluster";    // Clustering: Worker, isPrimary, isMaster, fork, setupPrimary, schedulingPolicy, settings
  import module from "node:module";      // Modules: createRequire, builtinModules, isBuiltin, register, syncBuiltinESMExports, findSourceMap
  import process from "node:process";    // Process: env, argv, cwd, exit, nextTick, stdout, stderr, stdin, platform, arch, pid, ppid, uptime, hrtime, memoryUsage, cpuUsage, resourceUsage, kill, on, emit, chdir, umask, umask, getuid, getgid, setuid, setgid, getgroups, setgroups, initgroups, chmod, chown, abort, dlopen, reallyExit, features, release, config, allowedNodeEnvironmentFlags, report, version, versions, execPath, execArgv, debugPort, hasUncaughtExceptionCaptureCallback, setUncaughtExceptionCaptureCallback, binding, _rawDebug, _fatalException, _exiting, _startProfilerIdleNotifier, _stopProfilerIdleNotifier
  import console from "node:console";    // Console: Console, log, error, warn, info, debug, trace, table, time, timeEnd, timeLog, group, groupEnd, groupCollapsed, clear, count, countReset, assert, dir, dirxml, profile, profileEnd, timeStamp, context
  import perf_hooks from "node:perf_hooks";  // Performance: performance, PerformanceObserver, monitorEventLoopDelay, createHistogram
  import async_hooks from "node:async_hooks";  // Async hooks: createHook, executionAsyncId, triggerAsyncId, executionAsyncResource, AsyncLocalStorage, AsyncResource
  import diagnostics_channel from "node:diagnostics_channel";  // Diagnostics: Channel, subscribe, unsubscribe, hasSubscribers, channel, tracingChannel
  import child_process from "node:child_process";  // Child processes: exec, execSync, spawn, spawnSync, fork, execFile, execFileSync
  import inspector from "node:inspector";  // Inspector: open, close, url, waitForDebugger, Session, console
  import wasi from "node:wasi";          // WASI: WASI, WASIError, WASIExitError
  import test from "node:test";          // Test runner: describe, it, test, before, after, beforeEach, afterEach, mock, run, suite
  import assert from "node:assert/strict";  // Strict assertions
  import path from "node:path/posix";    // POSIX path (always uses forward slashes)
  import path from "node:path/win32";    // Windows path (always uses backslashes)
  import fs from "node:fs/promises";     // Promise-based file system: readFile, writeFile, access, mkdir, readdir, stat, unlink, rename, copyFile, appendFile, rm, chmod, chown, lstat, readlink, realpath, symlink, truncate, utimes, opendir, open, readv, writev, watch, constants
  import timers from "node:timers/promises";  // Promise-based timers: setTimeout, setInterval, setImmediate, scheduler
  import dns from "node:dns/promises";   // Promise-based DNS: lookup, resolve, resolve4, resolve6, resolveMx, resolveTxt, resolveSrv, reverse, resolveAny, resolveCaa, resolveCname, resolveNaptr, resolveNs, resolvePtr, resolveSoa, resolveSrv, resolveTxt
  import stream from "node:stream/promises";  // Promise-based streams: pipeline, finished, Readable.from, Readable.toArray, Writable.fromWeb, Readable.fromWeb, Transform.fromWeb, Writable.toWeb, Readable.toWeb, Transform.toWeb
  import readline from "node:readline/promises";  // Promise-based readline: createInterface, Interface

  // Also available as subpath imports:
  import { sep } from "node:path";       // Path separator
  import { EOL } from "node:os";         // OS end-of-line marker
  import { Buffer } from "node:buffer";  // Buffer class
  import { URL } from "node:url";        // URL class
  import { performance } from "node:perf_hooks";  // Performance API

## Prefer Built-in Modules Over External Packages

Before installing any npm package, ask yourself: "Can I do this with a Node.js built-in module?"

  ✅ Built-in (no install needed):                    ❌ External package (avoid):
  - File I/O → fs, fs/promises                        - fs-extra, graceful-fs (use fs/promises instead)
  - Path manipulation → path                          - path-exists, path-is-inside (use fs.accessSync instead)
  - HTTP server → http, https                         - express (only if you need complex routing)
  - CLI input → readline, readline/promises           - readline-sync, enquirer, prompts (readline is built-in)
  - System info → os                                  - os-utils, systeminformation (os is built-in; only use systeminformation for GPU info)
  - Command execution → child_process                 - execa, shelljs (child_process is built-in)
  - Crypto → crypto                                   - bcrypt, bcryptjs, argon2 (crypto is built-in; only use bcrypt if you need bcrypt-specific algorithm)
  - URL parsing → url                                 - url-parse, querystring (url is built-in)
  - Events → events                                   - eventemitter3 (events is built-in)
  - Assertions → assert                               - chai, should, expect (assert is built-in; use assert/strict for strict mode)
  - DNS → dns                                         - dns2, dns-packet (dns is built-in)
  - Streaming → stream                                - through2, pump, pumpify (stream is built-in; use stream/promises for promise-based)
  - Timers → timers, timers/promises                  - (no external package needed)
  - Console output → console                          - chalk (only if you need colors; otherwise console.log is fine)
  - JSON parsing → JSON.parse (built-in global)       - (no external package needed)
  - fetch() → global fetch (Node.js 18+)              - node-fetch, axios (only use axios if you need interceptors)
  - WebSocket → ws (this IS an external package)      - (ws is the standard, no built-in alternative)

When you DO need an external package, prefer packages that support ESM (type: module). Check the package's npm page to see if it supports ESM. If a package is ESM-only, that's fine — your project uses ESM too.`;
  }

  return `${config.systemPrompt}\n\n## Available Tools\n\n${toolDescriptions}\n\n## Workdir\nYou are working in: ${workspaceManager.getPath()}\nCreate each app in its own subdirectory (e.g., my-app/). Each app directory gets its own git repository automatically when created via create_directory.${appsList}\nAlways use relative paths.${modelSpecificPrompt}`;
}
