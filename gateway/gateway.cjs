'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {StringDecoder} = require('node:string_decoder');
const {createHmac,timingSafeEqual} = require('node:crypto');
const {WebSocket, WebSocketServer} = require('ws');
const {createAdapter} = require('./deepseek-adapter.cjs');
const {isCompactionRequest,expandLocalCompactions,makeSummaryRequest,makeCompactionEvents} = require('./compaction.cjs');
const {renderManagement} = require('./management-page.cjs');
const {createProviderStore,DEFAULT_CUSTOM_INSTRUCTIONS} = require('./provider-store.cjs');
const {attachSocketRouter} = require('./socket-router.cjs');
const {prepareChatRequest,convertChatStream} = require('./chat-completions.cjs');

const HOP_HEADERS = new Set(['host','connection','proxy-connection','keep-alive','transfer-encoding','upgrade','te','trailer','proxy-authorization','proxy-authenticate','sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol']);
function headersFor(headers, deepseekKey) {
  if (deepseekKey !== undefined) return {'authorization':`Bearer ${deepseekKey}`,'content-type':'application/json','accept':'text/event-stream, application/json','accept-encoding':'identity'};
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-gateway-')));
}
function decoded(buffer, encoding) {
  switch (String(encoding || '').toLowerCase()) {
    case 'gzip': return zlib.gunzipSync(buffer);
    case 'deflate': return zlib.inflateSync(buffer);
    case 'br': return zlib.brotliDecompressSync(buffer);
    case 'zstd': return zlib.zstdDecompressSync(buffer);
    case '': case 'identity': return buffer;
    default: throw Object.assign(new Error('Unsupported request encoding'),{status:415});
  }
}
async function readBody(req,limit=160 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) throw Object.assign(new Error('请求内容过大。'),{status:413,code:'body_too_large'}); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function json(res,status,value) { if (res.destroyed) return; res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(value)); }
function requestUpstream(url, options, body) {
  return new Promise((resolve,reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url,options,resolve);
    req.on('error',reject); req.setTimeout(600000,()=>req.destroy(new Error('Upstream request timed out')));
    if (body) req.write(body); req.end();
  });
}
async function* events(stream) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0,match.index); pending = pending.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') { try { yield JSON.parse(data); } catch { throw new Error('Invalid upstream streaming event'); } }
    }
  }
  pending += decoder.end();
  if (pending.trim()) {
    const data = pending.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}
