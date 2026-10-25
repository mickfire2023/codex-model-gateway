'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {createHmac} = require('node:crypto');
const {createGateway} = require('../../gateway/gateway.cjs');
const {makeModelSlug} = require('../../gateway/provider-store.cjs');

const ROUTE_TOKEN = 'synthetic_admin_route_token';
const ROOT = '/' + ROUTE_TOKEN;
const PREFIX = ROOT + '/backend-api/codex';
const OLD_KEY = 'sk-synthetic_old_key_123456';
const NEW_KEY = 'sk-synthetic_new_key_123456';
const BAD_KEY = 'sk-synthetic_bad_key_123456';
const CUSTOM_KEY = 'synthetic-custom-provider-key';
const CUSTOM_ID = 'vendor/synthetic-model';
const CUSTOM_SLUG = makeModelSlug('synthetic-provider', CUSTOM_ID);
const GPT_MODEL = {slug: 'gpt-synthetic', display_name: 'Synthetic GPT', visibility: 'list', context_window: 128000, original_marker: 'preserve-exactly'};
const DS_MODEL = {slug: 'deepseek-synthetic', display_name: 'Synthetic DeepSeek', visibility: 'list', base_instructions: 'Synthetic coding assistant.'};
const csrf = action => createHmac('sha256', ROUTE_TOKEN).update(action === 'key' ? 'codex-gateway:admin:key-form:v1' : action === 'refresh' ? 'codex-gateway:admin:catalog-refresh:v1' : 'codex-gateway:admin:' + action + ':v2').digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function request(base, pathname, {method = 'GET', headers = {}, body} = {}) {
  const payload = body == null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), {method, headers: {...(payload ? {'content-length': payload.length} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks); let json;
        try { json = JSON.parse(raw.toString()); } catch {}
        resolve({status: res.statusCode, headers: res.headers, body: raw.toString(), raw, json});
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.admin-mock-'));
  fs.writeFileSync(path.join(directory, 'openai-models.json'), JSON.stringify({models: [GPT_MODEL]}));
  fs.writeFileSync(path.join(directory, 'deepseek-models.json'), JSON.stringify({models: [DS_MODEL]}));
  const observed = {upstream: [], validations: [], persisted: [], providerValidations: [], controls: [], credentialWrites: []};
  const state = {rejectPersist: false, providerStatus: 200};
  const credentialValues = new Map();
  const controlWaiters = [];
  const gptSse = 'event: response.completed\ndata: ' + JSON.stringify({type: 'response.completed', response: {id: 'gpt-synthetic-response', status: 'completed', model: GPT_MODEL.slug, output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'GPT unchanged bytes'}]}]}}) + '\n\n';
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); let body;
    try { body = JSON.parse(raw); } catch {}
    observed.upstream.push({path: req.url, method: req.method, headers: {...req.headers}, raw, body});
    if (req.url.startsWith('/gpt/models')) { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({models: [GPT_MODEL]})); return; }
    res.writeHead(200, {'content-type': 'text/event-stream', 'x-synthetic-upstream': 'preserved'});
    if (req.url.startsWith('/gpt/')) { res.end(gptSse); return; }
    const response = {id: 'synthetic-provider-response-' + observed.upstream.length, status: 'completed', model: body?.model, output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Provider synthetic OK'}]}]};
    res.end('data: ' + JSON.stringify({type: 'response.completed', response}) + '\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamBase = 'http://127.0.0.1:' + upstream.address().port;
  const gateway = createGateway({directory, routeToken: ROUTE_TOKEN, catalogSyncEnabled: false, stagingValidation: true}, {
    deepseekKey: OLD_KEY, gptBase: upstreamBase + '/gpt', deepseekBase: upstreamBase + '/ds',
    getCatalogCredentials: () => ({chatgptHeaders: {authorization: 'Bearer synthetic-gpt-account'}, deepseekKey: OLD_KEY, clientVersion: '0.164.0'}),
    validateDeepseekKey: async candidate => {
      observed.validations.push(candidate);
      if (candidate === BAD_KEY) throw Object.assign(new Error('Synthetic rejected credential'), {status: 401, code: 'synthetic_key_rejected'});
      return {ok: true};
    },
    persistDeepseekKey: async candidate => {
      if (state.rejectPersist) throw Object.assign(new Error('Synthetic storage failed'), {status: 500, code: 'synthetic_storage_failed'});
      observed.persisted.push(candidate);
    },
    credentialStore: {
      get: reference => credentialValues.get(reference) || '',
      set(reference, value) { observed.credentialWrites.push(reference); credentialValues.set(reference, value); },
      delete: reference => credentialValues.delete(reference)
    },
    providerRequest: async (url, requestOptions) => {
      observed.providerValidations.push({url: url.href, headers: {...requestOptions.headers}});
      const status = requestOptions.headers.authorization === 'Bearer synthetic-rejected-custom-key' ? 401 : state.providerStatus;
      return {status, body: JSON.stringify({data: [{id: CUSTOM_ID}]})};
    },
    runControl: action => {
      observed.controls.push(action);
      return new Promise((resolve, reject) => controlWaiters.push({action, resolve, reject}));
    },
    ...options
  });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const base = 'http://127.0.0.1:' + gateway.server.address().port;
  async function form(action, fields = {}, extra = {}) {
    const pairs = Array.isArray(fields) ? fields : Object.entries(fields);
    const body = new URLSearchParams([['csrf_token', csrf(action)], ...pairs]).toString();
    return request(base, ROOT + '/settings/' + action, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', origin: base, ...extra.headers}, body, ...extra, ...(extra.headers ? {headers: {'content-type': 'application/x-www-form-urlencoded', origin: base, ...extra.headers}} : {})});
  }
  const status = async () => (await request(base, ROOT + '/status')).json;
  async function inference(model, extra = {}, headers = {}) {
    return request(base, PREFIX + '/responses', {method: 'POST', headers: {authorization: 'Bearer synthetic-incoming-gpt-token', 'content-type': 'application/json', ...headers}, body: JSON.stringify({model, input: [{role: 'user', content: 'Synthetic test prompt'}], stream: false, ...extra})});
  }
  function providerFields(extra = {}) {
    return {id: 'synthetic-provider', name: 'Synthetic provider', baseUrl: upstreamBase + '/custom/v1', protocol: 'responses', apiKey: CUSTOM_KEY, modelId: CUSTOM_ID, displayName: 'Synthetic custom model', contextWindow: '16000', maxOutputTokens: '500', supportsTools: 'on', reasoningEfforts: 'none,high', ...extra};
  }
  t.after(async () => {
    gateway.socketRouter.close(); gateway.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    const checked = path.resolve(directory); const workspace = path.resolve(__dirname) + path.sep;
    assert.ok(checked.startsWith(workspace) && path.basename(checked).startsWith('.admin-mock-'));
    fs.rmSync(checked, {recursive: true, force: true});
  });
  return {base, directory, gateway, observed, state, controlWaiters, gptSse, form, status, inference, providerFields};
}

test('DeepSeek key verifies before save, invalid candidates and failed persistence preserve the working key', async t => {
  const f = await fixture(t);
  const rejected = await f.form('key', {key: BAD_KEY});
  assert.equal(rejected.status, 401); assert.deepEqual(f.observed.persisted, []);
  assert.match(rejected.body, /原密钥未更改/);
  await f.inference(DS_MODEL.slug); assert.equal(f.observed.upstream.at(-1).headers.authorization, 'Bearer ' + OLD_KEY);
  f.state.rejectPersist = true;
  const persistence = await f.form('key', {key: NEW_KEY}); assert.equal(persistence.status, 500);
  await f.inference(DS_MODEL.slug); assert.equal(f.observed.upstream.at(-1).headers.authorization, 'Bearer ' + OLD_KEY);
  assert.deepEqual(f.observed.persisted, []);
  f.state.rejectPersist = false;
  const saved = await f.form('key', {key: NEW_KEY}); assert.equal(saved.status, 303); assert.equal(saved.headers.location, ROOT + '/');
  assert.deepEqual(f.observed.persisted, [NEW_KEY]); assert.equal((await f.status()).validation.status, 'verified');
  await f.inference(DS_MODEL.slug); assert.equal(f.observed.upstream.at(-1).headers.authorization, 'Bearer ' + NEW_KEY);
  const publicStatus = JSON.stringify(await f.status());
  assert.doesNotMatch(publicStatus, /sk-synthetic_|synthetic-incoming-gpt-token/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.directory, 'gateway.log'), 'utf8'), /sk-synthetic_|synthetic-incoming-gpt-token/);
});

