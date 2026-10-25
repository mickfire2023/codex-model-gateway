'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {WebSocket, WebSocketServer} = require('ws');
const {attachSocketRouter, createHistoryStore} = require('../../gateway/socket-router.cjs');

const message = text => ({type: 'message', role: 'user', content: [{type: 'input_text', text}]});
const output = text => ({type: 'message', role: 'assistant', content: [{type: 'output_text', text}]});
const create = (model, input, rest = {}) => ({type: 'response.create', model, input: [message(input)], ...rest});
const textOf = item => (item.content || []).map(part => part.text || '').join('');
const texts = request => request.input.map(textOf);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function inbox(socket) {
  const messages = [], pending = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const entry = {value, raw: raw.toString()};
    const index = pending.findIndex(waiter => waiter.predicate(value));
    if (index >= 0) { const waiter = pending.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(entry); }
    else messages.push(entry);
  });
  function take(predicate = () => true) {
    const index = messages.findIndex(entry => predicate(entry.value));
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {predicate, resolve, reject};
      waiter.timer = setTimeout(() => { const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1); reject(new Error('Timed out waiting for WebSocket event; queued: ' + messages.map(entry => entry.value.type).join(','))); }, 2500);
      pending.push(waiter);
    });
  }
  return {take, messages, done: lane => take(event => event.type === 'response.completed' && (lane == null || event.stream_id === lane)), error: lane => take(event => event.type === 'error' && (lane == null || event.stream_id === lane))};
}

