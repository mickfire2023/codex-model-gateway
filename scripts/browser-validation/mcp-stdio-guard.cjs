'use strict';

// Test-only stdio guard. This does not drive a browser itself, grant access,
// replace MCP results, or retry a denied browser operation.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

const ALLOWED_TOOLS = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_take_screenshot', 'browser_close'
]);
const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);
const REFUSAL = /(?:access|permission|authori[sz]ation)\s+(?:is\s+)?(?:denied|refused|required)|not\s+authori[sz]ed|requires?\s+(?:user\s+)?(?:permission|approval|confirmation)|blocked\s+(?:by|due\s+to)\s+(?:the\s+)?(?:user|browser|security|safety|policy|permission)|(?:origin|url|navigation|browser).{0,100}(?:not\s+allowed|blocked|denied|refused|rejected)|(?:blocked|denied|refused|rejected).{0,100}(?:browser|origin|url|navigation|security|safety|permission|policy)|(?:安全|权限|授权).{0,30}(?:拒绝|禁止|不允许)|(?:拒绝|禁止).{0,30}(?:访问|权限|授权|来源)/i;

function approvedOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
      !origin.port || origin.username || origin.password || origin.pathname !== '/' ||
      origin.search || origin.hash || origin.origin !== String(value).replace(/\/$/, '')) {
    throw new Error('Invalid synthetic test origin.');
  }
  return origin.origin;
}

function isAllowedNavigation(value, origin) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.hostname === '127.0.0.1' &&
      url.protocol === 'http:' && !url.username && !url.password &&
      !url.search && !url.hash && /^\/check\/[a-f0-9]{1,128}$/i.test(url.pathname);
  } catch { return false; }
}

function safeName(name) { return ALLOWED_TOOLS.has(name) ? name : 'unapproved_tool'; }
function validateToolCall(call, {origin, pageReady = false} = {}) {
  const tool = call?.name;
  if (!ALLOWED_TOOLS.has(tool)) return {allowed: false, reason: 'tool_not_allowed'};
  if (tool === 'browser_navigate' && !isAllowedNavigation(call.arguments?.url, origin)) {
    return {allowed: false, reason: 'navigation_outside_test_page'};
  }
  if (tool !== 'browser_navigate' && !pageReady) return {allowed: false, reason: 'test_page_not_open'};
  const filename = call.arguments?.filename;
  if (tool === 'browser_take_screenshot' && filename != null &&
      (typeof filename !== 'string' || filename.includes('..') || !/^[a-z0-9][a-z0-9._-]{0,127}\.(?:png|jpe?g)$/i.test(filename))) {
    return {allowed: false, reason: 'screenshot_filename_outside_test'};
  }
  return {allowed: true};
}
function resultMetadata(message) {
  const result = message.result;
  const content = Array.isArray(result?.content) ? result.content : [];
  const types = [...new Set(content.map(part => CONTENT_TYPES.has(part?.type) ? part.type : 'unknown'))];
  // Inspect only error/refusal markers; never retain or log tool contents.
  const candidates = [message.error?.message, ...content.filter(part => part?.type === 'text').map(part => part.text)];
  const refused = candidates.some(value => typeof value === 'string' && REFUSAL.test(value));
  return {status: refused ? 'access_denied' : message.error || result?.isError ? 'error' : 'success', types};
}
function classifyDeniedResponse(message) {
  return resultMetadata(message).status === 'access_denied' ? 'access_denied' : null;
}

function main() {
  let origin;
  try { origin = approvedOrigin(process.env.CHROME_TEST_ORIGIN || ''); }
  catch { process.stderr.write('Chrome test guard requires an exact loopback test origin.\n'); process.exitCode = 2; return; }
  const cli = process.argv[2];
  if (!cli) { process.stderr.write('Chrome test guard requires the installed MCP CLI path.\n'); process.exitCode = 2; return; }

  const auditPath = process.env.CHROME_TEST_AUDIT_FILE;
  function audit(record) {
    if (!auditPath) return;
    try {
      // The caller selects this test-only audit location. Records contain no
      // request IDs, arguments, URLs, browser text, images, or raw errors.
      fs.mkdirSync(path.dirname(path.resolve(auditPath)), {recursive: true});
      fs.appendFileSync(auditPath, JSON.stringify({at: new Date().toISOString(), ...record}) + '\n', {mode: 0o600});
    } catch {
      process.stderr.write('Chrome test audit could not be written.\n');
      shutdown(2);
    }
  }

  const pending = new Map();
  let stopping = false, childExited = false, stopTimer, input, output;
  let pageReady = false;
  const child = spawn(process.execPath, [cli, ...process.argv.slice(3)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
  });

  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    input?.close();
    process.stdin.pause();
    if (!childExited) {
      child.stdin.end();
      // Official MCP gets EOF first so it can close its own browser cleanly.
      stopTimer = setTimeout(() => {
        if (!childExited) child.kill();
      }, 1500);
    }
  }
  function block(message, reason) {
    const tool = safeName(message.params?.name);
    audit({event: 'tool_call', tool, status: 'blocked', reason});
    if (Object.hasOwn(message, 'id')) process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: {isError: true, content: [{type: 'text', text: 'Chrome test guard rejected this operation: ' + reason + '.'}]}
    }) + '\n');
  }
  input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  output = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
  input.on('line', line => {
    if (stopping) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Invalid JSON-RPC input.'}}) + '\n');
      return;
    }
    if (message?.method === 'tools/call') {
      const tool = message.params?.name;
      const validation = validateToolCall(message.params, {origin, pageReady});
      if (!validation.allowed) return block(message, validation.reason);
      if (tool === 'browser_navigate') pageReady = false;
      if (Object.hasOwn(message, 'id')) pending.set(message.id, tool);
      audit({event: 'tool_call', tool, status: 'allowed'});
    }
    // Initialize, capabilities/list exchanges and permitted calls stay intact.
    if (!stopping) child.stdin.write(line + '\n');
  });
  output.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { /* Preserve child output exactly. */ }
    const tool = message && pending.get(message.id);
    let refused = false;
    if (tool) {
      pending.delete(message.id);
      const metadata = resultMetadata(message);
      audit({event: 'tool_result', tool, ...metadata});
      refused = metadata.status === 'access_denied';
      if (tool === 'browser_navigate') pageReady = metadata.status === 'success';
      if (tool === 'browser_close') pageReady = false;
    }
    // Genuine success and failure results are always returned without edits.
    process.stdout.write(line + '\n');
    if (refused) {
      audit({event: 'guard_stop', status: 'access_denied'});
      shutdown(3);
    }
  });
  // Official CLI diagnostics can contain paths or browser state. Drain them
  // without copying them into either the audit log or Codex diagnostic output.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => shutdown(2));
  child.on('error', () => {
    process.stderr.write('The installed Chrome MCP test process could not start.\n');
    shutdown(2);
  });
  child.on('close', code => {
    const finalCode = stopping ? process.exitCode : Number.isInteger(code) ? code : 1;
    childExited = true;
    stopping = true;
    process.exitCode = finalCode;
    clearTimeout(stopTimer);
    input.close(); output.close(); process.stdin.pause();
  });
  input.on('close', () => shutdown(0));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0));
  process.on('exit', () => { if (!childExited) child.kill(); });
}

if (require.main === module) main();
module.exports = {approvedOrigin, isAllowedNavigation, validateToolCall, resultMetadata, classifyDeniedResponse};