test('CSRF, token uniqueness, action binding and local Origin/Host checks prevent admin mutations', async t => {
  const f = await fixture(t);
  for (const body of [
    new URLSearchParams({key: NEW_KEY}).toString(),
    new URLSearchParams({csrf_token: '0'.repeat(64), key: NEW_KEY}).toString(),
    new URLSearchParams([['csrf_token', csrf('key')], ['csrf_token', csrf('key')], ['key', NEW_KEY]]).toString(),
    new URLSearchParams({csrf_token: csrf('restart'), key: NEW_KEY}).toString()
  ]) {
    const result = await request(f.base, ROOT + '/settings/key', {method: 'POST', headers: {origin: f.base, 'content-type': 'application/x-www-form-urlencoded'}, body});
    assert.equal(result.status, 403);
  }
  assert.equal((await f.form('key', {key: NEW_KEY}, {headers: {origin: 'https://synthetic-external.invalid'}})).status, 403);
  assert.equal((await f.form('key', {key: NEW_KEY}, {headers: {host: 'localhost:' + new URL(f.base).port}})).status, 403);
  assert.equal((await request(f.base, ROOT + '/', {headers: {origin: 'https://synthetic-external.invalid'}})).status, 403);
  assert.deepEqual(f.observed.validations, []); assert.deepEqual(f.observed.persisted, []); assert.deepEqual(f.observed.controls, []);
  const invalidFormat = await f.form('key', {key: 'invalid'}); assert.equal(invalidFormat.status, 400); assert.deepEqual(f.observed.validations, []);
});

