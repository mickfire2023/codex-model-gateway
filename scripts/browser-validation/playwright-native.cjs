'use strict';

// Opt-in synthetic localhost validation only. CHROME_TEST_APPROVED=1 confirms
// the operator's explicit decision to run real model calls and an isolated
// Chrome instance. Only seven guarded test-page tools receive temporary automatic
// approval for this process; user configuration and everyday tool permissions
// are never edited. No signed-in browser profile is opened.
// Reports omit prompts, arguments, image bytes, provider/error bodies, credentials,
// management URLs and browser profile data. Synthetic screenshots remain local
// in the separate temporary results directory; never upload that directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {makeFixture} = require('./fixture.cjs');

const TOOLS = Object.freeze(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form', 'browser_type', 'browser_take_screenshot', 'browser_close']);
const ALLOWED_TOOLS = new Set(TOOLS);
const RUNTIME = path.resolve(process.env.CHROME_TEST_PLAYWRIGHT_CLI || path.join(os.homedir(), 'Documents/CodexChromeBridge/runtimes/playwright-mcp-0.0.83/node_modules/@playwright/mcp/cli.js'));
const GUARD = path.join(__dirname, 'mcp-stdio-guard.cjs');
const MAIN = path.resolve(process.env.CHROME_TEST_GATEWAY_DIRECTORY || path.join(os.homedir(), 'Documents/CodexModelGateway'));
const BINARY = process.env.CODEX_GATEWAY_TEST_CLIENT || 'codex.exe';
const TIMEOUT_MS = 240000;
const tomlString = value => JSON.stringify(String(value));
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9_./@+-]{1,200}$/.test(value);

function classify(value) {
  const text = String(value || '').toLowerCase();
  if (/permission|security|access denied|not allowed to access|blocked by policy|blocked by.*(?:origin|navigation)|unauthorized|forbidden|origin.{0,100}(?:denied|blocked|not permitted)|\b(?:401|403)\b/.test(text)) return 'permission_or_security_rejection';
  if (/model_cooldown|cooldown|rate.limit|quota|\b429\b|额度|冷却/.test(text)) return 'upstream_cooldown_or_quota';
  if (/timeout|timed out|超时/.test(text)) return 'timeout';
  if (/image|vision|multimodal|unsupported_image/.test(text)) return 'image_compatibility_error';
  if (/not found|unknown model|model_not_enabled|unsupported model/.test(text)) return 'model_unavailable';
  if (/connect|transport|socket|pipe|server.*(?:failed|unavailable)/.test(text)) return 'tool_connection_error';
  return 'generation_or_tool_error';
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    const name = row.tool || row.toolName || row.name;
    const event = row.event || row.kind || row.type;
    const safeEvent = typeof event === 'string' && /^[a-z_]{1,40}$/.test(event) ? event : 'audit_event';
    const status = ['allowed', 'blocked', 'success', 'error', 'access_denied'].includes(row.status) ? row.status : null;
    const denied = row.denied === true || row.allowed === false || /reject|denied|blocked/.test(safeEvent) || status === 'blocked' || status === 'access_denied';
    const types = Array.isArray(row.types) ? row.types.filter(type => ['text', 'image', 'audio', 'resource', 'resource_link'].includes(type)) : [];
    return [{event: safeEvent, ...(ALLOWED_TOOLS.has(name) ? {tool: name} : {}), ...(status ? {status} : {}), ...(types.length ? {types} : {}), ...(denied ? {securityRejected: true} : {})}];
  });
}

