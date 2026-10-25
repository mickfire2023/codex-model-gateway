'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const DEFAULT_DOCS = 'https://api-docs.deepseek.com/quick_start/agent_integrations/codex/';
const JSON_LIMIT = 1024 * 1024;
const HTML_LIMIT = 2 * JSON_LIMIT;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const problem = (code, status = null) => Object.assign(new Error(code), {code, status});
const clone = value => value == null ? null : structuredClone(value);

function supportsClient(actual, minimum) {
  const parse = value => {
    const match = typeof value === 'string' && value.match(/^(\d+)\.(\d+)\.(\d+)$/);
    const parts = match && match.slice(1).map(Number);
    return parts && parts.every(Number.isSafeInteger) ? parts : null;
  };
  const current = parse(actual), required = parse(minimum);
  if (!current || !required) return false;
  for (let index = 0; index < 3; index++) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function cacheScope(scopes, key) {
  const value = scopes.get(key) || {};
  scopes.delete(key);
  scopes.set(key, value);
  while (scopes.size > 16) scopes.delete(scopes.keys().next().value);
  return value;
}

function validateCatalog(value, deepseek = false, allowEmpty = false) {
  if (!value || !Array.isArray(value.models) || (!allowEmpty && !value.models.length)) throw problem('catalog_empty_or_invalid');
  const seen = new Set();
  for (const model of value.models) {
    if (!model || typeof model.slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.slug) || seen.has(model.slug)) throw problem('catalog_invalid_slug');
    seen.add(model.slug);
    for (const field of ['context_window', 'max_context_window']) {
      if (model[field] != null && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) throw problem('catalog_invalid_context');
    }
    if (model.context_window && model.max_context_window && model.max_context_window < model.context_window) throw problem('catalog_invalid_context');
    if (model.display_name != null && (typeof model.display_name !== 'string' || !model.display_name.trim())) throw problem('catalog_invalid_name');
    if (model.input_modalities != null && (!Array.isArray(model.input_modalities) || !model.input_modalities.length || model.input_modalities.some(x => !['text', 'image', 'audio', 'video'].includes(x)))) throw problem('catalog_invalid_modalities');
    if (model.supported_reasoning_levels != null && (!Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.length || model.supported_reasoning_levels.some(x => !x || typeof x.effort !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x.effort)))) throw problem('catalog_invalid_effort');
    if (deepseek) {
      if (!/^deepseek[-A-Za-z0-9_.:/]*$/i.test(model.slug)) throw problem('deepseek_invalid_slug');
      const efforts = model.supported_reasoning_levels?.map(x => x.effort);
      if (!model.context_window || !model.input_modalities?.includes('text') || !efforts?.length || new Set(efforts).size !== efforts.length || !efforts.includes(model.default_reasoning_level)) throw problem('deepseek_metadata_incomplete');
      if (!['freeform', 'function'].includes(model.apply_patch_tool_type) || typeof model.supports_parallel_tool_calls !== 'boolean' || typeof model.prefer_websockets !== 'boolean') throw problem('deepseek_metadata_incomplete');
      if (![model.base_instructions, model.model_messages?.instructions_template].some(x => typeof x === 'string' && x.trim())) throw problem('deepseek_metadata_incomplete');
    }
  }
  return value;
}

function extractDeepseekCatalog(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > HTML_LIMIT) throw problem('docs_invalid_or_too_large');
  const named = {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'};
  const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
    const name = entity.toLowerCase();
    if (Object.hasOwn(named, name)) return named[name];
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
  const candidates = [];
  for (const match of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
    const text = decode(match[1].replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
    let value;
    try { value = JSON.parse(text); } catch { continue; }
    if (value && Array.isArray(value.models)) candidates.push(value);
  }
  if (candidates.length !== 1) throw problem('docs_catalog_not_unique');
  return validateCatalog(candidates[0], true);
}

function validateApi(value) {
  if (value?.object !== 'list' || !Array.isArray(value.data) || !value.data.length) throw problem('deepseek_api_invalid');
  const ids = new Set();
  for (const item of value.data) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(item.id) || ids.has(item.id)) throw problem('deepseek_api_invalid');
    ids.add(item.id);
    for (const key of ['context_window', 'max_output_tokens']) {
      if (item[key] != null && (!Number.isSafeInteger(item[key]) || item[key] <= 0)) throw problem('deepseek_api_invalid');
    }
    if (item.input_modalities != null && (!Array.isArray(item.input_modalities) || !item.input_modalities.length || item.input_modalities.some(x => !['text', 'image'].includes(x)))) throw problem('deepseek_api_invalid');
    if (item.effort != null && (!Array.isArray(item.effort.supported_levels) || !item.effort.supported_levels.length || item.effort.supported_levels.some(x => typeof x !== 'string' || !x.trim()) || (item.effort.default_level != null && !item.effort.supported_levels.includes(item.effort.default_level)))) throw problem('deepseek_api_invalid');
  }
  return value;
}