test('saved custom provider becomes routable with only its own key while GPT requests and bytes remain unchanged', async t => {
  const f = await fixture(t);
  assert.equal((await f.form('provider-save', f.providerFields())).status, 303);
  const status = await f.status();
  assert.equal(status.providers.length, 1); assert.equal(status.providers[0].models[0].slug, CUSTOM_SLUG);
  assert.equal(status.models.some(model => model.id === CUSTOM_SLUG), true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(CUSTOM_KEY));
  const custom = await f.inference(CUSTOM_SLUG, {}, {cookie: 'synthetic-chatgpt-cookie', 'chatgpt-account-id': 'synthetic-account'});
  assert.equal(custom.status, 200); assert.equal(custom.json.model, CUSTOM_SLUG);
  const sentCustom = f.observed.upstream.at(-1);
  assert.equal(sentCustom.path, '/custom/v1/responses'); assert.equal(sentCustom.body.model, CUSTOM_ID);
  assert.equal(sentCustom.headers.authorization, 'Bearer ' + CUSTOM_KEY); assert.equal(sentCustom.headers.cookie, undefined); assert.equal(sentCustom.headers['chatgpt-account-id'], undefined);
  const raw = ' { "model": "gpt-synthetic", "input": "Original GPT input", "stream": true } ';
  const gpt = await request(f.base, PREFIX + '/responses', {method: 'POST', headers: {authorization: 'Bearer synthetic-incoming-gpt-token', cookie: 'synthetic-gpt-cookie', 'content-type': 'application/json', 'x-gateway-private': 'must-not-forward'}, body: raw});
  assert.equal(gpt.status, 200); assert.equal(gpt.body, f.gptSse); assert.equal(gpt.headers['x-synthetic-upstream'], 'preserved');
  const sentGpt = f.observed.upstream.at(-1);
  assert.equal(sentGpt.raw, raw); assert.equal(sentGpt.headers.authorization, 'Bearer synthetic-incoming-gpt-token'); assert.equal(sentGpt.headers.cookie, 'synthetic-gpt-cookie'); assert.equal(sentGpt.headers['x-gateway-private'], undefined);
  const catalog = await request(f.base, PREFIX + '/models?client_version=synthetic', {headers: {authorization: 'Bearer synthetic-incoming-gpt-token'}});
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.json.models.find(model => model.slug === GPT_MODEL.slug), GPT_MODEL);
  assert.equal(catalog.json.models.some(model => model.slug === CUSTOM_SLUG), true);
});