function promptFor(url, vision) {
  const base = `Test only the synthetic local page ${url}. Use ONLY the seven chrome_test MCP tools: ${TOOLS.join(', ')}. Do not use any shell, filesystem, network library, browser script/evaluate/run_code, HTML source, developer tools, other browser, browser history, unrelated page or tab. Do not install anything, grant any permission, alter browser settings or bypass any restriction. If any permission, security, origin or access restriction occurs, report the failure and stop immediately.\n\nUse browser_navigate to open the exact supplied URL. Read the visible Reading token through browser_snapshot. Click Advance exactly once. Enter the visible Reading token into Receipt using browser_type or browser_fill_form, then click Apply receipt. Read a fresh snapshot and confirm Receipt accepted and Count: 1. Next use browser_take_screenshot without an explicit filename so the screenshot is saved in the configured test output directory. `;
  const visual = vision
    ? 'Read the VIS-... code drawn on the canvas solely from the returned screenshot image. The code is deliberately absent from the accessible snapshot. Never inspect page source, scripts, variables or hidden data to obtain it. Enter the visually read code into Visual answer, click Verify visual answer, and confirm Visual accepted with a fresh snapshot. '
    : 'This model is configured for text input only. Do not request or read image bytes. The screenshot tool is configured to omit image responses; confirm the tool saved a screenshot and continue by reading browser_snapshot. Do not guess the visual code or attempt the Visual answer challenge. ';
  return base + visual + 'Close the synthetic page with browser_close, then reply exactly chrome-native-check-ok if the requested checks succeeded. Otherwise report the failure accurately. Never claim success based only on intention.';
}

