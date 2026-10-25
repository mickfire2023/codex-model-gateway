'use strict';

const {createHmac, randomBytes, randomUUID} = require('node:crypto');
const {isGeminiReasoningCarrier} = require('./deepseek-adapter.cjs');

const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled']);
const MIGRATABLE = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'compaction_trigger']);
const ID_KEYS = ['thread_id', 'thread-id', 'session_id', 'session-id', 'conversation_id', 'conversation-id', 'x-codex-thread-id', 'x-codex-session-id', 'x-session-id'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => structuredClone(value);
const providerOf = route => String(typeof route === 'string' ? route : route?.provider || route?.kind || 'openai');
const isGpt = route => ['openai', 'gpt', 'chatgpt'].includes(providerOf(route));
const laneOf = request => request?.stream_id == null ? '' : String(request.stream_id);
const fail = (message, code = 'gateway_error', status = 400) => Object.assign(new Error(message), {code, status});
const migrationFailure = reason => fail(`${reason}。请新建聊天，或带摘要继续。`, 'history_not_migratable', 409);
function inputOf(request) {
  if (typeof request.input === 'string') return [{role: 'user', content: request.input}];
  if (request.input == null) return [];
  if (!Array.isArray(request.input)) throw fail('input 必须是文本或消息数组', 'invalid_input');
  return request.input;
}
function assertMigratable(request, input) {
  if (request.program || request.access_program || request.program_id) throw migrationFailure('此聊天包含无法迁移的 program 上下文');
  for (const item of input) {
    if (!item || typeof item !== 'object') throw migrationFailure('此聊天包含无法迁移的历史项目');
    if (item.type === 'compaction') throw migrationFailure('此聊天包含无法读取的 OpenAI 加密压缩上下文');
    if (item.type && !MIGRATABLE.has(item.type)) throw migrationFailure(`此聊天包含无法迁移的 ${String(item.type).slice(0, 80)} 历史`);
    if (item.program || item.program_id || item.access_program) throw migrationFailure('此聊天包含无法迁移的 program 历史');
  }
}
function portableInput(input, destination, trustedOpaque = () => false) {
  if (isGpt(destination)) {
    const fields = {
      function_call: ['type', 'call_id', 'name', 'namespace', 'arguments'],
      function_call_output: ['type', 'call_id', 'output'],
      custom_tool_call: ['type', 'call_id', 'name', 'namespace', 'input'],
      custom_tool_call_output: ['type', 'call_id', 'output']
    };
    return input.flatMap(item => {
      // Foreign private reasoning is not portable user-visible conversation.
      if (item?.type === 'reasoning') return [];
      if (item?.role || item?.type === 'message') {
        const content = typeof item.content === 'string' ? item.content : (item.content || []).map(part => {
          if (typeof part === 'string') return {type: 'input_text', text: part};
          if (['input_text', 'output_text', 'text'].includes(part?.type)) return {type: 'input_text', text: part.text || ''};
          if (part?.type === 'refusal') return {type: 'input_text', text: part.refusal || ''};
          const clean = {...part}; delete clean.id; delete clean.status;
          return clean;
        });
        return [{type: 'message', role: item.role, content}];
      }
      if (fields[item?.type]) return [Object.fromEntries(fields[item.type].filter(key => own(item, key)).map(key => [key, item[key]]))];
      return [item];
    });
  }
  return input.flatMap(item => {
    if (item?.type !== 'reasoning' || !item.encrypted_content) return [item];
    if (isGeminiReasoningCarrier(item) && trustedOpaque(item)) return [item];
    // Private encrypted reasoning is not user-visible conversational context.
    // Never decrypt or invent it, and never send an OpenAI blob to another provider.
    if (!item.content?.length && !item.summary?.length) return [];
    const readable = {...item}; delete readable.encrypted_content;
    return [readable];
  });
}

/** Bounded, process-local history. No credentials or transcripts are written to disk. */
function createHistoryStore(options = {}) {
  const secret = options.historySecret || randomBytes(32);
  const ttl = Math.max(1, options.historyTtlMs ?? 30 * 60 * 1000);
  const maxEntries = Math.max(1, options.historyMaxEntries ?? 128);
  const maxBytes = Math.max(1, options.historyMaxBytes ?? 32 * 1024 * 1024);
  const now = options.now || Date.now;
  const entries = new Map();
  let bytes = 0;
  function remove(key) { const entry = entries.get(key); if (entry) bytes -= entry.bytes; entries.delete(key); }
  function prune() {
    const time = now();
    for (const [key, entry] of entries) if (entry.expires <= time) remove(key);
    while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
  }
  function namespace(headers = {}, query, context = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const identity = [];
    for (const key of ID_KEYS) {
      const header = normalized[key];
      if (header != null && String(header)) identity.push(['header:' + key, String(header)]);
      const parameter = query?.get ? query.get(key) : query?.[key];
      if (parameter != null && String(parameter)) identity.push(['query:' + key, String(parameter)]);
    }
    const request = context.request || {};
    for (const key of ['thread_id', 'session_id', 'conversation_id']) {
      const value = request[key] ?? request.metadata?.[key] ?? request.client_metadata?.[key];
      if (value != null && String(value)) identity.push(['body:' + key, String(value)]);
    }
    if (typeof request.conversation === 'string') identity.push(['body:conversation', request.conversation]);
    else if (request.conversation?.id) identity.push(['body:conversation', String(request.conversation.id)]);
    if (!identity.length) identity.push(['connection', context.scope || randomUUID()]);
    return createHmac('sha256', secret).update(JSON.stringify([
      String(normalized.authorization || ''), String(normalized['chatgpt-account-id'] || ''), identity, String(context.lane ?? laneOf(request))
    ])).digest('hex');
  }
  function contextNamespace(request, context) {
    return context.namespace || namespace(context.headers, context.query, {...context, request});
  }
  function get(id, ns) {
    prune();
    const key = ns + ':' + id;
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key); entries.set(key, entry);
    return entry;
  }
  function resolve(request, context = {}) {
    prune();
    const ns = contextNamespace(request, context);
    const input = clone(inputOf(request));
    const previous = request.previous_response_id ? get(request.previous_response_id, ns) : undefined;
    const foreign = previous && context.provider && providerOf(previous.provider) !== providerOf(context.provider);
    const opaqueReasoningScope = context.preserveOpaqueReasoning === true && /^custom:/.test(providerOf(context.provider)) && /^[a-f0-9]{64}$/.test(context.historyScope || '') ? context.historyScope : undefined;
    // An opaque carrier is trusted only if this exact account/session/lane and
    // upstream-model/credential scope previously received it from the provider.
    // This also covers clients replaying full input without previous_response_id.
    const knownCarriers = new Set();
    if (opaqueReasoningScope && !foreign) for (const [key, entry] of entries) {
      if (!key.startsWith(ns + ':') || entry.provider !== context.provider || entry.opaqueReasoningScope !== opaqueReasoningScope) continue;
      for (const item of entry.input) if (isGeminiReasoningCarrier(item)) knownCarriers.add(item.encrypted_content);
    }
    const replay = Boolean(context.forceReplay || foreign || (context.provider && !isGpt(context.provider)));
    let complete = true;
    if (request.previous_response_id && !previous) {
      complete = false;
      if (replay) throw migrationFailure('之前的完整历史已过期、不可用，或不属于当前聊天');
    }
    if (previous && !previous.complete && replay) throw migrationFailure('之前的 GPT 历史包含无法重建的上游上下文');
    let fullInput = previous ? [...clone(previous.input), ...input] : input;
    if (previous) complete = previous.complete;
    if (replay && (context.requireReadable || foreign || (context.provider && !isGpt(context.provider)))) {
      // Validate the raw transcript before rebuilding input objects: otherwise a
      // foreign message's program marker could disappear during normalization.
      assertMigratable(request, fullInput);
      fullInput = portableInput(fullInput, context.provider, item=>knownCarriers.has(item.encrypted_content));
      assertMigratable(request, fullInput);
    }
    // A client may replay a full transcript on its first GPT connection. Remove
    // recognized foreign Google carriers without touching native GPT blobs.
    const foreignCarrier = isGpt(context.provider) && fullInput.some(isGeminiReasoningCarrier);
    if (foreignCarrier) fullInput = fullInput.filter(item=>!isGeminiReasoningCarrier(item));
    const prepared = replay || foreignCarrier ? {...clone(request), input: fullInput} : clone(request);
    if(previous?.warmup&&replay)for(const field of ['instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','max_output_tokens']){
      if(!own(prepared,field)&&own(previous.request,field))prepared[field]=clone(previous.request[field]);
    }
    if (replay) delete prepared.previous_response_id;
    return {request: prepared, input: fullInput, complete, namespace: ns, entry: previous, ...(opaqueReasoningScope ? {opaqueReasoningScope} : {})};
  }
  function remember(request, response, context = {}) {
    if (!response?.id) return false;
    const resolved = context.resolved || resolve(request, context);
    const input = [...clone(resolved.input), ...clone(response.output || [])];
    const storedRequest = {...clone(request), input};
    delete storedRequest.previous_response_id;
    const entry = {input, request: storedRequest, provider: context.provider || 'openai', complete: resolved.complete, expires: now() + ttl,...(request.generate===false?{warmup:true}:{}),
      ...(resolved.opaqueReasoningScope ? {opaqueReasoningScope:resolved.opaqueReasoningScope} : {})};
    entry.bytes = Buffer.byteLength(JSON.stringify(entry));
    const key = resolved.namespace + ':' + response.id;
    remove(key);
    if (entry.bytes > maxBytes) return false;
    entries.set(key, entry); bytes += entry.bytes; prune();
    return true;
  }
  return {namespace, resolve, remember, clear() { entries.clear(); bytes = 0; }, get size() { prune(); return entries.size; }, get bytes() { prune(); return bytes; }};
}