test('a rejected custom key update preserves the existing provider, capabilities and credential', async t => {
  const f = await fixture(t);
  assert.equal((await f.form('provider-save', f.providerFields())).status, 303);
  const before = (await f.status()).providers;
  const rejected = await f.form('provider-save', f.providerFields({apiKey: 'synthetic-rejected-custom-key', maxOutputTokens: '700'}));
  assert.equal(rejected.status, 400); assert.deepEqual((await f.status()).providers, before);
  assert.equal(f.observed.credentialWrites.length, 1);
  await f.inference(CUSTOM_SLUG); assert.equal(f.observed.upstream.at(-1).headers.authorization, 'Bearer ' + CUSTOM_KEY);
  assert.equal(f.observed.upstream.at(-1).body.max_output_tokens, 500);
  assert.doesNotMatch(rejected.body, /synthetic-rejected-custom-key|synthetic-custom-provider-key/);
});

test('diagnose uses injected credentials and reports provider checks without exposing keys', async t => {
  const f = await fixture(t); await f.form('provider-save', f.providerFields());
  const result = await f.form('diagnose'); assert.equal(result.status, 303);
  const status = await f.status();
  assert.ok(status.diagnostics.lastCheckedAt); assert.equal(status.validation.status, 'verified');
  assert.equal(status.diagnostics.checks.some(check => check.name === 'GPT 登录' && check.ok), true);
  assert.equal(status.diagnostics.checks.some(check => check.name === 'DeepSeek 密钥' && check.ok), true);
  assert.equal(status.diagnostics.checks.some(check => check.name === 'Synthetic provider' && check.ok), true);
  assert.deepEqual(f.observed.validations, [OLD_KEY]); assert.equal(f.observed.providerValidations.length, 2);
  assert.doesNotMatch(JSON.stringify(status), /sk-synthetic_|synthetic-custom-provider-key|synthetic-gpt-account/);
});

test('restart remains running until the control operation settles and rejects concurrent controls', async t => {
  const f = await fixture(t);
  const started = await f.form('restart'); assert.equal(started.status, 303);
  const running = (await f.status()).diagnostics.control;
  assert.equal(running.action, 'restart'); assert.equal(running.state, 'running'); assert.equal(running.finishedAt, null);
  assert.deepEqual(f.observed.controls, ['restart']);
  const concurrent = await f.form('restart'); assert.equal(concurrent.status, 409); assert.deepEqual(f.observed.controls, ['restart']);
  f.controlWaiters[0].resolve(); await tick();
  const done = (await f.status()).diagnostics.control; assert.equal(done.state, 'succeeded'); assert.ok(done.finishedAt);
});

test('restore requires explicit confirmation and reports asynchronous control failure truthfully', async t => {
  const f = await fixture(t);
  const missing = await f.form('restore'); assert.equal(missing.status, 400); assert.match(missing.body, /确认恢复/);
  assert.deepEqual(f.observed.controls, []); assert.equal((await f.status()).diagnostics.control, null);
  const wrong = await f.form('restore', {confirm: 'yes'}); assert.equal(wrong.status, 400); assert.deepEqual(f.observed.controls, []);
  const started = await f.form('restore', {confirm: 'restore'}); assert.equal(started.status, 303);
  assert.equal((await f.status()).diagnostics.control.state, 'running'); assert.deepEqual(f.observed.controls, ['restore']);
  f.controlWaiters[0].reject(new Error('Synthetic control failure')); await tick();
  assert.equal((await f.status()).diagnostics.control.state, 'failed');
});