async function checkModel({model, vision, baseUrl, fixture, runDirectory}) {
  const {url, run} = fixture.add(model);
  const origin = new URL(url).origin;
  const auditFile = path.join(runDirectory, 'guard-audit.jsonl');
  const outputDirectory = path.join(runDirectory, 'screenshots');
  fs.mkdirSync(outputDirectory, {recursive: true});
  const playwrightArgs = ['--browser', 'chrome', '--isolated', '--allowed-origins', origin, '--image-responses', vision ? 'allow' : 'omit', '--output-dir', outputDirectory, '--viewport-size', '1280x900'];
  if (process.env.CHROME_TEST_HEADED !== '1') playwrightArgs.push('--headless');
  const mcpArgs = [GUARD, RUNTIME, ...playwrightArgs];
  const mcpConfig = '{command=' + tomlString(process.execPath) + ',args=[' + mcpArgs.map(tomlString).join(',') + '],env={CHROME_TEST_AUDIT_FILE=' + tomlString(auditFile) + ',CHROME_TEST_ORIGIN=' + tomlString(origin) + '},enabled_tools=[' + TOOLS.map(tomlString).join(',') + '],default_tools_approval_mode="approve",startup_timeout_sec=30,tool_timeout_sec=25,required=true}';
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-m', model,
    '-c', 'model_provider="gateway-browser-check"',
    '-c', 'model_providers.gateway-browser-check.name="Local gateway browser compatibility check"',
    '-c', 'model_providers.gateway-browser-check.base_url=' + tomlString(baseUrl),
    '-c', 'model_providers.gateway-browser-check.wire_api="responses"',
    '-c', 'model_providers.gateway-browser-check.requires_openai_auth=true',
    '-c', 'model_providers.gateway-browser-check.supports_websockets=true',
    '-c', 'model_providers.gateway-browser-check.stream_idle_timeout_ms=30000',
    '-c', 'model_providers.gateway-browser-check.stream_max_retries=0',
    '-c', 'model_providers.gateway-browser-check.request_max_retries=0',
    '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false',
    '-c', 'features.js_repl=false',
    '-c', 'web_search="disabled"', '-c', 'mcp_servers.chrome_test=' + mcpConfig,
    promptFor(url, vision)];
  const started = Date.now();
  const child = spawn(BINARY, args, {cwd: runDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const eventTypes = [], calls = [], errors = new Set(), diagnostics=[];
  let buffer = '', stderrBuffer = '', modelReportedComplete = false, timedOut = false, securityRejected = false;
  const inspectFailure = value => {
    const failure = classify(value);
    diagnostics.push({category: failure});
    errors.add(failure);
    if (failure === 'permission_or_security_rejection') { securityRejected = true; child.kill(); }
  };
  const inspectLine = line => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (typeof row.type === 'string' && /^[a-z_.]{1,80}$/.test(row.type)) eventTypes.push(row.type);
    if (row.type === 'error' || row.type === 'turn.failed') inspectFailure(row.message || row.error?.message);
    const item = row.item;
    if (item?.type === 'mcp_tool_call') {
      const tool = item.tool || item.name;
      if (ALLOWED_TOOLS.has(tool)) calls.push({tool, event: row.type, ...(typeof item.status === 'string' && /^[a-z_]{1,30}$/.test(item.status) ? {status: item.status} : {})});
      if (item.error) inspectFailure(typeof item.error === 'string' ? item.error : item.error.message || JSON.stringify(item.error));
      if (item.result?.isError || item.result?.is_error) inspectFailure(JSON.stringify(item.result.content || []));
    }
    if (row.type === 'item.completed' && item?.type === 'agent_message') {
      modelReportedComplete ||= String(item.text || '').trim() === 'chrome-native-check-ok';
      if (/permission|security|access denied|blocked by policy|origin.*(?:denied|blocked)/i.test(String(item.text || ''))) inspectFailure(item.text);
    }
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); inspectLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    if (buffer.length > 20000000) { errors.add('oversized_event'); child.kill(); }
  });
  child.stderr.on('data', chunk => {
    stderrBuffer = (stderrBuffer + chunk.toString('utf8')).slice(-16000);
    if (/blocked by policy|permission denied|security policy|origin.{0,100}(?:denied|not permitted)/i.test(stderrBuffer)) inspectFailure(stderrBuffer);
  });
  const monitor = setInterval(() => {
    if (readAudit(auditFile).some(row => row.securityRejected)) { securityRejected = true; errors.add('permission_or_security_rejection'); child.kill(); }
  }, 250);
  const timer = setTimeout(() => { timedOut = true; errors.add('timeout'); child.kill(); }, TIMEOUT_MS);
  const exitCode = await new Promise(resolve => { child.on('error', () => { errors.add('client_start_failed'); resolve(null); }); child.on('close', resolve); });
  clearInterval(monitor); clearTimeout(timer);
  if (buffer.trim()) inspectLine(buffer);
  const audit = readAudit(auditFile);
  if (audit.some(row => row.securityRejected)) { securityRejected = true; errors.add('permission_or_security_rejection'); }
  const actualEvents = run.events.map(event => ({kind: ['advance', 'receipt', 'visual'].includes(event.kind) ? event.kind : 'unknown', ...(typeof event.dom === 'boolean' ? {dom: event.dom} : {}), ...(typeof event.visual === 'boolean' ? {visual: event.visual} : {}), ...(Number.isSafeInteger(event.count) ? {count: event.count} : {})}));
  const calledTools = [...new Set([...calls.map(row => row.tool), ...audit.map(row => row.tool).filter(Boolean)])].sort();
  const screenshots = fs.readdirSync(outputDirectory, {withFileTypes: true}).filter(file => file.isFile() && /\.(?:png|jpe?g|webp)$/i.test(file.name)).length;
  const domPassed = actualEvents.some(event => event.kind === 'receipt' && event.dom === true && event.count === 1) && actualEvents.filter(event => event.kind === 'advance').length === 1;
  const screenshotResults = audit.filter(row => row.event === 'tool_result' && row.tool === 'browser_take_screenshot' && row.status === 'success');
  const screenshotReturnedImage = screenshotResults.some(row => row.types?.includes('image'));
  const screenshotPassed = screenshotResults.length > 0 && screenshots > 0 && (!vision || screenshotReturnedImage);
  const visualPassed = vision ? actualEvents.some(event => event.kind === 'visual' && event.visual === true && event.count === 1) : null;
  const passed = exitCode === 0 && !timedOut && !securityRejected && domPassed && screenshotPassed && (!vision || visualPassed === true);
  return {model,vision,passed,exitCode,elapsedMs:Date.now()-started,securityRejected,errors:[...errors],diagnostics,domPassed,screenshotPassed,screenshotReturnedImage,visualPassed,modelReportedComplete,toolNames:calledTools,clientEvents:eventTypes,toolEvents:calls,guardEvents:audit,pageEvents:actualEvents};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log([
      'Synthetic local Chrome/model validation (real provider calls may consume quota).',
      'After explicitly choosing this test: CHROME_TEST_APPROVED=1 node playwright-native.cjs <exact-model-id> | --all',
      'Only the seven guarded synthetic-page tools receive process-local automatic approval; user configuration is untouched.',
      'Default runtime: Documents/CodexChromeBridge/node_modules/@playwright/mcp/cli.js',
      'Default gateway: Documents/CodexModelGateway',
      'Optional environment: CHROME_TEST_PLAYWRIGHT_CLI, CHROME_TEST_GATEWAY_DIRECTORY, CODEX_GATEWAY_TEST_CLIENT,',
      'CHROME_TEST_HEADED=1, CHROME_TEST_EXCLUDE_MODELS=comma-separated-models, CHROME_TEST_OUTPUT_DIRECTORY.',
      'Results use an independent OS temporary directory by default; only synthetic screenshots and redacted metadata are retained.'
    ].join('\n'));
    return;
  }
  if (process.env.CHROME_TEST_APPROVED !== '1') throw new Error('Explicit alternate-browser approval is required before running this prepared harness.');
  if (args.length !== 1 || (args[0] !== '--all' && !validModel(args[0]))) throw new Error('Select one exact model ID or --all.');
  for (const file of [RUNTIME, GUARD]) if (!fs.existsSync(file)) throw new Error('The prepared official runtime or origin guard is missing.');
  const catalog = JSON.parse(fs.readFileSync(path.join(MAIN, 'combined-models.json'), 'utf8')).models.filter(model => model.visibility === 'list' && validModel(model.slug));
  const excluded=new Set((process.env.CHROME_TEST_EXCLUDE_MODELS||'').split(',').filter(validModel));
  const selected = (args[0] === '--all' ? catalog : catalog.filter(model => model.slug === args[0])).filter(model=>!excluded.has(model.slug));
  if (!selected.length) throw new Error('The selected model is not in the visible installed model catalog.');
  const settings = JSON.parse(fs.readFileSync(path.join(MAIN, 'private/settings.json'), 'utf8'));
  if (!Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || !/^[a-f0-9]{64}$/.test(settings.routeToken)) throw new Error('Unexpected installed gateway settings.');
  const baseUrl = `http://127.0.0.1:${settings.port}/${settings.routeToken}/backend-api/codex`;
  const outputParent = process.env.CHROME_TEST_OUTPUT_DIRECTORY ? path.resolve(process.env.CHROME_TEST_OUTPUT_DIRECTORY) : os.tmpdir();
  if (!fs.existsSync(outputParent) || !fs.statSync(outputParent).isDirectory()) throw new Error('The selected output parent directory does not exist.');
  const outputRoot = path.join(outputParent, 'codex-chrome-validation-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(outputRoot, {recursive: false});
  const reportPath = path.join(outputRoot, 'report.json');
  const fixture = makeFixture();
  await fixture.start();
  const results = [];
  let abortedForSecurity = false;
  try {
    for (const model of selected) {
      const runDirectory = path.join(outputRoot, 'model-' + String(results.length + 1).padStart(2, '0'));
      fs.mkdirSync(runDirectory);
      console.log(JSON.stringify({event:'model_started',model:model.slug,vision:model.input_modalities?.includes('image')===true}));
      const result = await checkModel({model:model.slug,vision:model.input_modalities?.includes('image')===true,baseUrl,fixture,runDirectory});
      results.push(result);
      abortedForSecurity = result.securityRejected;
      const report = {method:'isolated Chrome through official Playwright MCP and exact-origin guard',modelCount:selected.length,completed:results.length,abortedForSecurity,results};
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({event:'model_completed',model:result.model,passed:result.passed,domPassed:result.domPassed,screenshotPassed:result.screenshotPassed,visualPassed:result.visualPassed,elapsedMs:result.elapsedMs,errors:result.errors,securityRejected:result.securityRejected,reportPath}));
      if (abortedForSecurity) break;
    }
  } finally { await fixture.close(); }
  console.log(JSON.stringify({event:'validation_completed',selectedModels:selected.length,completed:results.length,passed:results.filter(result=>result.passed).length,abortedForSecurity,reportPath}));
  if (abortedForSecurity || results.some(result => !result.passed)) process.exitCode = 1;
}

main().catch(error => { console.error(/^(Explicit alternate|Select one|The prepared|The selected|Unexpected installed)/.test(error.message) ? error.message : 'The prepared browser check could not complete; no raw diagnostic data was printed.'); process.exitCode = 1; });
