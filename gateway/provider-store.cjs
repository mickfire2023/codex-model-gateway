'use strict';
const DEFAULT_CUSTOM_INSTRUCTIONS='You are a helpful coding assistant. Follow the user request and all supplied developer instructions. Respect workspace permissions and use the provided tools when appropriate. Verify changes before reporting completion.';

// This module never accepts incoming request headers. Each upstream receives only
// the credential explicitly configured for that provider.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const {randomUUID, createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CREDENTIAL_REF = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const EFFORTS = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
const MAX_MODELS_BYTES = 2 * 1024 * 1024;
const clone = value => structuredClone(value);
// Keep the registered provider identity and saved name stable across upgrades.
const providerDisplayName = provider => provider.id === 'gemini-subscription' && provider.name === 'Gemini 订阅' ? 'Antigravity 订阅' : provider.name;

function failure(message, code, status = 400) {
  return Object.assign(new Error(message), {code, status});
}

function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw failure(`请填写有效的${label}。`, 'invalid_provider_configuration');
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  const raw = text(value, '服务商 API 地址', 2048);
  // Reject these before URL parsing, which otherwise normalizes away some unsafe
  // spellings (including an empty query, fragments, or backslashes).
  if (/[?#\\\s]/.test(raw)) throw failure('API 地址不能包含查询参数、片段、空格或反斜杠。', 'invalid_provider_url');
  let url;
  try { url = new URL(raw); } catch { throw failure('请填写完整的 HTTPS API 地址。', 'invalid_provider_url'); }
  if (url.username || url.password || !url.hostname || url.search || url.hash) {
    throw failure('API 地址不能包含用户名、密码、查询参数或片段。', 'invalid_provider_url');
  }
  // An exact dotted-quad is intentional: URL() canonicalizes alternative IP
  // spellings, so test the original authority as well.
  const rawAuthority = raw.match(/^[a-z]+:\/\/([^/]+)/i)?.[1] || '';
  if (!rawAuthority || rawAuthority.includes('@')) throw failure('API 地址必须是完整地址，且不能包含用户名或密码。', 'invalid_provider_url');
  const localHttp = url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^127\.0\.0\.1(?::\d+)?$/.test(rawAuthority);
  if (url.protocol !== 'https:' && !localHttp) {
    throw failure('服务商必须使用 HTTPS；本机 Ollama 仅允许 http://127.0.0.1。', 'insecure_provider_url');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}

function endpointUrl(baseUrl, endpoint) {
  return new URL(`${normalizeBaseUrl(baseUrl)}/${endpoint}`);
}

function normalizeKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 16384 || /[^\x21-\x7e]/.test(value.trim())) {
    throw failure('请填写有效的 API 密钥；本机 Ollama 可填写 ollama。', 'invalid_provider_key');
  }
  return value.trim();
}

function modelId(value) {
  const result = text(value, '模型 ID', 512);
  if (result !== value) throw failure('模型 ID 不能包含首尾空格。', 'invalid_provider_configuration');
  try { encodeURIComponent(result); } catch { throw failure('模型 ID 包含无效字符。', 'invalid_provider_configuration'); }
  return result;
}

function makeModelSlug(providerId, id) {
  if (!PROVIDER_ID.test(providerId)) throw failure('服务商标识无效。', 'invalid_provider_id');
  return `custom/${providerId}/${encodeURIComponent(modelId(id))}`;
}

function parseModelSlug(slug) {
  if (typeof slug !== 'string') return null;
  const match = /^custom\/([a-z0-9][a-z0-9_-]{0,63})\/([^/]+)$/.exec(slug);
  if (!match) return null;
  try {
    const id = modelId(decodeURIComponent(match[2]));
    return makeModelSlug(match[1], id) === slug ? {providerId:match[1], modelId:id} : null;
  } catch { return null; }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000000) {
    throw failure(`请填写${label}（正整数 token 数）。`, 'missing_model_capabilities');
  }
  return value;
}