function sourceUrl(value, officialHost) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (!local && (url.protocol !== 'https:' || url.hostname !== officialHost)) || (local && !['http:', 'https:'].includes(url.protocol))) throw problem('catalog_source_disallowed');
  return url;
}

function createCatalogUpdater(options) {
  const intervalMs = options.intervalMs ?? 1800000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw problem('catalog_interval_invalid');
  const directory = path.resolve(options.directory);
  const gptUrl = sourceUrl(String(options.gptBase).replace(/\/+$/, '') + '/models', 'chatgpt.com');
  const dsUrl = sourceUrl(String(options.deepseekBase).replace(/\/+$/, '') + '/models', 'api.deepseek.com');
  const docsUrl = sourceUrl(options.docsUrl || DEFAULT_DOCS, 'api-docs.deepseek.com');
  let gptCatalog = options.initialGptCatalog ? clone(validateCatalog(options.initialGptCatalog)) : null;
  let deepseekCatalog = options.initialDeepseekCatalog ? clone(validateCatalog(options.initialDeepseekCatalog, true, true)) : null;
  const initialState = catalog => ({lastAttempt: null, lastSuccess: null, errorCode: null, errorStatus: null, stale: true, modelCount: catalog?.models.length || 0});
  const providerStatus = {gpt: initialState(gptCatalog), deepseek: {...initialState(deepseekCatalog), pendingModels: []}};
  const gptScopes = new Map(), dsScopes = new Map(), docsSlot = {};
  const controllers = new Set();
  let timer = null, closed = false, queue = Promise.resolve();
  function log(record) { try { options.log?.(record); } catch {} }
  function status() { return clone(providerStatus); }
  function fresh(slot, headers) {
    const cacheControl = headers.get('cache-control') || '';
    const match = cacheControl.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)/i);
    const duration = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(cacheControl) ? 0 : match ? Math.min(Number(match[1]) * 1000, 86400000) : intervalMs;
    slot.nextAt = Date.now() + duration;
    slot.noStore = /(?:^|,)\s*no-store\b/i.test(cacheControl);
  }
  async function fetchValue(url, headers, slot, parse, force, limit = JSON_LIMIT) {
    if (!force && slot.value && Date.now() < slot.nextAt) return slot.value;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20000);
    timeout.unref?.();
    const outgoing = new Headers(headers);
    if (slot.etag) outgoing.set('if-none-match', slot.etag);
    try {
      if (closed) throw problem('updater_closed');
      const response = await fetch(url, {headers: outgoing, redirect: 'manual', signal: controller.signal});
      if (response.status === 304) {
        if (!slot.value) throw problem('catalog_unexpected_304');
        fresh(slot, response.headers);
        await response.body?.cancel();
        return slot.value;
      }
      if (!response.ok) { await response.body?.cancel(); throw problem('upstream_http_error', response.status); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw problem('catalog_too_large'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body || []) {
        length += chunk.length;
        if (length > limit) { controller.abort(); throw problem('catalog_too_large'); }
        chunks.push(chunk);
      }
      let value;
      try { value = parse(Buffer.concat(chunks).toString('utf8')); }
      catch (error) { throw error.code ? error : problem('catalog_invalid_json'); }
      if (closed) throw problem('updater_closed');
      slot.value = value;
      slot.etag = response.headers.get('etag');
      fresh(slot, response.headers);
      return value;
    } catch (error) {
      if (typeof error.code === 'string' && /^(catalog_|docs_|deepseek_|upstream_|updater_)/.test(error.code)) throw error;
      throw problem(closed ? 'updater_closed' : controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable');
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function persist(filename, catalog) {
    const target = path.join(directory, filename);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await fs.mkdir(directory, {recursive: true});
      await fs.writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      if (closed) throw problem('updater_closed');
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error.code === 'updater_closed' ? error : problem('catalog_persist_failed');
    }
  }
  function failed(provider, error) {
    const state = providerStatus[provider];
    state.errorCode = error.code || 'catalog_refresh_failed';
    state.errorStatus = Number.isInteger(error.status) ? error.status : null;
    state.stale = true;
    log({event: 'catalog_refresh_failed', provider, code: state.errorCode, status: state.errorStatus});
  }
  function succeeded(provider, catalog) {
    Object.assign(providerStatus[provider], {lastSuccess: new Date().toISOString(), errorCode: null, errorStatus: null, stale: false, modelCount: catalog.models.length});
    log({event: 'catalog_refreshed', provider, modelCount: catalog.models.length});
  }
  async function refreshGpt(credentials, override) {
    providerStatus.gpt.lastAttempt = new Date().toISOString();
    let scope;
    try {
      const custom = Object.hasOwn(override, 'chatgptHeaders');
      const headers = new Headers(custom ? override.chatgptHeaders : credentials.chatgptHeaders);
      for (const name of ['host', 'connection', 'content-length', 'cookie', 'upgrade', 'accept-encoding', 'if-none-match']) headers.delete(name);
      headers.set('accept', 'application/json');
      const authorization = headers.get('authorization');
      if (!authorization) throw problem('gpt_credentials_missing', 401);
      const version = override.clientVersion ?? credentials.clientVersion;
      if (typeof version !== 'string' || !/^[A-Za-z0-9._+-]{1,128}$/.test(version)) throw problem('gpt_client_version_missing');
      const identity = override.accountId || headers.get('chatgpt-account-id') || (!custom && credentials.accountId) || hash(authorization);
      const scopeKey = hash(identity + '\0' + version + '\0' + hash(authorization));
      scope = cacheScope(gptScopes, scopeKey);
      const url = new URL(gptUrl); url.searchParams.set('client_version', version);
      const catalog = await fetchValue(url, headers, scope, text => validateCatalog(JSON.parse(text)), override.force);
      if (!scope.noStore) await persist('openai-models.json', catalog);
      scope.committed = catalog;
      gptCatalog = clone(catalog);
      succeeded('gpt', catalog);
      return clone(catalog);
    } catch (error) {
      failed('gpt', error);
      if ([401, 403].includes(error.status)) {
        if (scope) { delete scope.value; delete scope.committed; delete scope.etag; }
        providerStatus.gpt.modelCount = 0;
        return null;
      }
      const fallback = clone(scope?.committed || null);
      providerStatus.gpt.modelCount = fallback?.models.length || 0;
      return fallback;
    }
  }
  async function refreshDeepseek(credentials, force) {
    providerStatus.deepseek.lastAttempt = new Date().toISOString();
    try {
      if (typeof credentials.deepseekKey !== 'string' || !credentials.deepseekKey.trim()) throw problem('deepseek_credentials_missing', 401);
      const scopeKey = hash(credentials.deepseekKey);
      const apiSlot = cacheScope(dsScopes, scopeKey);
      const results = await Promise.allSettled([
        fetchValue(dsUrl, {authorization: 'Bearer ' + credentials.deepseekKey, accept: 'application/json'}, apiSlot, text => validateApi(JSON.parse(text)), force),
        fetchValue(docsUrl, {accept: 'text/html'}, docsSlot, extractDeepseekCatalog, force, HTML_LIMIT)
      ]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      const [api, documented] = results.map(result => result.value);
      const metadata = new Map(documented.models.map(model => [model.slug, model]));
      const supported = item => metadata.has(item.id) && supportsClient(credentials.clientVersion, metadata.get(item.id).minimal_client_version);
      const pendingModels = api.data.filter(item => !supported(item)).map(item => item.id);
      // Report pending discoveries even when every entry is unavailable to this client.
      providerStatus.deepseek.pendingModels = pendingModels;
      const models = api.data.filter(supported).map(item => {
        const model = metadata.get(item.id);
        if ((item.context_window && item.context_window !== model.context_window) ||
            (item.input_modalities && [...item.input_modalities].sort().join() !== [...model.input_modalities].sort().join()) ||
            (item.effort && ([...item.effort.supported_levels].sort().join() !== model.supported_reasoning_levels.map(x => x.effort).sort().join() || (item.effort.default_level && item.effort.default_level !== model.default_reasoning_level)))) throw problem('deepseek_metadata_conflict');
        return model;
      });
      // Empty resolved results are valid: both upstream sources were non-empty and validated.
      const catalog = validateCatalog({...documented, models}, true, true);
      await persist('deepseek-models.json', catalog);
      deepseekCatalog = clone(catalog);
      succeeded('deepseek', catalog);
      return clone(catalog);
    } catch (error) { failed('deepseek', error); return clone(deepseekCatalog); }
  }
  async function perform(override) {
    if (closed) throw problem('updater_closed');
    let credentials;
    try { credentials = await options.getCredentials(); }
    catch { credentials = {}; }
    credentials ||= {};
    const [currentGpt, currentDeepseek] = await Promise.all([
      refreshGpt(credentials, override),
      override.skipDeepseek ? Promise.resolve(clone(deepseekCatalog)) : refreshDeepseek(credentials, override.force)
    ]);
    if (!closed && (currentGpt || currentDeepseek)) {
      try { await options.onUpdate?.({gptCatalog: clone(currentGpt), deepseekCatalog: clone(currentDeepseek)}); }
      catch { log({event: 'catalog_update_callback_failed', code: 'catalog_update_callback_failed'}); }
    }
    return {gptCatalog: currentGpt, deepseekCatalog: currentDeepseek, providerStatus: status()};
  }
  function refresh(override = {}) {
    const snapshot = {...override};
    if (snapshot.chatgptHeaders) snapshot.chatgptHeaders = new Headers(snapshot.chatgptHeaders);
    const pending = queue.then(() => perform(snapshot));
    queue = pending.catch(() => {});
    return pending;
  }
  function start() {
    if (closed) return Promise.reject(problem('updater_closed'));
    if (!timer) {
      timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
      timer.unref?.();
    }
    return refresh();
  }
  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const controller of controllers) controller.abort();
  }
  return {refresh, status, start, close};
}

module.exports = {extractDeepseekCatalog, createCatalogUpdater};