function loadKey(dir) {
  const file = path.join(dir,'private','deepseek-key.dpapi');
  if (!fs.existsSync(file)) return '';
  const env = {...process.env,PSModulePath:path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),CODEX_GATEWAY_CREDENTIAL_FILE:file};
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $s = Get-Content -Raw -LiteralPath $env:CODEX_GATEWAY_CREDENTIAL_FILE | ConvertTo-SecureString; [Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)"],{env,encoding:'utf8',windowsHide:true});
  if (result.status !== 0) throw new Error('Unable to decrypt the local DeepSeek credential');
  return result.stdout.trim();
}
function saveKey(dir,key) {
  if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key)) throw Object.assign(new Error('Invalid DeepSeek API key format'),{status:400});
  const env = {...process.env,PSModulePath:path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),CODEX_GATEWAY_CREDENTIAL_FILE:path.join(dir,'private','deepseek-key.dpapi')};
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $k = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $k -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))"],{input:key,env,encoding:'utf8',windowsHide:true,timeout:15000});
  if (result.status !== 0) throw new Error('Unable to save the encrypted credential');
  const target=env.CODEX_GATEWAY_CREDENTIAL_FILE, temporary=target+'.'+process.pid+'.tmp';
  try { fs.writeFileSync(temporary,result.stdout.trim(),{mode:0o600}); fs.renameSync(temporary,target); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
function createGateway(settings, options = {}) {
  const dir=path.resolve(settings.directory || __dirname);
  const providerTransport=options.providerRequestUpstream||requestUpstream;
  fs.mkdirSync(path.join(dir,'private'),{recursive:true});
  const root='/'+settings.routeToken, prefix=root+'/backend-api/codex';
  const tokenFor=action=>createHmac('sha256',settings.routeToken).update(action==='key'?'codex-gateway:admin:key-form:v1':action==='refresh'?'codex-gateway:admin:catalog-refresh:v1':'codex-gateway:admin:'+action+':v2').digest('hex');
  const actions=['key','refresh','diagnose','restart','restore','provider-save','provider-delete','provider-remove-model','probe','gemini-refresh','gemini-toggle'];
  const controlCsrf=Object.fromEntries(actions.map(action=>[action,tokenFor(action)]));
  const gptBase=options.gptBase || 'https://chatgpt.com/backend-api/codex';
  const deepseekBase=options.deepseekBase || 'https://api.deepseek.com';
  let key=options.deepseekKey===undefined?loadKey(dir):options.deepseekKey;
  let original=JSON.parse(fs.readFileSync(path.join(dir,'openai-models.json'),'utf8'));
  let dsCatalog=JSON.parse(fs.readFileSync(path.join(dir,'deepseek-models.json'),'utf8'));
  const deepseekIds=new Set(dsCatalog.models.map(model=>model.slug));
  const providers=options.providerStore || createProviderStore({directory:dir,template:{base_instructions:DEFAULT_CUSTOM_INSTRUCTIONS,model_messages:{instructions_template:DEFAULT_CUSTOM_INSTRUCTIONS}},credentialStore:options.credentialStore,request:options.providerRequest});
  const stats={startedAt:new Date().toISOString(),gptRequests:0,deepseekRequests:0,customRequests:0,catalogRequests:0,lastRoute:null};
  const diagnostics={lastCheckedAt:null,checks:[],recentErrors:[],control:null};
  let validation={status:'unknown',checkedAt:null,message:'尚未进行连接检查；已保存的密钥仍会继续使用。'};
  let notice=null;
  const logFile=path.join(dir,'gateway.log');
  function log(record) {
    try {
      try { if(fs.statSync(logFile).size>1024*1024) { try{fs.unlinkSync(logFile+'.2');}catch{} try{fs.renameSync(logFile+'.1',logFile+'.2');}catch{} fs.renameSync(logFile,logFile+'.1'); } }catch{}
      fs.appendFileSync(logFile,JSON.stringify({time:new Date().toISOString(),...record})+'\n');
    }catch{}
  }
  function friendly(error) {
    const status=Number(error?.status || 502),code=String(error?.code || 'gateway_error').slice(0,100);
    let message=String(error?.message || '');
    if(error?.name==='AbortError') message='请求已取消。';
    else if(status===401||status===403) message='账号凭据无效或没有模型权限，请检查登录或密钥。';
    else if(status===402) message='服务商余额不足，请检查账户余额。';
    else if(status===429) message=code==='gemini_model_cooldown'?`当前 Gemini 型号正在上游冷却${Number.isSafeInteger(error.retryAfterSeconds)?`，约 ${error.retryAfterSeconds} 秒后可重试`:''}；可以先选择其他可用型号。`:'服务商请求频率或额度受限，请稍后再试。';
    else if(/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|CERT_|ERR_TLS/.test(code)||/timed out|fetch failed/i.test(message)) message='无法连接服务商，请检查网络、代理和 API 地址。';
    else if(!/[\u3400-\u9fff]/.test(message)) {
      const known={deepseek_key_missing:'请先在管理页保存并验证 DeepSeek 密钥。',invalid_json:'请求内容无效。',incompatible_compacted_history:'此聊天包含无法迁移的 GPT 加密上下文，请新建聊天或带摘要继续。',local_compaction_invalid:'无法读取本地压缩上下文，请带摘要新建聊天。',incomplete_upstream_stream:'服务商连接结束但没有完成回复，本次请求不会自动重试。'};
      message=known[code] || (status===400?'请求或配置无效，请检查填写内容。':'网关请求失败，请运行连接检查，查看服务商状态。');
    }
    if(key) message=message.split(key).join('[已隐藏]');
    message=message.replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[已隐藏]').slice(0,700);
    return {code,status:status>=400&&status<600?status:502,message,...(Number.isSafeInteger(error?.retryAfterSeconds)&&error.retryAfterSeconds>0&&error.retryAfterSeconds<=604800?{retryAfterSeconds:error.retryAfterSeconds}:{})};
  }
  function recordError(error,context={}) {
    const safe=friendly(error);
    diagnostics.recentErrors.unshift({time:new Date().toISOString(),code:safe.code,message:safe.message,provider:context.provider || null,model:context.model || null});
    diagnostics.recentErrors.length=Math.min(12,diagnostics.recentErrors.length);
    log({event:'error',code:safe.code,status:safe.status,provider:context.provider || null,model:context.model || null});
    return safe;
  }
  function mergeCatalog(upstream) {
    // This adapter exposes ordinary MCP functions, not Codex's client-executed
    // tool_search protocol. Keep their schemas directly visible to the model;
    // otherwise Codex defers them behind a discovery tool we cannot forward.
    return {models:[...(upstream.models || []).filter(model=>!deepseekIds.has(model.slug)),...dsCatalog.models.map((model,index)=>({...model,supports_search_tool:false,priority:100+index,service_tiers:[],additional_speed_tiers:[],default_service_tier:null,available_access_programs:{cyber:['standard']}})),...providers.catalogModels()]};
  }
  let catalog=mergeCatalog(original);
  function writeCatalog() {
    const destination=path.join(dir,'combined-models.json'),temporary=destination+'.'+process.pid+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(catalog,null,2)); fs.renameSync(temporary,destination);
  }
  function refreshLocal() { catalog=mergeCatalog(original); writeCatalog(); }
  writeCatalog();
  function getCatalogCredentials() {
    if(options.getCatalogCredentials) return options.getCatalogCredentials();
    const codexDir=settings.codexDirectory || process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
    let auth={};try{auth=JSON.parse(fs.readFileSync(path.join(codexDir,'auth.json'),'utf8'));}catch{}
    let clientVersion=settings.clientVersion || '0.164.0';
    try { const cached=JSON.parse(fs.readFileSync(path.join(codexDir,'models_cache.json'),'utf8')); const version=String(cached.client_version || '').match(/^(\d+\.\d+\.\d+)(?:-|$)/)?.[1];if(version)clientVersion=version;}catch{}
    const headers={accept:'application/json','user-agent':'codex_cli_rs/'+clientVersion,originator:'codex_cli_rs'};
    if(auth.tokens?.access_token)headers.authorization='Bearer '+auth.tokens.access_token;
    if(auth.tokens?.account_id)headers['chatgpt-account-id']=auth.tokens.account_id;
    return {chatgptHeaders:headers,deepseekKey:key,clientVersion,accountId:auth.tokens?.account_id};
  }
  const updater=settings.catalogSyncEnabled&&!settings.stagingValidation?require('./catalog-updater.cjs').createCatalogUpdater({
    directory:dir,gptBase,deepseekBase,docsUrl:options.deepseekDocsUrl,intervalMs:settings.catalogRefreshIntervalMs || 1800000,getCredentials:getCatalogCredentials,
    initialGptCatalog:original,initialDeepseekCatalog:dsCatalog,log,
    onUpdate:next=>{if(next.gptCatalog)original=next.gptCatalog;if(next.deepseekCatalog){dsCatalog=next.deepseekCatalog;deepseekIds.clear();for(const m of dsCatalog.models)deepseekIds.add(m.slug);}refreshLocal();}
  }):null;
  let geminiUpdater=options.geminiUpdater||null;
  if(!geminiUpdater&&settings.geminiSubscription?.enabled&&!settings.stagingValidation){
    try{
      geminiUpdater=require('./gemini-updater.cjs').createGeminiUpdater({directory:dir,bridgeDirectory:settings.geminiSubscription.bridgeDirectory,intervalMs:settings.geminiSubscription.intervalMs||1800000,providers,requestUpstream,readBody,events,log,onUpdate:refreshLocal});
    }catch{
      log({event:'gemini_catalog_check_failed',code:'gemini_sync_initialization_failed'});
      geminiUpdater={status:()=>({configured:true,enabled:false,busy:false,state:'degraded',errorCode:'gemini_sync_initialization_failed',message:'Antigravity 自动更新组件未能初始化，原有模型列表保留。'}),assertRoute:()=>{throw Object.assign(new Error('Antigravity 登录组件不可用，请在管理页检查。'),{status:503,code:'gemini_sync_initialization_failed'});}};
    }
  }
  let geminiService=options.geminiService||null;
  if(!geminiService&&settings.geminiSubscription?.enabled&&!settings.stagingValidation){
    try{geminiService=require('./gemini-service.cjs').createGeminiService({directory:settings.geminiSubscription.bridgeDirectory,log});}
    catch{geminiService={ensure:async()=>{throw Object.assign(new Error('Antigravity 本机组件安装信息无效，请修复组件安装。'),{status:503,code:'gemini_service_invalid'});},status:()=>({state:'unavailable',errorCode:'gemini_service_invalid',message:'Antigravity 本机组件安装信息无效，请修复组件安装。'})};}
  }
  function routeFor(model) {
    const custom=providers.routeBySlug(model);
    if(custom){if(custom.providerId==='gemini-subscription')geminiUpdater?.assertRoute?.(custom);return {provider:'custom:'+custom.providerId,...custom};}
    if(/^custom\//i.test(String(model || '')))throw Object.assign(new Error('此自定义模型未启用或已移除，请在管理页检查服务商。'),{status:400,code:'model_not_enabled'});
    if(deepseekIds.has(model))return {provider:'deepseek',model};
    if(/^deepseek/i.test(String(model || '')))throw Object.assign(new Error('此 DeepSeek 模型尚未启用，请刷新模型列表或选择可用模型。'),{status:400,code:'model_not_enabled'});
    return {provider:'openai',model};
  }
  function allowed(req) {
    const host=req.headers.host || '';
    const form=req.method==='POST'&&req.url.startsWith(root+'/settings/');
    return req.socket.remoteAddress==='127.0.0.1'&&/^127\.0\.0\.1(?::\d+)?$/.test(host)&&(!req.headers.origin||(form&&(req.headers.origin==='http://'+host||req.headers.origin==='null')));
  }
  function note(model,transport) {
    const provider=routeFor(model).provider;
    stats[provider==='openai'?'gptRequests':provider==='deepseek'?'deepseekRequests':'customRequests']++;
    stats.lastRoute={model,route:provider,transport,time:new Date().toISOString()};
    log({event:'request',model,route:provider,transport});
  }
  const providerRunner=require('./provider-runner.cjs').createProviderRunner({providers,deepseekBase,getDeepseekKey:()=>key,secret:settings.routeToken,requestUpstream:providerTransport,readBody,events,log,beforeRequest:({target,signal})=>target.providerId==='gemini-subscription'?geminiService?.ensure({signal}):undefined,legacyCustomInstructions:dsCatalog.models.flatMap(m=>[m.base_instructions,m.model_messages?.instructions_template]).filter(x=>typeof x==='string'&&x.length>0)});
  async function validateDeepseekKey(candidate) {
    if(!/^sk-[A-Za-z0-9_-]{12,}$/.test(candidate))throw Object.assign(new Error('DeepSeek 密钥格式无效，请完整复制密钥。'),{status:400,code:'invalid_key_format'});
    if(options.validateDeepseekKey)return options.validateDeepseekKey(candidate);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try {
      const upstream=await requestUpstream(new URL(deepseekBase+'/models'),{headers:headersFor({},candidate),signal:controller.signal});
      const raw=await readBody(upstream);
      if(upstream.statusCode!==200)throw Object.assign(new Error('DeepSeek 密钥验证失败，原密钥已保留。'),{status:upstream.statusCode,code:'deepseek_key_verification_failed'});
      let data;try{data=JSON.parse(raw.toString());}catch{}
      if(!Array.isArray(data?.data)||!data.data.some(m=>typeof m.id==='string'))throw Object.assign(new Error('服务商没有返回有效模型列表，原密钥已保留。'),{status:502,code:'invalid_models_response'});
      return {ok:true};
    } finally {clearTimeout(timer);}
  }
  function currentControl() {
    let value=diagnostics.control;
    try { value=JSON.parse(fs.readFileSync(path.join(dir,'private','control-status.json'),'utf8').replace(/^\uFEFF/,'')); }catch{}
    if(!value)return null;
    if(value.state==='running'&&Date.now()-Date.parse(value.startedAt)>200000)return {...value,state:'failed',message:'上次维护未能确认完成，可以重新检查或重试。'};
    return {action:value.action,state:value.state,startedAt:value.startedAt,finishedAt:value.finishedAt,message:value.message};
  }
  function page(res,status=200,lastNotice=notice,providerDraft) {
    res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"});
    const syncStatus=updater?.status();
    return res.end(renderManagement({root,csrf:controlCsrf.key,csrfToken:controlCsrf.key,refreshCsrfToken:controlCsrf.refresh,hasKey:!!key,keyConfigured:!!key,stats,catalog,autoCatalog:updater?{...syncStatus,csrf:controlCsrf.refresh,models:catalog.models}:null,syncStatus,geminiSync:geminiUpdater?.status(),geminiService:geminiService?.status(),validation,diagnostics:{...diagnostics,control:currentControl()},lastNotice,providers:providers.listProviders(),controlCsrf,providerDraft}));
  }
  function redirect(res,message,type='success') { notice={type,message};res.writeHead(303,{location:root+'/', 'cache-control':'no-store'});res.end(); }
  async function diagnose() {
    const checks=[{name:'本地网关',ok:true,message:'服务正在运行，管理地址仅本机可访问。'}];
    const creds=await getCatalogCredentials();
    checks.push({name:'GPT 登录',ok:!!creds.chatgptHeaders?.authorization,message:creds.chatgptHeaders?.authorization?'已找到 Codex 登录，GPT 请求继续使用原账号。':'未找到 Codex 登录，请先在 Codex 登录。'});
    if(updater) {
      const state=await updater.refresh({force:true});
      const s=state.providerStatus || updater.status()?.providerStatus || {};
      checks.push({name:'模型自动更新',ok:!!state.gptCatalog,message:state.gptCatalog?'已刷新模型列表；新模型通过兼容性检查后会加入。':'GPT 模型列表暂时无法刷新，已保留上次可用数据。'});
      if(s.deepseek?.message)checks.push({name:'DeepSeek 模型目录',ok:!s.deepseek.error,message:s.deepseek.message});
    }
    if(key) {
      try {await validateDeepseekKey(key);validation={status:'verified',checkedAt:new Date().toISOString(),message:'密钥与模型列表访问已验证；推理和工具调用可另行试用。'};checks.push({name:'DeepSeek 密钥',ok:true,message:validation.message});}
      catch(error){const safe=recordError(error,{provider:'deepseek'});validation={status:'failed',checkedAt:new Date().toISOString(),message:safe.message};checks.push({name:'DeepSeek 密钥',ok:false,message:safe.message});}
    }else checks.push({name:'DeepSeek 密钥',ok:false,message:'尚未填写密钥。'});
    for(const provider of providers.listProviders()) {
      try {const checked=await providers.validateProvider({...provider,models:provider.models});checks.push({name:provider.name,ok:checked.ok,message:checked.message});}
      catch(error){checks.push({name:provider.name,ok:false,message:recordError(error,{provider:provider.id}).message});}
    }
    diagnostics.lastCheckedAt=new Date().toISOString();diagnostics.checks=checks;
    return checks.every(c=>c.ok);
  }
  function startControl(action) {
    if(currentControl()?.state==='running')throw Object.assign(new Error('上一项恢复或重启仍在进行，请稍后刷新管理页。'),{status:409,code:'control_in_progress'});
    diagnostics.control={action,state:'running',startedAt:new Date().toISOString(),finishedAt:null,message:action==='restore'?'正在恢复 GPT 直连。':'正在重启网关，请稍后刷新管理页。'};
    if(options.runControl) {
      Promise.resolve().then(()=>options.runControl(action)).then(()=>{diagnostics.control={...diagnostics.control,state:'succeeded',finishedAt:new Date().toISOString(),message:'操作已完成。'};},()=>{diagnostics.control={...diagnostics.control,state:'failed',finishedAt:new Date().toISOString(),message:'操作失败，请使用开始菜单中的恢复入口。'};});
      return;
    }
    const {spawn}=require('node:child_process');
    function persistControl(value) {
      const target=path.join(dir,'private','control-status.json'),temporary=target+'.'+process.pid+'.tmp';
      try{fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,target);}finally{try{fs.unlinkSync(temporary);}catch{}}
    }
    function controlFailed(message) {
      diagnostics.control={...diagnostics.control,state:'failed',finishedAt:new Date().toISOString(),message};
      try{persistControl(diagnostics.control);}catch{}
    }
    // Replace any previous operation result before launching, so double clicks
    // cannot treat an old success as this operation's result.
    persistControl(diagnostics.control);
    const windows=process.env.SystemRoot || 'C:\\Windows';
    const controlEnv={...process.env,PSModulePath:path.join(windows,'System32','WindowsPowerShell','v1.0','Modules')};
    const scheduled=settings.lifecycle?.startupMode==='scheduledTask';
    // The short dispatcher exits after Task Scheduler accepts the request.
    // The actual controller is an independent OS task and survives service exit.
    const child=scheduled
      ? spawn(path.join(windows,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'scheduler.ps1'),'-Directory',dir,'-ControlAction',action],{env:controlEnv,windowsHide:true,detached:false,stdio:'ignore'})
      : spawn(path.join(windows,'System32','wscript.exe'),['//B','//NoLogo',path.join(dir,'control-launcher.vbs'),action],{env:controlEnv,windowsHide:true,detached:true,stdio:'ignore'});
    child.on('error',()=>controlFailed('无法启动维护程序，请使用开始菜单中的恢复入口。'));
    child.on('exit',code=>{if(code!==0)controlFailed('维护任务未能启动，请使用紧急恢复 GPT 入口。');else if(!scheduled){const state=currentControl();if(!state||state.state==='running')controlFailed('维护程序没有返回完成状态，请检查连接后重试。');}});
    child.unref();
  }
  function providerInput(form) {
    const id=form.get('id')?.trim(),existing=providers.listProviders().find(p=>p.id===id);
    const modelId=form.get('modelId')?.trim();
    const models=[...(existing?.models || [])];
    if(modelId) {
      const previous=models.find(m=>m.id===modelId);
      const model={id:modelId,displayName:form.get('displayName')?.trim()||modelId,contextWindow:Number(form.get('contextWindow')),maxOutputTokens:Number(form.get('maxOutputTokens')),inputModalities:form.has('inputImage')?['text','image']:['text'],supportsTools:form.get('supportsTools')==='on'||form.get('supportsTools')==='true',reasoningEfforts:(form.get('reasoningEfforts') || 'none').split(',').map(x=>x.trim()).filter(Boolean),...(previous?.preserveOpaqueReasoning?{preserveOpaqueReasoning:true}:{})};
      const index=models.findIndex(m=>m.id===modelId);if(index<0)models.push(model);else models[index]=model;
    }
    if(!modelId&&!existing)throw Object.assign(new Error('请填写模型 ID 和该模型官方公布的能力参数。'),{status:400,code:'model_id_required'});
    return {id:id || undefined,name:form.get('name')?.trim()||existing?.name,baseUrl:form.get('baseUrl')?.trim()||existing?.baseUrl,protocol:form.get('protocol')||existing?.protocol,apiKey:form.get('apiKey')?.trim()||undefined,models,...(existing?.opaqueReasoningIdentity?{opaqueReasoningIdentity:existing.opaqueReasoningIdentity}:{}),...(existing?.autoDiscovery?{autoDiscovery:existing.autoDiscovery}:{})};
  }
  let socketRouter;
  const server=http.createServer(async(req,res)=>{
    let url,context={};
    try {
      url=new URL(req.url,'http://127.0.0.1');
      if(!allowed(req))return json(res,403,{error:{message:'Local gateway access denied'}});
      if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,service:'codex-local-model-gateway',build:'2.6.0',pid:process.pid,directory:dir,startupMode:settings.lifecycle?.startupMode||'process'});
      if(!url.pathname.startsWith(root+'/'))return json(res,404,{error:{message:'Not found'}});
      if(req.method==='GET'&&url.pathname===root+'/status')return json(res,200,{...stats,build:'2.6.0',startupMode:settings.lifecycle?.startupMode||'process',deepseekKeyConfigured:!!key,validation,diagnostics:{...diagnostics,control:currentControl()},providers:providers.listProviders(),modelSync:updater?.status()||null,geminiSync:geminiUpdater?.status()||null,geminiService:geminiService?.status()||null,models:catalog.models.filter(m=>m.visibility==='list').map(m=>({id:m.slug,name:m.display_name}))});
      if(req.method==='GET'&&url.pathname===root+'/')return page(res);
      if(req.method==='POST'&&url.pathname.startsWith(root+'/settings/')) {
        const action=url.pathname.slice((root+'/settings/').length);
        if(!actions.includes(action))return json(res,404,{error:{message:'Not found'}});
        if(Number(req.headers['content-length']||0)>128*1024)throw Object.assign(new Error('表单内容过大。'),{status:413,code:'form_too_large'});
        const form=new URLSearchParams((await readBody(req,128*1024)).toString()),tokens=form.getAll('csrf_token'),submitted=tokens[0] || '';
        if(tokens.length!==1||!/^[a-f0-9]{64}$/.test(submitted)||!timingSafeEqual(Buffer.from(submitted),Buffer.from(controlCsrf[action])))return json(res,403,{error:{message:'Form expired. Reopen the gateway management page and try again.'}});
        try {
          if(action==='key') {
            const next=form.get('key')?.trim()||'';
            await validateDeepseekKey(next);
            await (options.persistDeepseekKey?options.persistDeepseekKey(next):saveKey(dir,next));
            key=next;validation={status:'verified',checkedAt:new Date().toISOString(),message:'密钥与模型列表访问验证成功，已加密保存。'};
            log({event:'credential_updated',provider:'deepseek'});
            updater?.refresh({force:true}).catch(()=>{});
            return redirect(res,'DeepSeek 密钥已验证并加密保存。');
          }
          if(action==='refresh') {if(!updater)throw Object.assign(new Error('当前未启用自动更新。'),{status:409,code:'catalog_sync_disabled'});await updater.refresh({force:true});return redirect(res,'已完成模型目录检查；暂时失败的来源保留上次可用列表。');}
          if(action==='gemini-refresh') {
            if(!geminiUpdater?.refresh)throw Object.assign(new Error('当前未配置 Antigravity 自动更新。'),{status:409,code:'gemini_sync_disabled'});
            if(!geminiUpdater.status().enabled)throw Object.assign(new Error('Antigravity 自动更新已暂停，请先开启。'),{status:409,code:'gemini_sync_paused'});
            geminiUpdater.refresh().catch(()=>{});
            return redirect(res,'已开始检查 Antigravity 模型。新发现或能力变化的型号会用少量订阅额度验证工具调用，请稍后刷新查看结果。','info');
          }
          if(action==='gemini-toggle') {
            if(!geminiUpdater?.setEnabled)throw Object.assign(new Error('当前未配置 Antigravity 自动更新。'),{status:409,code:'gemini_sync_disabled'});
            if(form.getAll('enabled').length!==1||!['true','false'].includes(form.get('enabled')))throw Object.assign(new Error('请选择开启或暂停自动更新。'),{status:400,code:'gemini_sync_setting_invalid'});
            const enabled=form.get('enabled')==='true';await geminiUpdater.setEnabled(enabled);
            return redirect(res,enabled?'Antigravity 自动更新已开启。新型号验证会使用少量订阅额度。':'Antigravity 自动更新已暂停，当前可用模型保留。');
          }
          if(action==='diagnose') {const ok=await diagnose();return redirect(res,ok?'连接检查通过。':'连接检查完成，请查看下方需要处理的项目。',ok?'success':'warning');}
          if(action==='provider-save') {await providers.saveProvider(providerInput(form));refreshLocal();return redirect(res,'服务商与模型列表已验证并保存。可使用下方试用检查实际回复。');}
          if(action==='provider-delete') {await providers.removeProvider(form.get('id'));refreshLocal();return redirect(res,'已移除该服务商及其模型。');}
          if(action==='provider-remove-model') {await providers.removeModel(form.get('id'),form.get('modelId'));refreshLocal();return redirect(res,'已从选择列表移除该模型。');}
          if(action==='restart'||action==='restore') {
            if(action==='restore'&&form.get('confirm')!=='restore')throw Object.assign(new Error('请先勾选确认恢复 GPT 直连。'),{status:400,code:'restore_confirmation_required'});
            startControl(action);return redirect(res,action==='restore'?'已开始恢复 GPT 直连，完成后本页面将无法访问。重新打开 Codex 后生效。':'已开始重启，请稍等数秒再刷新。最终状态会在本页显示。','info');
          }
          if(action==='probe') {
            const model=form.get('model')||'',route=routeFor(model);
            if(!catalog.models.some(m=>m.slug===model))throw Object.assign(new Error('请选择已启用的模型。'),{status:400,code:'model_not_enabled'});
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
            try {
              const request={model,input:[{role:'user',content:'Reply with OK only.'}],instructions:'Reply briefly.',stream:true,store:false,reasoning:{effort:'none'},tools:[]};
              let response;
              if(route.provider!=='openai')response=await providerRunner.run({route,request,signal:controller.signal});
              else {
                const creds=await getCatalogCredentials(),payload=Buffer.from(JSON.stringify(request));
                const upstream=await requestUpstream(new URL(gptBase+'/responses'),{method:'POST',headers:{...headersFor(creds.chatgptHeaders),'content-type':'application/json','content-length':payload.length},signal:controller.signal},payload);
                if(upstream.statusCode!==200)throw Object.assign(new Error('GPT 试用失败，请检查登录。'),{status:upstream.statusCode,code:'gpt_probe_failed'});
                for await(const event of events(upstream))if(event.type==='response.completed'||event.type==='response.incomplete')response=event.response;
              }
              if(!response?.output?.some(x=>x.type==='message'&&(x.content||[]).some(p=>p.text||p.refusal)))throw Object.assign(new Error('模型未返回可见回复，接口兼容性检查未通过。'),{status:502,code:'probe_empty_response'});
              diagnostics.checks.unshift({name:model+' 实际回复',ok:true,message:'已收到实际回复；此次检查不包含工具执行。'});
              return redirect(res,'已收到模型实际回复。工具调用仍需在实际任务中验证。');
            } finally {clearTimeout(timer);}
          }
        }catch(error){
          const safe=recordError(error);
          if(action==='key')validation={status:'failed',checkedAt:new Date().toISOString(),message:safe.message+' 原密钥未更改。'};
          const draft=action==='provider-save'?Object.fromEntries(['id','name','baseUrl','protocol','modelId','displayName','contextWindow','maxOutputTokens','supportsTools','inputImage','reasoningEfforts'].map(name=>[name,form.get(name)||''])):undefined;
          return page(res,safe.status,{type:'error',message:safe.message+(action==='key'?' 原密钥未更改。':'')},draft);
        }
      }
      if(!url.pathname.startsWith(prefix+'/'))return json(res,404,{error:{message:'Not found'}});
      if(!req.headers.authorization)return json(res,401,{error:{message:'Codex sign-in is required'}});
      const endpoint=url.pathname.slice(prefix.length);
      if(endpoint==='/models'&&req.method==='GET') {
        stats.catalogRequests++;
        if(updater) {
          const next=await updater.refresh({force:true,skipDeepseek:true,chatgptHeaders:headersFor({...req.headers,'accept-encoding':'identity'}),clientVersion:url.searchParams.get('client_version')||settings.clientVersion||'0.164.0',accountId:req.headers['chatgpt-account-id']});
          if(!next.gptCatalog)return json(res,next.providerStatus?.gpt?.errorStatus||503,{error:{code:'model_catalog_unavailable',message:'无法获取该登录账号的 GPT 模型列表，请检查 Codex 登录。'}});
          return json(res,200,mergeCatalog(next.gptCatalog));
        }
        const upstream=await requestUpstream(new URL(gptBase+'/models'+url.search),{headers:headersFor({...req.headers,'accept-encoding':'identity'})});
        const raw=await readBody(upstream);
        if(upstream.statusCode!==200){res.writeHead(upstream.statusCode,{'content-type':'application/json'});return res.end(raw);}
        const data=JSON.parse(decoded(raw,upstream.headers['content-encoding']).toString());
        if(!Array.isArray(data.models))throw new Error('Invalid model catalog');
        original=data;refreshLocal();return json(res,200,catalog);
      }
      if(req.method!=='POST')return json(res,405,{error:{message:'Method not allowed'}});
      let raw=await readBody(req),body;
      try{body=raw.length?JSON.parse(decoded(raw,req.headers['content-encoding']).toString()):{};}catch{throw Object.assign(new Error('请求 JSON 无效。'),{status:400,code:'invalid_json'});}
      const route=routeFor(body.model);context={model:body.model,provider:route.provider};note(body.model||'(unspecified)','http');
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const expanded=providerRunner.expand(body);
      const historyContext={headers:req.headers,query:url.searchParams,scope:'http:'+req.socket.remotePort,provider:route.provider,historyScope:route.historyScope,preserveOpaqueReasoning:route.preserveOpaqueReasoning};
      let resolved=socketRouter.history.resolve(expanded,historyContext);
      if(route.provider==='openai'&&resolved.entry&&resolved.entry.provider!=='openai')resolved=socketRouter.history.resolve(expanded,{...historyContext,forceReplay:true,requireReadable:true});
      async function remember(response) {
        const output=providerRunner.expand({...resolved.request,input:response.output||[]}).input;
        socketRouter.history.remember(resolved.request,{...response,output},{...historyContext,resolved:(endpoint==='/responses/compact'||isCompactionRequest(resolved.request))?{...resolved,input:[]}:resolved});
      }
      if(route.provider!=='openai') {
        if(!['/responses','/responses/compact'].includes(endpoint))return json(res,400,{error:{code:'unsupported_provider_endpoint',message:'此服务商不支持该接口。'}});
        const request=endpoint.endsWith('/compact')?{...resolved.request,compaction_trigger:true}:resolved.request;
        if(body.stream) {
          // Preserve an upstream rejection's HTTP status until actual stream
          // data arrives. An empty HTTP-200 stream hides 429/401 from Codex.
          const startStream=()=>{if(!res.headersSent){res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache',connection:'keep-alive','x-accel-buffering':'no'});res.flushHeaders();}};
          const heartbeat=setInterval(()=>{if(!res.destroyed&&res.headersSent)res.write(': keep-alive\n\n');},15000);
          try{
            let remembered=false;
            const response=await providerRunner.run({route,request,historyScope:resolved.opaqueReasoningScope,signal:controller.signal,emit:async event=>{
              if(res.destroyed)return;
              startStream();
              if(event.response?.id)context.responseId=event.response.id;
              if(Number.isSafeInteger(event.sequence_number))context.sequenceNumber=event.sequence_number;
              // The client can submit tool results as soon as it sees the
              // terminal event, before the upstream closes its SSE connection.
              if(!remembered&&(event.type==='response.completed'||event.type==='response.incomplete')) {await remember(event.response);remembered=true;}
              if(!res.destroyed)res.write('event: '+event.type+'\ndata: '+JSON.stringify(body.stream_id?{...event,stream_id:body.stream_id}:event)+'\n\n');
            }});
            if(!remembered)await remember(response);
          }finally{clearInterval(heartbeat);}
          return res.end();
        }
        const response=await providerRunner.run({route,request,historyScope:resolved.opaqueReasoningScope,signal:controller.signal});await remember(response);return json(res,200,response);
      }
      if(!['/responses','/responses/compact','/responses/count_tokens'].includes(endpoint))return json(res,404,{error:{message:'Unknown model endpoint'}});
      const forwardHeaders=headersFor(req.headers);
      if(JSON.stringify(resolved.request)!==JSON.stringify(body)){raw=Buffer.from(JSON.stringify(resolved.request));delete forwardHeaders['content-encoding'];forwardHeaders['content-length']=raw.length;}
      const upstream=await requestUpstream(new URL(gptBase+endpoint+url.search),{method:req.method,headers:forwardHeaders,signal:controller.signal},raw);
      // Observe only; GPT bytes and response headers remain unchanged on the wire.
      if(endpoint==='/responses'&&upstream.statusCode===200) {
        const encoding=String(upstream.headers['content-encoding'] || '').toLowerCase();
        const isSse=String(upstream.headers['content-type'] || '').includes('text/event-stream');
        const buffered=!!encoding&&encoding!=='identity'||!isSse;
        const decoder=new StringDecoder('utf8');let pending='',disabled=false,total=0;const chunks=[];
        function observe(text) {
          pending+=text;
          if(pending.length>32*1024*1024){disabled=true;pending='';return;}
          let match;
          while((match=/\r?\n\r?\n/.exec(pending))) {
            const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
            try {const data=block.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');const event=JSON.parse(data);if(['response.completed','response.incomplete'].includes(event.type))remember(event.response).catch(()=>{});}catch{}
          }
        }
        upstream.on('data',chunk=>{
          if(disabled)return;
          if(!buffered)return observe(decoder.write(chunk));
          total+=chunk.length;if(total>32*1024*1024){disabled=true;chunks.length=0;return;}chunks.push(chunk);
        });
        upstream.on('end',()=>{
          if(disabled)return;
          try {
            if(!buffered)return observe(decoder.end()+'\n\n');
            const rawBody=decoded(Buffer.concat(chunks),encoding);
            if(rawBody.length>32*1024*1024)return;
            if(isSse)observe(rawBody.toString('utf8')+'\n\n');
            else {const response=JSON.parse(rawBody.toString('utf8'));if(response.id&&Array.isArray(response.output)&&['completed','incomplete'].includes(response.status))remember(response).catch(()=>{});}
          }catch{}
        });
      }
      res.writeHead(upstream.statusCode,headersFor(upstream.headers));upstream.on('error',()=>res.destroy());upstream.pipe(res);
    }catch(error){
      if(res.destroyed||error.name==='AbortError')return;
      const safe=recordError(error,context),payload={error:{type:'gateway_error',code:safe.code,message:safe.message}};
      if(safe.retryAfterSeconds){payload.error.retry_after_seconds=safe.retryAfterSeconds;if(!res.headersSent)res.setHeader('retry-after',String(safe.retryAfterSeconds));}
      if(!res.headersSent)return json(res,safe.status,payload);
      res.end('event: response.failed\ndata: '+JSON.stringify({type:'response.failed',sequence_number:(context.sequenceNumber??-1)+1,response:{id:context.responseId||'resp_gateway_failed_'+require('node:crypto').randomUUID(),object:'response',status:'failed',output:[],error:payload.error}})+'\n\n');
    }
  });
  socketRouter=attachSocketRouter({server,WebSocket,WebSocketServer,prefix,allowed,routeFor,gptBase,historySecret:settings.routeToken,
    headersFor:(route,incoming)=>route.provider==='openai'?headersFor(incoming):route.provider==='deepseek'?headersFor({},key):providers.upstreamForSlug(route.slug).headers,
    expandInput:request=>providerRunner.expand(request),runProvider:providerRunner.run,note,recordError});
  server.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  server.on('listening',()=>{updater?.start().catch(()=>log({event:'catalog_refresh_failed',code:'catalog_refresh_failed'}));Promise.resolve().then(()=>geminiService?.start?.()).catch(()=>log({event:'gemini_service_state',state:'unavailable',code:'gemini_service_unavailable'})).then(()=>geminiUpdater?.start?.()).catch(()=>log({event:'gemini_catalog_check_failed',code:'gemini_sync_failed'}));});
  server.on('close',()=>{updater?.close();geminiUpdater?.close?.();geminiService?.close?.();});
  return {server,stats,catalog:()=>catalog,prefix,updater,geminiUpdater,geminiService,providers,diagnostics,socketRouter};
}
if (require.main === module) {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname,'private','settings.json'),'utf8'));
  const gateway = createGateway(settings);
  gateway.server.listen(settings.port,'127.0.0.1',()=>{
    fs.writeFileSync(path.join(__dirname,'private','gateway.pid'),String(process.pid));
    fs.appendFileSync(path.join(__dirname,'gateway.log'),JSON.stringify({time:new Date().toISOString(),event:'started',port:settings.port})+'\n');
  });
  gateway.server.on('error',error=>{ fs.appendFileSync(path.join(__dirname,'gateway.log'),JSON.stringify({time:new Date().toISOString(),event:'server_error',code:error.code})+'\n'); process.exit(1); });
}
module.exports = {createGateway,headersFor,decoded,events};