async function fixture(t, options = {}) {
  let counter = 0;
  const observed = {gpt: [], providers: [], aborted: [], errors: [], notes: []};
  const gptServer = http.createServer();
  const upstreamWss = new WebSocketServer({server: gptServer});
  const providerHeld = new Map();
  upstreamWss.on('connection', (ws, req) => {
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString());
      observed.gpt.push({request, raw: raw.toString(), headers: req.headers, ws});
      if (request.type === 'response.cancel') {
        ws.send(JSON.stringify({type: 'response.cancelled', response: {id: 'cancelled'}, ...(request.stream_id != null ? {stream_id: request.stream_id} : {})}));
        return;
      }
      if (options.onGpt?.({ws, request, raw: raw.toString(), observed})) return;
      const id = 'gpt-' + (++counter);
      const response = {id, output: [output('GPT answer ' + counter)]};
      const event = {type: 'response.completed', response};
      ws.send(options.rawGptEvent ? options.rawGptEvent(response) : JSON.stringify(event));
    });
  });
  gptServer.listen(0, '127.0.0.1'); await once(gptServer, 'listening');
  const gateway = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const routeFor = model => ({provider: String(model).startsWith('gpt') ? 'openai' : String(model).startsWith('custom') ? 'custom:mock' : 'deepseek', model});
  const router = attachSocketRouter({
    server: gateway, WebSocket, WebSocketServer, prefix: '/gateway', allowed: () => true,
    routeFor, gptBase: `http://127.0.0.1:${gptServer.address().port}`,
    headersFor: (route, incoming) => route.provider === 'openai'
      ? {authorization: incoming.authorization, 'x-codex-session-id': incoming['x-codex-session-id'] || 'none'}
      : {authorization: `Bearer synthetic-${route.provider}-credential`, 'content-type': 'application/json'},
    runProvider: async ({route, request, emit, signal, headers,historyScope}) => {
      observed.providers.push({route, request: structuredClone(request), headers: {...headers}, signal,historyScope});
      const id = 'provider-' + (++counter);
      emit({type: 'response.created', response: {id}});
      if (options.onProvider) return options.onProvider({route, request, emit, signal, headers, id,historyScope});
      if (request.model.endsWith('hold')) {
        return new Promise((resolve, reject) => {
          providerHeld.set(String(request.stream_id || ''), {resolve, reject, emit, id});
          signal.addEventListener('abort', () => {
            observed.aborted.push(String(request.stream_id || ''));
            emit({type: 'response.completed', response: {id: 'must-not-leak', output: []}});
            reject(Object.assign(new Error('cancelled'), {name: 'AbortError'}));
          }, {once: true});
        });
      }
      if (request.model.endsWith('error')) throw new Error('bad upstream ' + headers.authorization + ' synthetic-client-auth');
      const response = {id, output: [output('Provider answer ' + counter)]};
      emit({type: 'response.completed', response});
      return response;
    },
    expandInput: (request, route) => { if (options.expandInput) return options.expandInput(request, route); return request; },
    note: (...args) => observed.notes.push(args), recordError: error => observed.errors.push(error),
    ...options.routerOptions
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const clients = [];
  async function client({authorization = 'Bearer synthetic-client-auth', session = 'synthetic-session', query = ''} = {}) {
    const headers = {authorization}; if (session != null) headers['x-codex-session-id'] = session;
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/gateway/responses${query}`, {headers});
    const box = inbox(ws); clients.push(ws); await once(ws, 'open');
    return {ws, box, send: request => ws.send(typeof request === 'string' ? request : JSON.stringify(request))};
  }
  t.after(async () => {
    clients.forEach(ws => ws.terminate()); router.close();
    for (const ws of upstreamWss.clients) ws.terminate();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstreamWss.close(() => gptServer.close(resolve)))]);
  });
  return {client, observed, router, providerHeld};
}

test('GPT -> DeepSeek -> GPT preserves the complete readable transcript and isolates credentials', async t => {
  const f = await fixture(t);
  const c = await f.client();
  c.send(create('gpt-first', 'first'));
  const first = (await c.box.done()).value.response;
  c.send(create('deepseek-chat', 'second', {previous_response_id: first.id}));
  const second = (await c.box.done()).value.response;
  assert.deepEqual(texts(f.observed.providers[0].request), ['first', 'GPT answer 1', 'second']);
  assert.equal(f.observed.providers[0].request.previous_response_id, undefined);
  assert.equal(f.observed.providers[0].headers.authorization, 'Bearer synthetic-deepseek-credential');
  assert.equal(f.observed.providers[0].headers['x-codex-session-id'], undefined);
  c.send(create('gpt-return', 'third', {previous_response_id: second.id}));
  await c.box.done();
  const returned = f.observed.gpt[1];
  assert.deepEqual(texts(returned.request), ['first', 'GPT answer 1', 'second', 'Provider answer 2', 'third']);
  assert.equal(returned.request.previous_response_id, undefined);
  assert.equal(returned.headers.authorization, 'Bearer synthetic-client-auth');
  assert.equal(f.router.history.size, 3);
});

test('normal GPT request and response bytes remain unchanged including opaque OpenAI history', async t => {
  let upstreamRaw;
  const f = await fixture(t, {rawGptEvent: response => { upstreamRaw = ' { "type" : "response.completed", "response" : ' + JSON.stringify(response) + ' } '; return upstreamRaw; }});
  const c = await f.client();
  const requestRaw = ' { "type": "response.create", "model": "gpt-original", "input": [{"type":"compaction","encrypted_content":"opaque-openai-context"}] } ';
  c.send(requestRaw);
  assert.equal((await c.box.done()).raw, upstreamRaw);
  assert.equal(f.observed.gpt[0].raw, requestRaw);
});

test('a closed GPT upstream reconnects on the next request with cached history and leaves the client open', async t => {
  const f = await fixture(t);
  const c = await f.client();
  c.send(create('gpt-first', 'before disconnect'));
  const first = (await c.box.done()).value.response;
  const upstream = f.observed.gpt[0].ws;
  upstream.close(1000); await once(upstream, 'close'); await delay(15);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.send(create('gpt-after', 'after disconnect', {previous_response_id: first.id}));
  await c.box.done();
  assert.deepEqual(texts(f.observed.gpt[1].request), ['before disconnect', 'GPT answer 1', 'after disconnect']);
  assert.equal(f.observed.gpt[1].request.previous_response_id, undefined);
});

test('multiple native GPT delta turns remain byte-preserved while history accumulates for migration', async t => {
  const f = await fixture(t); const c = await f.client();
  c.send(create('gpt-one', 'one')); const first = (await c.box.done()).value.response;
  const secondRequest = create('gpt-two', 'two', {previous_response_id: first.id});
  const secondRaw = '  ' + JSON.stringify(secondRequest) + '  ';
  c.send(secondRaw); const second = (await c.box.done()).value.response;
  assert.equal(f.observed.gpt[1].raw, secondRaw);
  c.send(create('deepseek-chat', 'three', {previous_response_id: second.id})); await c.box.done();
  assert.deepEqual(texts(f.observed.providers[0].request), ['one', 'GPT answer 1', 'two', 'GPT answer 2', 'three']);
});

test('a started GPT response is never automatically retried after an upstream close', async t => {
  const f = await fixture(t, {onGpt({ws, request}) {
    if (request.model !== 'gpt-side-effect') return false;
    ws.send(JSON.stringify({type: 'response.output_item.added', item: {type: 'function_call', name: 'apply_patch', call_id: 'side-effect'}}));
    ws.close(1011, 'mock interrupted'); return true;
  }});
  const c = await f.client(); c.send(create('gpt-side-effect', 'apply one edit'));
  const error = (await c.box.error()).value;
  assert.equal(error.error.code, 'openai_websocket_closed');
  await delay(30);
  assert.equal(f.observed.gpt.length, 1);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.send(create('gpt-next', 'new request')); await c.box.done();
  assert.equal(f.observed.gpt.length, 2);
});

test('history survives reconnect only for the same authorization, session and stream lane', async t => {
  const f = await fixture(t);
  const original = await f.client();
  original.send(create('gpt-first', 'private conversation', {stream_id: 'lane-one'}));
  const first = (await original.box.done('lane-one')).value.response;
  original.ws.close(); await once(original.ws, 'close');
  const restored = await f.client();
  restored.send(create('deepseek-chat', 'restore', {stream_id: 'lane-one', previous_response_id: first.id}));
  await restored.box.done('lane-one');
  assert.deepEqual(texts(f.observed.providers[0].request), ['private conversation', 'GPT answer 1', 'restore']);
  for (const [settings, lane] of [[{authorization: 'Bearer other-auth'}, 'lane-one'], [{session: 'other-session'}, 'lane-one'], [{}, 'lane-two']]) {
    const isolated = await f.client(settings);
    isolated.send(create('deepseek-chat', 'must not cross', {stream_id: lane, previous_response_id: first.id}));
    assert.equal((await isolated.box.error(lane)).value.error.code, 'history_not_migratable');
  }
  assert.equal(f.observed.providers.length, 1);
});

test('connections with no explicit session never share history even with the same authorization', async t => {
  const f = await fixture(t);
  const a = await f.client({session: null});
  a.send(create('deepseek-chat', 'private to a'));
  const first = (await a.box.done()).value.response;
  const b = await f.client({session: null});
  b.send(create('deepseek-chat', 'not shared', {previous_response_id: first.id}));
  assert.equal((await b.box.error()).value.error.code, 'history_not_migratable');
  assert.equal(f.observed.providers.length, 1);
});

test('busy errors retain the original lane lock, parallel lanes work and cancellation affects one lane', async t => {
  const f = await fixture(t);
  const c = await f.client();
  c.send(create('deepseek-hold', 'long response', {stream_id: 'A'}));
  await c.box.take(event => event.type === 'response.created' && event.stream_id === 'A');
  c.send(create('gpt-switch', 'switch while busy', {stream_id: 'A'}));
  assert.equal((await c.box.error('A')).value.error.code, 'response_in_progress');
  c.send(create('deepseek-chat', 'still busy', {stream_id: 'A'}));
  assert.equal((await c.box.error('A')).value.error.code, 'response_in_progress');
  c.send(create('custom-chat', 'parallel', {stream_id: 'B'})); await c.box.done('B');
  c.send({type: 'response.cancel', stream_id: 'B'}); await delay(15);
  assert.deepEqual(f.observed.aborted, []);
  c.send({type: 'response.cancel', stream_id: 'A'}); await delay(15);
  assert.deepEqual(f.observed.aborted, ['A']);
  assert.equal(c.box.messages.some(entry => entry.value.response?.id === 'must-not-leak'), false);
  c.send(create('gpt-switch', 'now free', {stream_id: 'A'})); await c.box.done('A');
  assert.equal(f.observed.gpt.length, 1);
});

test('GPT cancel forwards only on the selected lane and a busy provider switch cannot unlock it', async t => {
  const f = await fixture(t, {onGpt({ws, request}) {
    if (request.model !== 'gpt-hold') return false;
    ws.send(JSON.stringify({type: 'response.created', response: {id: 'gpt-held'}})); return true;
  }});
  const c = await f.client();
  c.send(create('gpt-hold', 'hold', {stream_id: 'G'}));
  await c.box.take(event => event.type === 'response.created' && event.stream_id === 'G');
  c.send(create('deepseek-chat', 'busy', {stream_id: 'G'}));
  assert.equal((await c.box.error('G')).value.error.code, 'response_in_progress');
  c.send({type: 'response.cancel', stream_id: 'other'}); await delay(15);
  assert.equal(f.observed.gpt.length, 1);
  c.send({type: 'response.cancel', stream_id: 'G'});
  await c.box.take(event => event.type === 'response.cancelled' && event.stream_id === 'G');
  assert.equal(f.observed.gpt[1].request.stream_id, 'G');
  c.send(create('deepseek-chat', 'free now', {stream_id: 'G'})); await c.box.done('G');
});

test('encrypted compaction and program histories reject provider migration with Chinese recovery advice', async t => {
  for (const opaque of [{type: 'compaction', encrypted_content: 'encrypted-openai'}, {type: 'program_call', id: 'program-only'}]) {
    const f = await fixture(t); const c = await f.client();
    c.send({type: 'response.create', model: 'gpt-opaque', input: [opaque]});
    const first = (await c.box.done()).value.response;
    c.send(create('deepseek-chat', 'switch', {previous_response_id: first.id}));
    const error = (await c.box.error()).value.error;
    assert.equal(error.code, 'history_not_migratable');
    assert.match(error.message, /新建聊天.*带摘要继续/);
    assert.equal(f.observed.providers.length, 0);
    // A failed switch must preserve the original GPT route and its usable socket.
    c.send(create('gpt-continue', 'stay on GPT', {previous_response_id: first.id}));
    await c.box.done();
    assert.equal(f.observed.gpt[0].ws, f.observed.gpt[1].ws);
    assert.equal(f.observed.gpt[1].request.previous_response_id, first.id);
  }
});

test('local compaction output is cached as a readable summary and can continue on GPT', async t => {
  const f = await fixture(t, {
    expandInput(request) {
      if (!Array.isArray(request.input)) return request;
      return {...request, input: request.input.map(item => item.type === 'compaction' && item.encrypted_content === 'local-test-token' ? message('Readable local summary') : item)};
    },
    onProvider({id, emit}) {
      const response = {id, output: [{type: 'compaction', encrypted_content: 'local-test-token'}]};
      emit({type: 'response.completed', response}); return response;
    }
  });
  const c = await f.client();
  c.send(create('deepseek-chat', 'large old history', {compaction_trigger: true}));
  const first = (await c.box.done()).value.response;
  // The client receives its original compaction token; only cached history is expanded.
  assert.equal(first.output[0].encrypted_content, 'local-test-token');
  c.send(create('gpt-follow', 'continue', {previous_response_id: first.id}));
  await c.box.done();
  assert.deepEqual(texts(f.observed.gpt[0].request), ['Readable local summary', 'continue']);
});

test('tool calls, namespaces, arguments and outputs survive a provider switch without losing structure', async t => {
  const toolOutput = [
    {type: 'reasoning', content: [{type: 'reasoning_text', text: 'readable reasoning'}]},
    {type: 'function_call', name: 'read', namespace: 'files', call_id: 'fn-call', arguments: '{"path":"synthetic.txt"}'},
    {type: 'custom_tool_call', name: 'apply_patch', namespace: 'workspace', call_id: 'custom-call', input: 'synthetic patch'}
  ];
  const f = await fixture(t, {onGpt({ws}) {
    ws.send(JSON.stringify({type: 'response.completed', response: {id: 'tool-response', output: toolOutput}})); return true;
  }});
  const c = await f.client();
  c.send(create('gpt-tools', 'use tools')); await c.box.done();
  const results = [{type: 'function_call_output', call_id: 'fn-call', output: 'file contents'}, {type: 'custom_tool_call_output', call_id: 'custom-call', output: 'applied'}];
  c.send({type: 'response.create', model: 'deepseek-chat', previous_response_id: 'tool-response', input: results});
  await c.box.done();
  assert.deepEqual(f.observed.providers[0].request.input, [message('use tools'), ...toolOutput, ...results]);
});

test('GPT private encrypted reasoning stays intact for GPT and visible messages migrate to DeepSeek', async t => {
  const encrypted = {type: 'reasoning', id: 'private-reasoning', encrypted_content: 'synthetic-openai-private-reasoning', summary: []};
  const visible = output('Visible answer');
  const f = await fixture(t, {onGpt({ws}) {
    ws.send(JSON.stringify({type: 'response.completed', response: {id: 'encrypted-reasoning-response', output: [encrypted, visible]}})); return true;
  }});
  const c = await f.client();
  c.send(create('gpt-private', 'visible user question'));
  const first = (await c.box.done()).value.response;
  assert.deepEqual(first.output[0], encrypted);
  c.send(create('deepseek-chat', 'continue', {previous_response_id: first.id}));
  await c.box.done();
  assert.deepEqual(f.observed.providers[0].request.input, [message('visible user question'), visible, message('continue')]);
  assert.doesNotMatch(JSON.stringify(f.observed.providers[0].request), /synthetic-openai-private-reasoning/);
});

test('foreign Responses output becomes valid GPT input without response-only fields or private reasoning', async t => {
  const foreignOutput = [
    {type: 'reasoning', id: 'foreign-reasoning', status: 'completed', content: [{type: 'reasoning_text', text: 'Private foreign thinking'}]},
    {type: 'message', id: 'foreign-message', status: 'completed', role: 'assistant', content: [{type: 'output_text', text: 'Remember cedar89', annotations: [], logprobs: []}, {type: 'refusal', refusal: 'Visible refusal'}]},
    {type: 'function_call', id: 'foreign-function', status: 'completed', call_id: 'function-call', name: 'read', namespace: 'files', arguments: '{"path":"cedar89.txt"}'},
    {type: 'custom_tool_call', id: 'foreign-custom', status: 'completed', call_id: 'custom-call', name: 'apply_patch', namespace: 'workspace', input: '*** Begin Patch\n*** End Patch'},
    {type: 'function_call_output', id: 'foreign-result', status: 'completed', call_id: 'function-call', output: 'cedar89 file content'},
    {type: 'custom_tool_call_output', id: 'foreign-custom-result', status: 'completed', call_id: 'custom-call', output: 'Patch applied'}
  ];
  const f = await fixture(t, {onProvider({id, emit}) { const response = {id, status: 'completed', output: foreignOutput}; emit({type: 'response.completed', response}); return response; }});
  const c = await f.client();
  c.send(create('deepseek-chat', 'Remember cedar89')); const ds = (await c.box.done()).value.response;
  c.send(create('gpt-return', 'Recall the word', {previous_response_id: ds.id})); await c.box.done();
  const input = f.observed.gpt[0].request.input;
  assert.equal(input.some(item => item.type === 'reasoning'), false);
  assert.equal(input.every(item => !Object.hasOwn(item, 'id') && !Object.hasOwn(item, 'status')), true);
  assert.deepEqual(input[1], {type: 'message', role: 'assistant', content: [{type: 'input_text', text: 'Remember cedar89'}, {type: 'input_text', text: 'Visible refusal'}]});
  assert.deepEqual(input[2], {type: 'function_call', call_id: 'function-call', name: 'read', namespace: 'files', arguments: '{"path":"cedar89.txt"}'});
  assert.deepEqual(input[3], {type: 'custom_tool_call', call_id: 'custom-call', name: 'apply_patch', namespace: 'workspace', input: '*** Begin Patch\n*** End Patch'});
  assert.deepEqual(input[4], {type: 'function_call_output', call_id: 'function-call', output: 'cedar89 file content'});
  assert.deepEqual(input[5], {type: 'custom_tool_call_output', call_id: 'custom-call', output: 'Patch applied'});
  assert.equal(f.observed.gpt[0].request.previous_response_id, undefined);
});

test('same-GPT reconnect retains original opaque reasoning and native output objects exactly', async t => {
  const nativeOutput = [
    {type: 'reasoning', id: 'native-reasoning', status: 'completed', encrypted_content: 'opaque-native-reasoning', summary: []},
    {type: 'message', id: 'native-message', status: 'completed', role: 'assistant', content: [{type: 'output_text', text: 'Native cedar89', annotations: []}]}
  ];
  let count = 0;
  const f = await fixture(t, {onGpt({ws}) { if (count++) return false; ws.send(JSON.stringify({type: 'response.completed', response: {id: 'native-response', output: nativeOutput}})); return true; }});
  const c = await f.client(); c.send(create('gpt-first', 'Native start')); await c.box.done();
  const upstream = f.observed.gpt[0].ws; upstream.close(1000); await once(upstream, 'close'); await delay(15);
  c.send(create('gpt-next', 'Native continue', {previous_response_id: 'native-response'})); await c.box.done();
  assert.deepEqual(f.observed.gpt[1].request.input, [message('Native start'), ...nativeOutput, message('Native continue')]);
});

test('shared history helper detects a foreign entry and normalizes a direct HTTP-style GPT return', () => {
  const history = createHistoryStore({historySecret: 'synthetic-secret'});
  const common = {headers: {authorization: 'Bearer synthetic-auth', 'x-codex-session-id': 'same-session'}};
  const request = create('deepseek-chat', 'Remember cedar89');
  history.remember(request, {id: 'foreign-history', output: [{type: 'message', id: 'foreign-id', status: 'completed', role: 'assistant', content: [{type: 'output_text', text: 'cedar89', annotations: []}]}]}, {...common, provider: 'deepseek'});
  const resolved = history.resolve(create('gpt-return', 'Recall', {previous_response_id: 'foreign-history'}), {...common, provider: 'openai'});
  assert.equal(resolved.request.previous_response_id, undefined);
  assert.deepEqual(resolved.request.input[1], {type: 'message', role: 'assistant', content: [{type: 'input_text', text: 'cedar89'}]});
});

test('foreign message program markers are rejected before normalization can remove them', () => {
  for (const marker of [{program: {id: 'foreign-program'}}, {access_program: 'foreign-access-program'}, {program_id: 'foreign-program-id'}]) {
    const history = createHistoryStore({historySecret: 'synthetic-secret'});
    const common = {headers: {authorization: 'Bearer synthetic-auth', 'x-codex-session-id': 'same-session'}};
    const request = create('deepseek-chat', 'Original context');
    history.remember(request, {id: 'foreign-program-history', output: [{...output('Visible message'), ...marker}]}, {...common, provider: 'deepseek'});
    assert.throws(() => history.resolve(create('gpt-return', 'Recall', {previous_response_id: 'foreign-program-history'}), {...common, provider: 'openai'}), error => error.code === 'history_not_migratable' && /program.*新建聊天/.test(error.message));
  }
});

test('unknown first GPT previous ID is forwarded but later migration cannot silently lose history', async t => {
  const f = await fixture(t); const c = await f.client();
  const request = create('gpt-original', 'delta', {previous_response_id: 'opaque-upstream-only'});
  c.send(request); const first = (await c.box.done()).value.response;
  assert.deepEqual(f.observed.gpt[0].request, request);
  c.send(create('deepseek-chat', 'switch', {previous_response_id: first.id}));
  assert.equal((await c.box.error()).value.error.code, 'history_not_migratable');
  assert.equal(f.observed.providers.length, 0);
});

test('provider errors redact both incoming and destination credentials', async t => {
  const f = await fixture(t); const c = await f.client();
  c.send(create('deepseek-error', 'error'));
  const error = (await c.box.error()).value.error;
  assert.doesNotMatch(error.message, /synthetic-client-auth|synthetic-deepseek-credential/);
  assert.match(error.message, /redacted/);
  assert.doesNotMatch(JSON.stringify(f.observed.errors), /synthetic-client-auth|synthetic-deepseek-credential/);
});

test('history helper enforces TTL, entry count, byte bounds and authorization namespaces', () => {
  let now = 0;
  const history = createHistoryStore({historySecret: 'synthetic-secret', historyTtlMs: 20, historyMaxEntries: 2, historyMaxBytes: 100000, now: () => now});
  const context = {headers: {authorization: 'Bearer synthetic-private-auth', 'x-codex-session-id': 'session'}, provider: 'deepseek', forceReplay: true};
  const initial = create('deepseek-chat', 'first');
  const resolved = history.resolve(initial, context);
  history.remember(initial, {id: 'one', output: [output('answer')]}, {...context, resolved});
  const next = create('deepseek-chat', 'second', {previous_response_id: 'one'});
  assert.deepEqual(texts(history.resolve(next, context).request), ['first', 'answer', 'second']);
  assert.doesNotMatch(JSON.stringify(resolved), /synthetic-private-auth/);
  assert.throws(() => history.resolve(next, {...context, headers: {...context.headers, authorization: 'Bearer different'}}), /新建聊天/);
  history.remember(initial, {id: 'two', output: []}, context);
  history.remember(initial, {id: 'three', output: []}, context);
  assert.equal(history.size, 2);
  assert.throws(() => history.resolve(next, context), /新建聊天/);
  now = 21; assert.equal(history.size, 0); assert.equal(history.bytes, 0);
  const tiny = createHistoryStore({historyMaxBytes: 50});
  assert.equal(tiny.remember(initial, {id: 'large', output: [output('x'.repeat(1000))]}, context), false);
  assert.equal(tiny.size, 0);
});

test('WebSocket opt-in carries only same-model known Google reasoning through tool continuation',async t=>{
  const signed={type:'reasoning',id:'rs_ws_fixture',encrypted_content:'cpa-gemini-responses-carrier-v1:next:function:c3ludGhldGlj',summary:[]};
  const f=await fixture(t,{
    routerOptions:{routeFor:model=>({provider:'custom:subscription',model,preserveOpaqueReasoning:true,historyScope:(model.endsWith('-a')?'a':'b').repeat(64)})},
    onProvider:async({id,emit})=>{const response={id,output:[signed,output('fixture answer')]};await emit({type:'response.completed',response});return response;}
  });
  const c=await f.client();c.send(create('custom/google-a','initial'));const first=(await c.box.done()).value.response;
  c.send(create('custom/google-a','same model',{previous_response_id:first.id}));const second=(await c.box.done()).value.response;
  assert.equal(f.observed.providers[1].historyScope,'a'.repeat(64));
  assert.ok(JSON.stringify(f.observed.providers[1].request).includes(signed.encrypted_content));
  c.send(create('custom/google-b','changed model',{previous_response_id:second.id}));await c.box.done();
  assert.equal(f.observed.providers[2].historyScope,'b'.repeat(64));
  assert.ok(!JSON.stringify(f.observed.providers[2].request).includes(signed.encrypted_content));
});