function normalizeModel(input) {
  if (!input || typeof input !== 'object') throw failure('模型配置无效。', 'invalid_provider_configuration');
  const id = modelId(input.id);
  const contextWindow = positiveInteger(input.contextWindow, '模型上下文长度');
  const maxOutputTokens = positiveInteger(input.maxOutputTokens, '模型最大输出长度');
  if (maxOutputTokens > contextWindow) throw failure('最大输出长度不能大于上下文长度。', 'invalid_model_capabilities');
  if (!Array.isArray(input.inputModalities) || !input.inputModalities.includes('text') || input.inputModalities.some(value=>!['text','image'].includes(value))) {
    throw failure('请明确选择模型输入能力（文本，或文本与图像）。', 'missing_model_capabilities');
  }
  if (typeof input.supportsTools !== 'boolean') throw failure('请明确选择模型是否支持工具调用。', 'missing_model_capabilities');
  if (input.preserveOpaqueReasoning !== undefined && typeof input.preserveOpaqueReasoning !== 'boolean') throw failure('保留服务商推理签名必须明确填写 true 或 false。', 'invalid_model_capabilities');
  if (!Array.isArray(input.reasoningEfforts) || input.reasoningEfforts.some(value=>!EFFORTS.has(value))) {
    throw failure('请明确填写模型推理档位；无推理能力请选择 none。', 'missing_model_capabilities');
  }
  const reasoningEfforts = [...new Set(input.reasoningEfforts)];
  if (reasoningEfforts.length === 0) reasoningEfforts.push('none');
  const defaultReasoningEffort = input.defaultReasoningEffort === undefined ? reasoningEfforts[0] : input.defaultReasoningEffort;
  if (!reasoningEfforts.includes(defaultReasoningEffort)) throw failure('默认推理档位必须在支持的档位中。', 'invalid_model_capabilities');
  return {
    id, displayName:text(input.displayName, '模型展示名称'), contextWindow, maxOutputTokens,
    inputModalities:['text', ...(input.inputModalities.includes('image') ? ['image'] : [])],
    supportsTools:input.supportsTools, reasoningEfforts, defaultReasoningEffort,
    ...(input.preserveOpaqueReasoning === true ? {preserveOpaqueReasoning:true} : {})
  };
}

function discoveryIds(value, label, maximum = 1000) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(`自动发现${label}列表无效。`, 'invalid_auto_discovery');
  const ids = value.map(modelId);
  if (new Set(ids).size !== ids.length) throw failure(`自动发现${label}列表包含重复模型。`, 'invalid_auto_discovery');
  return ids;
}

function normalizeAutoDiscovery(input, models) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw failure('自动发现设置无效。', 'invalid_auto_discovery');
  const managedModelIds = discoveryIds(input.managedModelIds || [], '管理型号', 100);
  const excludedModelIds = discoveryIds(input.excludedModelIds || [], '排除型号');
  const present = new Set(models.map(model=>model.id)), excluded = new Set(excludedModelIds);
  if (managedModelIds.some(id=>!present.has(id) || excluded.has(id))) throw failure('自动管理型号必须已登记且未被手动排除。', 'invalid_auto_discovery');
  return {enabled:input.enabled, managedModelIds, excludedModelIds};
}