/**
 * headersFor(route, incomingHeaders) must return ONLY that provider's credentials.
 * runProvider({route, request, emit, signal, headers}) returns a Responses response.
 * Each stream_id has its own connection, response lock, cancellation and history.
 */
function attachSocketRouter(options) {
  const {server, WebSocket, WebSocketServer, allowed = () => true, routeFor, headersFor, gptBase, runProvider,
    expandInput = request => request, note = () => {}, recordError = () => {}} = options;
  const prefix = (options.prefix || '/v1').replace(/\/$/, '');
  const history = options.history || createHistoryStore(options);
  const wss = new WebSocketServer({noServer: true, maxPayload: options.maxPayload || 160 * 1024 * 1024, perMessageDeflate: false});
  let closed = false;
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    if (url.pathname !== `${prefix}/responses`) return;
    if (!allowed(req) || !req.headers.authorization) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
  }
  server.on('upgrade', upgrade);
  wss.on('connection', (client, req) => {
    const scope = randomUUID();
    const query = new URL(req.url, 'http://127.0.0.1').searchParams;
    const lanes = new Map();
    const secrets = new Set();
    let ended = false;
    function collectSecrets(headers) {
      for (const [key, value] of Object.entries(headers || {})) if (/authorization|api[-_]?key|cookie|token|secret/i.test(key) && value) {
        const text = String(value); secrets.add(text);
        if (/^Bearer\s+/i.test(text)) secrets.add(text.replace(/^Bearer\s+/i, ''));
      }
    }
    collectSecrets(req.headers);
    function send(value) { if (!ended && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); }
    function error(error, lane) {
      if (ended || error?.name === 'AbortError') return;
      let message = String(error?.message || '网关请求失败');
      for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
      const status=Number(error?.status);
      const payload = {type: 'error', status:Number.isInteger(status)&&status>=400&&status<600?status:502, error: {type: 'gateway_error', code: String(error?.code || 'gateway_error'), message}};
      if(Number.isSafeInteger(error?.retryAfterSeconds)&&error.retryAfterSeconds>0&&error.retryAfterSeconds<=604800)payload.headers={'retry-after':String(error.retryAfterSeconds)};
      if (lane?.id) payload.stream_id = lane.id;
      send(payload);
      try { recordError({code: payload.error.code, message, status:payload.status,...(error?.retryAfterSeconds?{retryAfterSeconds:error.retryAfterSeconds}:{})}, {transport: 'websocket', stream_id: lane?.id,provider:lane?.route?.provider,model:lane?.active?.request?.model}); } catch {}
    }
    function laneFor(request) {
      const id = laneOf(request);
      if (!lanes.has(id)) lanes.set(id, {id, busy: false, active: null, upstream: null, connected: false, generation: 0, everConnected: false});
      return lanes.get(id);
    }
    function historyContext(lane, request, extra = {}) {
      return {headers: req.headers, query, scope, lane: lane.id, provider: providerOf(lane.route), historyScope:lane.route?.historyScope,preserveOpaqueReasoning:lane.route?.preserveOpaqueReasoning, request, ...extra};
    }
    function dropUpstream(lane) {
      const upstream = lane.upstream;
      lane.upstream = null; lane.connected = false; lane.generation++;
      if (upstream && upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    }
    function finish(lane, active) {
      if (lane.active !== active) return;
      lane.active = null; lane.busy = false;
    }
    async function remember(lane, active, response) {
      if (!response?.id || active.cancelled) return;
      // Local encrypted compaction tokens must be readable again before they enter
      // history. Real GPT opaque items remain unchanged for GPT and fail migration.
      const expanded = await expandInput({...clone(active.request), input: clone(response.output || [])}, lane.route);
      if (active.cancelled || ended) return;
      const compacted = active.request.compaction_trigger || inputOf(active.request).some(item => item?.type === 'compaction_trigger');
      const resolved = compacted ? {...active.resolved, input: []} : active.resolved;
      history.remember(active.request, {...response, output: inputOf(expanded)}, historyContext(lane, active.request, {resolved}));
    }
    function connect(lane, forwardHeaders) {
      const endpoint = new URL(`${String(gptBase).replace(/\/$/, '')}/responses${query.size ? '?' + query : ''}`);
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : endpoint.protocol === 'http:' ? 'ws:' : endpoint.protocol;
      const protocols = req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()).filter(Boolean) || [];
      const upstream = new WebSocket(endpoint, protocols, {headers: forwardHeaders, perMessageDeflate: false,
        handshakeTimeout: options.handshakeTimeout || 30000, maxPayload: options.maxPayload || 160 * 1024 * 1024});
      const generation = ++lane.generation;
      lane.upstream = upstream;
      function current() { return !ended && lane.generation === generation && lane.upstream === upstream; }
      upstream.on('message', async (frame, binary) => {
        if (!current()) return;
        let event;
        try { event = JSON.parse(frame.toString()); } catch {}
        const active = lane.active;
        if (active) {
          active.started = true;
          if (event?.response?.id) active.responseId = event.response.id;
          if (event && TERMINAL.has(event.type)) {
            if (['response.completed', 'response.incomplete'].includes(event.type)) {
              try { await remember(lane, active, event.response); }
              catch (problem) { error(problem, lane); }
            }
            finish(lane, active);
          }
        }
        if (client.readyState !== WebSocket.OPEN) return;
        if (lane.id && event && !own(event, 'stream_id')) client.send(JSON.stringify({...event, stream_id: lane.id}));
        else client.send(frame, {binary});
      });
      upstream.on('close', () => {
        if (!current()) return;
        lane.upstream = null; lane.connected = false;
        const active = lane.active;
        if (active) {
          error(fail('GPT 连接已断开；本次请求不会自动重试。可在下一次请求重建历史。', 'openai_websocket_closed', 502), lane);
          finish(lane, active);
        }
      });
      upstream.on('error', () => {
        if (!current()) return;
        const active = lane.active;
        if (active) {
          error(fail('GPT WebSocket 连接失败；本次请求不会自动重试。', 'openai_websocket_error', 502), lane);
          finish(lane, active);
        }
      });
      upstream.on('unexpected-response', (_request, response) => {
        response.resume();
        if (!current()) return;
        const active = lane.active;
        if (active) {
          error(fail(`GPT 拒绝 WebSocket 连接（HTTP ${response.statusCode}）`, 'openai_websocket_rejected', response.statusCode), lane);
          finish(lane, active);
        }
        dropUpstream(lane);
      });
      return new Promise((resolve, reject) => {
        upstream.once('open', () => { if (!current()) return reject(fail('GPT 连接已失效', 'openai_websocket_closed', 502)); lane.connected = true; lane.everConnected = true; resolve(upstream); });
        upstream.once('error', () => reject(fail('GPT WebSocket 连接失败', 'openai_websocket_error', 502)));
        upstream.once('close', () => reject(fail('GPT WebSocket 连接已关闭', 'openai_websocket_closed', 502)));
        upstream.once('unexpected-response', () => reject(fail('GPT 拒绝 WebSocket 连接', 'openai_websocket_rejected', 502)));
      });
    }
    client.on('message', async (data, isBinary) => {
      let lane, active;
      try {
        let request;
        try { request = JSON.parse(data.toString()); } catch { throw fail('WebSocket 消息必须是 JSON', 'invalid_json'); }
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('无效的 WebSocket 消息', 'invalid_request');
        lane = laneFor(request);
        if (request.type === 'response.cancel') {
          const current = lane.active;
          if (!current) return;
          current.cancelled = true;
          current.controller.abort();
          if (isGpt(lane.route)) {
            if (lane.upstream?.readyState === WebSocket.OPEN) lane.upstream.send(data, {binary: isBinary});
            else { dropUpstream(lane); finish(lane, current); }
          }
          return;
        }
        if (request.type !== 'response.create') {
          if (isGpt(lane.route) && lane.upstream?.readyState === WebSocket.OPEN) { lane.upstream.send(data, {binary: isBinary}); return; }
          throw fail('请先发送 response.create；当前提供商不支持此消息', 'unsupported_websocket_message');
        }
        if (lane.busy) throw fail('当前 stream_id 的回复仍在进行，完成或取消后再切换模型。', 'response_in_progress', 409);
        // Acquire before any asynchronous operation; errors from other frames never release it.
        lane.busy = true;
        active = {controller: new AbortController(), request, started: false, cancelled: false};
        lane.active = active;
        const route = await routeFor(request.model);
        if (ended || lane.active !== active || active.cancelled) return;
        const changed = lane.route != null && providerOf(lane.route) !== providerOf(route);
        const connected = lane.connected && lane.upstream?.readyState === WebSocket.OPEN;
        const reconnect = isGpt(route) && lane.everConnected && !connected;
        const returning = isGpt(route) && changed;
        const expanded = await expandInput(clone(request), route);
        if (ended || lane.active !== active || active.cancelled) return;
        const forceReplay = !isGpt(route) || changed || reconnect || returning || (isGpt(route) && !connected && Boolean(request.previous_response_id));
        // Unknown first GPT IDs can still be handled by OpenAI, but cannot later migrate.
        let resolved;
        try { resolved = history.resolve(expanded, historyContext(lane, request, {provider: providerOf(route), historyScope:route?.historyScope,preserveOpaqueReasoning:route?.preserveOpaqueReasoning,forceReplay, requireReadable: changed})); }
        catch (problem) {
          if (isGpt(route) && !changed && !reconnect && !lane.everConnected) resolved = history.resolve(expanded, historyContext(lane, request, {provider: providerOf(route), forceReplay: false}));
          else throw problem;
        }
        active.request = expanded; active.resolved = resolved;
        const forwardHeaders = await headersFor(route, {...req.headers});
        collectSecrets(forwardHeaders);
        if (ended || lane.active !== active || active.cancelled) return;
        // Commit a provider switch only after validation and credential selection succeed.
        if (changed) dropUpstream(lane);
        lane.route = route;
        note(request.model || '(continuation)', isGpt(route) ? 'websocket' : 'websocket-to-sse');
        if (isGpt(route)) {
          const upstream = lane.upstream?.readyState === WebSocket.OPEN ? lane.upstream : await connect(lane, forwardHeaders);
          if (ended || lane.active !== active || active.cancelled) return;
          const changedBody = JSON.stringify(resolved.request) !== JSON.stringify(request);
          upstream.send(changedBody ? JSON.stringify(resolved.request) : data, {binary: changedBody ? false : isBinary});
          // GPT holds the response lock until its terminal frame or connection failure.
          active.dispatched = true;
          return;
        }
        const emit = event => {
          if (ended || lane.active !== active || active.cancelled) return;
          active.started = true;
          if (event?.response?.id) active.responseId = event.response.id;
          const outgoing = lane.id && !own(event, 'stream_id') ? {...event, stream_id: lane.id} : event;
          if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
            active.completed = event.response;
            active.completionWork = remember(lane, active, event.response).then(() => {
              if (!ended && lane.active === active && !active.cancelled) send(outgoing);
            });
            // The provider callback is allowed to ignore emit's returned promise.
            active.completionWork.catch(() => {});
            return active.completionWork;
          }
          send(outgoing);
        };
        const response = await runProvider({route, request: resolved.request, emit, signal: active.controller.signal, headers: forwardHeaders,historyScope:resolved.opaqueReasoningScope});
        if (active.completionWork) await active.completionWork;
        else if (!active.cancelled) await remember(lane, active, response);
      } catch (problem) {
        // Connection events already report handshake errors; avoid a duplicate error frame.
        if (!(active && lane?.active !== active && /^openai_websocket_/.test(problem?.code || ''))) error(problem, lane);
      } finally {
        if (active && (!active.dispatched || active.cancelled)) finish(lane, active);
      }
    });
    client.on('error', () => {});
    client.on('close', () => {
      ended = true;
      for (const lane of lanes.values()) { lane.active?.controller.abort(); dropUpstream(lane); }
      lanes.clear(); secrets.clear();
    });
  });
  function close() {
    if (closed) return;
    closed = true; server.off('upgrade', upgrade);
    for (const client of wss.clients) client.terminate();
    wss.close(); history.clear();
  }
  server.once('close', close);
  return {wss, history, close};
}

module.exports = {attachSocketRouter, createHistoryStore};