function normalizeProvider(input, {allowEmptyModels = false} = {}) {
  if (!input || typeof input !== 'object') throw failure('服务商配置无效。', 'invalid_provider_configuration');
  const id = input.id === undefined || input.id === '' ? `p-${randomUUID()}` : input.id;
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw failure('服务商标识无效。', 'invalid_provider_id');
  const protocol = input.protocol || 'responses';
  if (!['responses','chat_completions'].includes(protocol)) throw failure('请选择 Responses 或 Chat Completions 协议。', 'invalid_provider_protocol');
  const models = input.models === undefined && allowEmptyModels ? [] : input.models;
  if (!Array.isArray(models) || models.length > 100 || (!allowEmptyModels && !models.length)) {
    throw failure('请至少配置一个模型。', 'invalid_provider_configuration');
  }
  const normalized = models.map(normalizeModel);
  const preserveOpaqueReasoning = normalized.some(model=>model.preserveOpaqueReasoning);
  if (preserveOpaqueReasoning && (protocol !== 'responses' || !/^[a-f0-9]{64}$/.test(input.opaqueReasoningIdentity || ''))) {
    throw failure('保留推理签名需要 Responses 接口和已验证的订阅账号身份指纹。', 'invalid_opaque_reasoning_configuration');
  }
  if (input.opaqueReasoningIdentity !== undefined && !/^[a-f0-9]{64}$/.test(input.opaqueReasoningIdentity)) throw failure('订阅账号身份指纹无效。', 'invalid_opaque_reasoning_configuration');
  if (new Set(normalized.map(model=>model.id)).size !== normalized.length) throw failure('同一服务商不能重复添加相同模型 ID。', 'duplicate_provider_model');
  return {id, name:text(input.name, '服务商名称'), baseUrl:normalizeBaseUrl(input.baseUrl), protocol, models:normalized,
    ...(input.opaqueReasoningIdentity ? {opaqueReasoningIdentity:input.opaqueReasoningIdentity} : {}),
    ...(input.autoDiscovery !== undefined ? {autoDiscovery:normalizeAutoDiscovery(input.autoDiscovery, normalized)} : {})};
}

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function createDpapiCredentialStore({directory, spawnSyncImpl = spawnSync, platform = process.platform} = {}) {
  if (!directory) throw new TypeError('Credential directory is required');
  function credentialPath(ref) {
    if (!CREDENTIAL_REF.test(ref)) throw failure('本地凭据标识无效。', 'invalid_credential_reference', 500);
    return path.join(directory, `${ref}.dpapi`);
  }
  function run(script, input) {
    if (platform !== 'win32') throw failure('此密钥存储需要 Windows 当前用户加密。', 'credential_store_unavailable', 503);
    const env = {...process.env, PSModulePath:path.join(process.env.SystemRoot || 'C:\\Windows', 'System32','WindowsPowerShell','v1.0','Modules')};
    const result = spawnSyncImpl('powershell.exe', ['-NoProfile','-NonInteractive','-Command', `$ErrorActionPreference='Stop'; ${script}`], {input, env, encoding:'utf8', windowsHide:true, timeout:15000, maxBuffer:1024*1024});
    if (result.error || result.status !== 0) throw failure('无法读取或保存 Windows 加密密钥。', 'credential_store_unavailable', 503);
    return String(result.stdout || '').trim();
  }
  return {
    get(ref) {
      const file = credentialPath(ref);
      if (!fs.existsSync(file)) return '';
      const encrypted = fs.readFileSync(file, 'utf8');
      const result = run("$s = ConvertTo-SecureString ([Console]::In.ReadToEnd()); [Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)", encrypted);
      return normalizeKey(result);
    },
    set(ref, key) {
      const encrypted = run("$s = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))", normalizeKey(key));
      if (!encrypted) throw failure('无法保存 Windows 加密密钥。', 'credential_store_unavailable', 503);
      atomicWrite(credentialPath(ref), encrypted);
    },
    delete(ref) {
      try { fs.unlinkSync(credentialPath(ref)); } catch (error) { if (error.code !== 'ENOENT') throw failure('无法移除本地加密密钥。', 'credential_cleanup_failed', 500); }
    }
  };
}

function defaultRequest(url, {method = 'GET', headers, signal, timeoutMs = 15000} = {}) {
  // node:http never follows redirects. Do not replace this with an automatically
  // redirecting fetch call: a provider key must stay at the entered endpoint.
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {method, headers, signal}, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return resolve({status:res.statusCode, body:''}); }
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_MODELS_BYTES) { res.destroy(failure('服务商模型列表过大。', 'invalid_models_response', 502)); return; }
        chunks.push(chunk);
      });
      res.on('end', ()=>resolve({status:res.statusCode, body:Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, ()=>req.destroy(failure('连接服务商超时，请检查地址与网络。', 'provider_network_error', 504)));
    req.end();
  });
}

function providerHeaders(apiKey, streaming = false) {
  return {authorization:`Bearer ${apiKey}`, 'content-type':'application/json', accept:streaming ? 'text/event-stream, application/json' : 'application/json', 'accept-encoding':'identity'};
}

function validationError(status) {
  if (status === 401 || status === 403) return failure('API 密钥无效，或该账号没有访问模型列表的权限。', 'provider_authentication_failed', 400);
  if (status === 429) return failure('服务商限流或额度不足，请检查额度并稍后重试。', 'provider_rate_limited', 429);
  if (status === 402) return failure('服务商账号余额或额度不足。', 'provider_quota_exceeded', 400);
  if (status >= 300 && status < 400) return failure('服务商返回了重定向；为保护密钥，请直接填写最终 API 地址。', 'provider_redirect_blocked', 400);
  if (status === 404 || status === 405) return failure('此 API 地址不支持 GET /models，请核对兼容接口地址。', 'provider_models_unsupported', 400);
  return failure(`服务商模型列表检查失败（HTTP ${Number.isInteger(status) ? status : '未知'}）。`, 'provider_validation_failed', 502);
}

function createProviderStore(options = {}) {
  const directory = options.directory || __dirname;
  const credentialsDirectory = path.join(directory, 'private','providers');
  const configFile = path.join(credentialsDirectory, 'providers.json');
  const credentialStore = options.credentialStore || createDpapiCredentialStore({directory:credentialsDirectory});
  const request = options.request || defaultRequest;
  const writeConfig = options.writeConfig || atomicWrite;
  const now = options.now || (()=>new Date().toISOString());
  const template = typeof options.template === 'string' ? {base_instructions:options.template, model_messages:{instructions_template:options.template}} : clone(options.template || {});
  let providers = [];
  const keys = new Map();
  let mutation = Promise.resolve();
  function exclusive(action) {
    const result = mutation.then(action);
    mutation = result.catch(()=>{});
    return result;
  }
  function cleanup(ref) {
    try { credentialStore.delete(ref); return true; } catch { return false; }
  }
  function persist(next) {
    try { writeConfig(configFile, `${JSON.stringify({version:1, providers:next}, null, 2)}\n`); }
    catch { throw failure('无法保存服务商配置，原配置与密钥已保留。', 'provider_save_failed', 500); }
  }
  function publicProvider(provider, keyConfigured = !!keys.get(provider.id)) {
    return {
      id:provider.id, name:provider.name, displayName:providerDisplayName(provider), baseUrl:provider.baseUrl, protocol:provider.protocol,
      ...(provider.opaqueReasoningIdentity ? {opaqueReasoningIdentity:provider.opaqueReasoningIdentity} : {}),
      ...(provider.autoDiscovery ? {autoDiscovery:clone(provider.autoDiscovery)} : {}),
      keyConfigured,
      models:provider.models.map(model=>({...clone(model), slug:makeModelSlug(provider.id, model.id)})),
      validation:clone(provider.validation || {modelsEndpointVerified:false, responsesVerified:false, toolsVerified:false})
    };
  }
  if (fs.existsSync(configFile)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (loaded.version !== 1 || !Array.isArray(loaded.providers) || loaded.providers.length > 100) throw new Error('Invalid provider store');
      providers = loaded.providers.map(item=>{
        const normalized = normalizeProvider(item, {allowEmptyModels:true});
        if (typeof item.credentialRef !== 'string' || !CREDENTIAL_REF.test(item.credentialRef)) throw new Error('Invalid credential reference');
        const validation = {modelsEndpointVerified:item.validation?.modelsEndpointVerified === true, modelsCheckedAt:typeof item.validation?.modelsCheckedAt === 'string' ? item.validation.modelsCheckedAt : null, selectedModelsVerified:item.validation?.selectedModelsVerified === true && normalized.models.length > 0, responsesVerified:false, toolsVerified:false};
        return {...normalized, credentialRef:item.credentialRef, validation};
      });
      if (new Set(providers.map(provider=>provider.id)).size !== providers.length) throw new Error('Duplicate provider id');
      if (new Set(providers.map(provider=>provider.credentialRef)).size !== providers.length) throw new Error('Duplicate credential reference');
    } catch { throw failure('本地服务商配置损坏；为保护原配置，已停止加载。', 'provider_store_invalid', 500); }
    for (const provider of providers) {
      try {
        const key = credentialStore.get(provider.credentialRef);
        if (key && typeof key === 'string') keys.set(provider.id, normalizeKey(key));
      } catch { /* A provider with an unavailable credential remains editable. */ }
    }
  }
  function resolveCandidate(input, allowEmptyModels = false) {
    const provider = normalizeProvider(input, {allowEmptyModels});
    const previous = providers.find(item=>item.id === provider.id);
    if (previous?.autoDiscovery) {
      // Ordinary user edits retain automatic-discovery intent, but the edited or
      // removed models become user-owned and cannot be silently overwritten.
      // The store's current metadata wins over a stale form snapshot. Discovery
      // policy itself is changed through configureAutoDiscovery, not model save.
      const managed = new Set(previous.autoDiscovery.managedModelIds);
      const excluded = new Set(previous.autoDiscovery.excludedModelIds);
      const before = new Map(previous.models.map(model=>[model.id, model]));
      const after = new Map(provider.models.map(model=>[model.id, model]));
      for (const [id, model] of before) {
        if (!after.has(id) || (managed.has(id) && JSON.stringify(after.get(id)) !== JSON.stringify(model))) {
          managed.delete(id); excluded.add(id);
        }
      }
      // Explicitly adding an excluded model back is a user action. It remains
      // user-owned until automatic management is explicitly configured again.
      for (const id of after.keys()) if (!before.has(id)) excluded.delete(id);
      provider.autoDiscovery = normalizeAutoDiscovery({...previous.autoDiscovery, managedModelIds:[...managed], excludedModelIds:[...excluded]}, provider.models);
    }
    const explicitKey = typeof input.apiKey === 'string' && input.apiKey.trim() !== '';
    if (previous && previous.baseUrl !== provider.baseUrl && !explicitKey) {
      throw failure('更换 API 地址时请重新填写该地址对应的密钥。', 'provider_key_confirmation_required');
    }
    const key = explicitKey ? normalizeKey(input.apiKey) : keys.get(provider.id);
    if (!key) throw failure('请填写该服务商的 API 密钥。', 'provider_key_missing');
    return {provider, previous, key, explicitKey};
  }
  async function validateCandidate(candidate) {
    let response;
    try {
      response = await request(endpointUrl(candidate.provider.baseUrl, 'models'), {method:'GET', headers:providerHeaders(candidate.key), redirect:'manual', timeoutMs:15000});
    } catch (error) {
      if (error?.code === 'invalid_models_response') throw failure('服务商模型列表过大或无效。', 'invalid_models_response', 502);
      // Never expose upstream text/errors: those can contain the supplied key.
      throw failure('无法连接服务商，请检查 API 地址、网络或代理设置。', 'provider_network_error', 502);
    }
    const status = response?.status ?? response?.statusCode;
    if (!(status >= 200 && status < 300)) throw validationError(status);
    let payload;
    try {
      const body = response.body;
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        if (Buffer.byteLength(body) > MAX_MODELS_BYTES) throw new Error('Too large');
        payload = JSON.parse(body.toString());
      } else payload = body;
      if (!payload || !Array.isArray(payload.data) || payload.data.length > 10000) throw new Error('Invalid models list');
    } catch { throw failure('服务商未返回有效的 OpenAI 兼容模型列表。', 'invalid_models_response', 502); }
    const availableModels = [];
    const ids = new Set();
    for (const item of payload.data) {
      if (!item || typeof item.id !== 'string') continue;
      let id;
      try { id = modelId(item.id); } catch { continue; }
      if (ids.has(id)) continue;
      ids.add(id);
      // Only known display fields are exposed; arbitrary provider metadata and
      // response bodies never enter configuration, public responses or logs.
      let displayName = id;
      try { if (item.name || item.display_name) displayName = text(item.name || item.display_name, '模型展示名称'); } catch {}
      availableModels.push({id, displayName});
    }
    if (candidate.provider.models.some(model=>!ids.has(model.id))) {
      throw failure('所选模型 ID 不在该账号的模型列表中，请核对模型 ID 或访问权限。', 'provider_model_not_available');
    }
    const validation = {modelsEndpointVerified:true, modelsCheckedAt:now(), selectedModelsVerified:candidate.provider.models.length > 0, responsesVerified:false, toolsVerified:false};
    return {ok:true, provider:publicProvider({...candidate.provider, validation}, true), availableModels, validation, message:'已检查账号凭据与模型列表；尚未实测推理、Responses 兼容性或工具调用。'};
  }
  async function validateProvider(input) { return validateCandidate(resolveCandidate(input, true)); }
  function saveProvider(input) {
    // Snapshot caller-owned data before awaiting, so the address/key/model being
    // saved cannot change while its credentials are being validated.
    const snapshot = clone(input);
    return exclusive(async ()=>{
      const candidate = resolveCandidate(snapshot);
      const checked = await validateCandidate(candidate);
      const replaceCredential = candidate.explicitKey || !candidate.previous;
      const credentialRef = replaceCredential ? `${candidate.provider.id}-${randomUUID()}` : candidate.previous.credentialRef;
      if (replaceCredential) {
        try { credentialStore.set(credentialRef, candidate.key); }
        catch { cleanup(credentialRef); throw failure('无法保存加密密钥，原配置与密钥已保留。', 'provider_credential_save_failed', 500); }
      }
      const provider = {...candidate.provider, credentialRef, validation:checked.validation};
      const next = [...providers.filter(item=>item.id !== provider.id), provider];
      try { persist(next); } catch (error) { if (replaceCredential) cleanup(credentialRef); throw error; }
      providers = next;
      keys.set(provider.id, candidate.key);
      const credentialCleanupPending = replaceCredential && candidate.previous && !cleanup(candidate.previous.credentialRef);
      return {...publicProvider(provider), ...(credentialCleanupPending ? {credentialCleanupPending:true} : {})};
    });
  }
  function removeProvider(id) {
    return exclusive(()=>{
      const provider = providers.find(item=>item.id === id);
      if (!provider) throw failure('服务商不存在。', 'provider_not_found', 404);
      const next = providers.filter(item=>item.id !== id);
      persist(next); providers = next; keys.delete(id);
      return {removed:true, providerId:id, ...(!cleanup(provider.credentialRef) ? {credentialCleanupPending:true} : {})};
    });
  }
  function removeModel(providerId, id) {
    return exclusive(()=>{
      const provider = providers.find(item=>item.id === providerId);
      if (!provider) throw failure('服务商不存在。', 'provider_not_found', 404);
      if (!provider.models.some(model=>model.id === id)) throw failure('模型不存在。', 'provider_model_not_found', 404);
      const models = provider.models.filter(model=>model.id !== id);
      const autoDiscovery = provider.autoDiscovery ? normalizeAutoDiscovery({
        ...provider.autoDiscovery,
        managedModelIds:provider.autoDiscovery.managedModelIds.filter(modelId=>modelId !== id),
        excludedModelIds:[...new Set([...provider.autoDiscovery.excludedModelIds, id])]
      }, models) : undefined;
      const nextProvider = {...provider, models, ...(autoDiscovery ? {autoDiscovery} : {}), validation:{...provider.validation, selectedModelsVerified:provider.validation.selectedModelsVerified && models.length > 0}};
      const next = providers.map(item=>item.id === providerId ? nextProvider : item);
      persist(next); providers = next;
      return publicProvider(nextProvider);
    });
  }
  function discoveryRevision(provider) {
    const canonical = value=>Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(canonical(provider))).digest('hex');
  }
  function discoverySnapshot(provider) {
    if (!provider) return null;
    return {provider:publicProvider(provider), revision:discoveryRevision(provider), enabled:provider.autoDiscovery?.enabled === true,
      managedModelIds:clone(provider.autoDiscovery?.managedModelIds || []), excludedModelIds:clone(provider.autoDiscovery?.excludedModelIds || [])};
  }
  function getDiscoverySnapshot(id) { return discoverySnapshot(providers.find(provider=>provider.id === id)); }
  function configureAutoDiscovery(id, input) {
    const snapshot = clone(input);
    return exclusive(()=>{
      const previous = providers.find(provider=>provider.id === id);
      if (!previous) throw failure('服务商不存在。', 'provider_not_found', 404);
      if (previous.protocol !== 'responses' || !/^[a-f0-9]{64}$/.test(previous.opaqueReasoningIdentity || '')) throw failure('自动发现需要已验证的订阅 Responses 服务商。', 'invalid_auto_discovery');
      if (!snapshot || typeof snapshot.enabled !== 'boolean') throw failure('自动发现开关无效。', 'invalid_auto_discovery');
      const autoDiscovery = normalizeAutoDiscovery({enabled:snapshot.enabled,
        managedModelIds:snapshot.managedModelIds === undefined ? previous.autoDiscovery?.managedModelIds || [] : snapshot.managedModelIds,
        excludedModelIds:previous.autoDiscovery?.excludedModelIds || []}, previous.models);
      if (JSON.stringify(autoDiscovery) === JSON.stringify(previous.autoDiscovery)) return {...discoverySnapshot(previous), changed:false};
      const nextProvider = {...previous, autoDiscovery};
      persist(providers.map(provider=>provider.id === id ? nextProvider : provider));
      providers = providers.map(provider=>provider.id === id ? nextProvider : provider);
      return {...discoverySnapshot(nextProvider), changed:true};
    });
  }
  function getDiscoveryTarget(id) {
    const provider = providers.find(provider=>provider.id === id);
    if (!provider) throw failure('服务商不存在。', 'provider_not_found', 404);
    const key = keys.get(id);
    if (!key) throw failure('该服务商密钥不可用，请在管理页重新填写。', 'provider_key_missing', 503);
    const target = {providerId:id, baseUrl:provider.baseUrl, protocol:provider.protocol, accountIdentity:provider.opaqueReasoningIdentity,
      revision:discoveryRevision(provider), enabled:provider.autoDiscovery?.enabled === true};
    Object.defineProperties(target, {headers:{value:Object.freeze(providerHeaders(key, true))}, toJSON:{value:()=>{throw new Error('Discovery credentials must not be serialized');}}});
    return target;
  }
  function reconcileDiscoveredModels(id, input) {
    const snapshot = clone(input);
    return exclusive(()=>{
      const previous = providers.find(provider=>provider.id === id);
      if (!previous) throw failure('服务商不存在。', 'provider_not_found', 404);
      if (!previous.autoDiscovery?.enabled) throw failure('该服务商已停用自动发现。', 'auto_discovery_disabled', 409);
      if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.expectedRevision || '') || snapshot.expectedRevision !== discoveryRevision(previous)) throw failure('验证期间服务商设置发生变化，本次模型更新已取消。', 'auto_discovery_conflict', 409);
      if (!/^[a-f0-9]{64}$/.test(snapshot.accountIdentity || '') || snapshot.accountIdentity !== previous.opaqueReasoningIdentity) throw failure('订阅账号已变化，请重新验证登录后再更新模型。', 'auto_discovery_identity_changed', 409);
      if (!Array.isArray(snapshot.upserts) || snapshot.upserts.length > 100) throw failure('自动发现模型配置无效。', 'invalid_auto_discovery');
      const upserts = snapshot.upserts.map(normalizeModel);
      const removes = new Set(discoveryIds(snapshot.removeIds || [], '移除型号'));
      if (new Set(upserts.map(model=>model.id)).size !== upserts.length || upserts.some(model=>removes.has(model.id))) throw failure('自动发现包含重复或冲突的模型操作。', 'invalid_auto_discovery');
      const managed = new Set(previous.autoDiscovery.managedModelIds), excluded = new Set(previous.autoDiscovery.excludedModelIds);
      let models = previous.models.filter(model=>!removes.has(model.id) || !managed.has(model.id));
      for (const id of removes) managed.delete(id);
      const skippedModelIds = [];
      for (const model of upserts) {
        const index = models.findIndex(item=>item.id === model.id);
        if (excluded.has(model.id) || (index >= 0 && !managed.has(model.id))) { skippedModelIds.push(model.id); continue; }
        if (index >= 0) models[index] = model; else models.push(model);
        managed.add(model.id);
      }
      const candidate = normalizeProvider({...previous, models, autoDiscovery:{...previous.autoDiscovery, managedModelIds:[...managed]}}, {allowEmptyModels:true});
      const nextProvider = {...previous, ...candidate, validation:{...previous.validation, selectedModelsVerified:previous.validation.selectedModelsVerified && models.length > 0}};
      if (JSON.stringify(nextProvider) === JSON.stringify(previous)) return {...discoverySnapshot(previous), changed:false, skippedModelIds};
      persist(providers.map(provider=>provider.id === id ? nextProvider : provider));
      providers = providers.map(provider=>provider.id === id ? nextProvider : provider);
      return {...discoverySnapshot(nextProvider), changed:true, skippedModelIds};
    });
  }
  function routeBySlug(slug) {
    const parsed = parseModelSlug(slug);
    if (!parsed) return null;
    const provider = providers.find(item=>item.id === parsed.providerId);
    const model = provider?.models.find(item=>item.id === parsed.modelId);
    if (!model) return null;
    const preserveOpaqueReasoning = provider.protocol === 'responses' && model.preserveOpaqueReasoning === true;
    // A saved credential replacement (even with the same key) starts a new
    // provenance scope. The account fingerprint represents the single account
    // pinned by the local OAuth proxy; re-register it after switching accounts.
    const historyScope = preserveOpaqueReasoning ? createHash('sha256').update(JSON.stringify([provider.id,provider.baseUrl,model.id,provider.credentialRef,provider.opaqueReasoningIdentity])).digest('hex') : undefined;
    return {slug, providerId:provider.id, providerName:providerDisplayName(provider), baseUrl:provider.baseUrl, protocol:provider.protocol, modelId:model.id, model:clone(model), keyConfigured:!!keys.get(provider.id),
      ...(preserveOpaqueReasoning ? {preserveOpaqueReasoning:true,historyScope} : {})};
  }
  function upstreamForSlug(slug) {
    const route = routeBySlug(slug);
    if (!route) throw failure('此自定义模型未启用或已移除。', 'provider_model_not_found', 400);
    const apiKey = keys.get(route.providerId);
    if (!apiKey) throw failure('该服务商密钥不可用，请在管理页重新填写。', 'provider_key_missing', 503);
    // INTERNAL ONLY. Do not serialize, log, or return this object to a client.
    // toJSON is deliberately non-enumerable to reduce accidental disclosure.
    const result = {...route, url:endpointUrl(route.baseUrl, route.protocol === 'chat_completions' ? 'chat/completions' : 'responses'), modelId:route.modelId, redirect:'manual'};
    Object.defineProperties(result, {
      apiKey:{value:apiKey},
      headers:{value:Object.freeze(providerHeaders(apiKey, true))},
      toJSON:{value:()=>{ throw new Error('Upstream credentials must not be serialized'); }}
    });
    return result;
  }
  function catalogModels() {
    return providers.flatMap((provider, providerIndex)=>provider.models.map((model, modelIndex)=>{
      const name = providerDisplayName(provider);
      const instructions = template.model_messages ? {model_messages:clone(template.model_messages)} : {};
      if (typeof template.base_instructions === 'string') instructions.base_instructions = template.base_instructions;
      return {
        ...instructions,
        slug:makeModelSlug(provider.id, model.id), display_name:`${model.displayName} · ${name}`,
        description:`${name} · ${model.id}（用户配置能力；仅已检查模型列表）`,
        provider_id:provider.id, provider_name:name,
        prefer_websockets:false, support_verbosity:false, default_verbosity:null,
        apply_patch_tool_type:'freeform', web_search_tool_type:'text',
        input_modalities:clone(model.inputModalities), supports_image_detail_original:false,
        truncation_policy:{mode:'tokens', limit:Math.min(10000, model.maxOutputTokens)},
        supports_tools:model.supportsTools, supports_tool_calls:model.supportsTools,
        supports_parallel_tool_calls:false, supports_search_tool:false, experimental_supported_tools:[],
        tool_mode:null, multi_agent_version:'v2', use_responses_lite:false,
        include_skills_usage_instructions:false, auto_review_model_override:null,
        context_window:model.contextWindow, max_context_window:model.contextWindow,
        max_output_tokens:model.maxOutputTokens, effective_context_window_percent:95,
        auto_compact_token_limit:null, comp_hash:'3000',
        reasoning_summary_format:'experimental', default_reasoning_summary:'none', supports_reasoning_summaries:false,
        default_reasoning_level:model.defaultReasoningEffort,
        supported_reasoning_levels:model.reasoningEfforts.map(effort=>({effort, description:effort === 'none' ? '不启用推理' : `服务商声明的 ${effort} 推理档位`})),
        shell_type:'shell_command', visibility:'list', minimal_client_version:template.minimal_client_version || '0.144.0',
        supported_in_api:true, availability_nux:null, upgrade:null, priority:300 + providerIndex*100 + modelIndex,
        service_tiers:[], additional_speed_tiers:[], default_service_tier:null,
        available_access_programs:{cyber:['standard']}
      };
    }));
  }
  return {
    listProviders:()=>providers.map(provider=>publicProvider(provider)),
    catalogModels, getCatalog:()=>({models:catalogModels()}), validateProvider,
    saveProvider, removeProvider, removeModel, routeBySlug, upstreamForSlug,
    configureAutoDiscovery, getDiscoverySnapshot, getDiscoveryTarget, reconcileDiscoveredModels
  };
}

module.exports = {DEFAULT_CUSTOM_INSTRUCTIONS,createProviderStore, createDpapiCredentialStore, normalizeBaseUrl, makeModelSlug, parseModelSlug};
