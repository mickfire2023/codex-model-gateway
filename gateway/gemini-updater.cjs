'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {createProviderRunner}=require('./provider-runner.cjs');
const {createHistoryStore}=require('./socket-router.cjs');
const {isGeminiReasoningCarrier,decodeAntigravityClaudeReasoningCarrier}=require('./deepseek-adapter.cjs');

const PROVIDER='gemini-subscription';
const ADAPTER='gemini-signed-responses-v1';
const ID=/^(?:gemini|claude)-[A-Za-z0-9._/-]{1,190}$/;
const GEMINI_EFFORTS=new Set(['minimal','low','medium','high']);
const CLAUDE_BUDGET_MODELS=new Set(['claude-sonnet-5-5-high','claude-opus-5-5-high']);
const clone=value=>structuredClone(value);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,status=503)=>Object.assign(new Error(code),{code,status});
const stamp=now=>new Date(now()).toISOString();
function fingerprint(model){return hash([ADAPTER,model.id,model.contextWindow,model.maxOutputTokens,model.inputModalities,model.reasoningEfforts,model.defaultReasoningEffort,model.supportsTools,model.preserveOpaqueReasoning]);}
// Selectable effort metadata does not change the signed tool transport already validated.
function protocolFingerprint(model){return hash([ADAPTER,model.id,model.contextWindow,model.maxOutputTokens,model.inputModalities,model.supportsTools,model.preserveOpaqueReasoning]);}
function abortable(action,signal){
  if(signal?.aborted)return Promise.reject(fail('gemini_sync_cancelled'));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const done=(callback,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);callback(value);};
    const cancel=()=>done(reject,fail('gemini_sync_cancelled'));
    signal?.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(action).then(value=>done(resolve,value),error=>done(reject,error));
  });
}
function displayName(id){return id.replace(/-high$/,'').replace(/(claude-(?:sonnet|opus))-(\d+)-(\d+)/,'$1-$2.$3').split('-').map((part,index)=>index===0?(part==='claude'?'Claude':'Gemini'):['flash','lite','pro','argon','sonnet','opus'].includes(part)?part[0].toUpperCase()+part.slice(1):part).join(' ');}
function reasoningCapabilities(id,detail){
  const fallback=/-high$/.test(id)?'high':'none';
  // Native Antigravity exposes these Claude models with low/medium/high. The
  // pinned transport maps them to 1024/8192/24576 tokens, so require a declared
  // budget range that can represent every choice before publishing the menu.
  const thinking=detail?.thinking;
  if(CLAUDE_BUDGET_MODELS.has(id)&&Number.isSafeInteger(thinking?.min)&&thinking.min>=0&&thinking.min<=1024&&Number.isSafeInteger(thinking?.max)&&thinking.max>=24576&&thinking.max<=100000000){
    return {reasoningEfforts:['low','medium','high'],defaultReasoningEffort:'medium'};
  }
  // Unknown Claude models keep one conservative option until independently verified.
  if(!id.startsWith('gemini-'))return {reasoningEfforts:[fallback],defaultReasoningEffort:fallback};
  const levels=detail?.thinking?.levels;
  if(!Array.isArray(levels)||!levels.length||levels.length>GEMINI_EFFORTS.size||levels.some(level=>!GEMINI_EFFORTS.has(level))||new Set(levels).size!==levels.length)return {reasoningEfforts:[fallback],defaultReasoningEffort:fallback};
  const reasoningEfforts=['minimal','low','medium','high'].filter(level=>levels.includes(level));
  const preferred=/-high$/.test(id)?'high':'medium';
  return {reasoningEfforts,defaultReasoningEffort:reasoningEfforts.includes(preferred)?preferred:reasoningEfforts.includes(fallback)?fallback:reasoningEfforts[0]};
}
function account(root){
  try{
    const names=fs.readdirSync(path.join(root,'private','auth')).filter(name=>name.endsWith('.json'));
    if(names.length!==1)throw fail('gemini_single_account_required');
    const value=JSON.parse(fs.readFileSync(path.join(root,'private','auth',names[0]),'utf8'));
    if(value.type!=='antigravity'||typeof value.email!=='string'||!value.email||value.disabled===true)throw fail('gemini_account_unavailable');
    return {identity:hash(['antigravity',value.email.toLowerCase(),value.project_id||'']),name:names[0]};
  }catch(error){throw fail(/^gemini_/.test(error.code||'')?error.code:'gemini_account_unavailable');}
}
function readJSON(url,{headers,signal,maxBytes=2*1024*1024,timeoutMs=20000}={}){
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw fail('gemini_local_endpoint_invalid');
  return new Promise((resolve,reject)=>{
    const req=http.get(url,{headers,signal},res=>{
      if(res.statusCode!==200){res.resume();return reject(fail('gemini_catalog_http_error',res.statusCode));}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)res.destroy(fail('gemini_catalog_too_large'));else chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(fail('gemini_catalog_invalid_json'));}});
    });
    req.setTimeout(timeoutMs,()=>req.destroy(fail('gemini_catalog_timeout')));
    req.on('error',error=>reject(error.code?.startsWith('gemini_')?error:fail(signal?.aborted?'gemini_sync_cancelled':'gemini_catalog_unavailable')));
  });
}
async function readCatalogs(root,target,{signal,requestJSON=readJSON}={}){
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));
  if(metadata.product!=='CodexGeminiBridge'||!Number.isSafeInteger(metadata.port)||metadata.port<1024||metadata.port>65535||target.baseUrl!==`http://127.0.0.1:${metadata.port}/v1`)throw fail('gemini_local_endpoint_changed');
  const current=account(root);
  if(current.identity!==target.accountIdentity)throw fail('gemini_account_changed');
  const control=JSON.parse(fs.readFileSync(path.join(root,'private','control.json'),'utf8'));
  if(!/^[a-f0-9]{64}$/.test(control.managementKey||''))throw fail('gemini_local_control_invalid');
  const base=`http://127.0.0.1:${metadata.port}`;
  const [available,native,registered,definitions]=await Promise.all([
    requestJSON(new URL(base+'/v1/models'),{headers:target.headers,signal}),
    requestJSON(new URL(base+'/v1beta/models'),{headers:target.headers,signal}),
    requestJSON(new URL(base+'/v8/management/credentials/models?name='+encodeURIComponent(current.name)),{headers:{authorization:'Bearer '+control.managementKey},signal}),
    requestJSON(new URL(base+'/v8/management/routing/model-definitions/antigravity'),{headers:{authorization:'Bearer '+control.managementKey},signal})
  ]);
  return {available,native,registered,definitions};
}
function discoverModels({available,native,registered,definitions}){
  if(!Array.isArray(available?.data)||!Array.isArray(native?.models)||!Array.isArray(registered?.models)||!available.data.length||!registered.models.length)throw fail('gemini_catalog_empty_or_invalid');
  if([available.data,native.models,registered.models].some(rows=>rows.length>10000))throw fail('gemini_catalog_too_large');
  const metadata=new Map();
  if(definitions!==undefined){
    if(definitions?.channel!=='antigravity'||!Array.isArray(definitions.models)||definitions.models.length>10000)throw fail('gemini_catalog_invalid_definitions');
    for(const row of definitions.models){
      if(!row||typeof row.id!=='string'||row.id.length>200||/[\x00-\x1f]/.test(row.id)||metadata.has(row.id))throw fail('gemini_catalog_invalid_definitions');
      metadata.set(row.id,row);
    }
  }
  const ids=new Set();
  for(const row of registered.models){
    if(!row||typeof row.id!=='string'||row.id.length>200||/[\x00-\x1f]/.test(row.id)||ids.has(row.id))throw fail('gemini_catalog_invalid_registry');
    ids.add(row.id);
  }
  const candidates=[],pending=[];const seen=new Set();
  for(const row of available.data){
    if(!ID.test(row?.id||''))continue;
    if(seen.has(row.id)||row.owned_by!=='antigravity')throw fail('gemini_catalog_invalid_models');
    seen.add(row.id);
    // Static/public definitions never confer entitlement on this signed-in account.
    if(!ids.has(row.id))continue;
    const matches=native.models.filter(model=>typeof model?.name==='string'&&model.name.replace(/^models\//,'')===row.id);
    if(matches.length!==1){pending.push({id:row.id,reason:'模型能力资料尚未确认'});continue;}
    const detail=matches[0];
    if(!Array.isArray(detail.supportedInputModalities)||!detail.supportedInputModalities.includes('text')||!Array.isArray(detail.supportedOutputModalities)||detail.supportedOutputModalities.length!==1||detail.supportedOutputModalities[0]!=='text'){
      pending.push({id:row.id,reason:'图像或其他输出模型暂不加入编程模型列表'});continue;
    }
    if(![detail.inputTokenLimit,detail.outputTokenLimit].every(value=>Number.isSafeInteger(value)&&value>0&&value<=100000000)){
      pending.push({id:row.id,reason:'上下文或输出上限资料缺失'});continue;
    }
    candidates.push({id:row.id,displayName:displayName(row.id),contextWindow:detail.inputTokenLimit,maxOutputTokens:Math.min(detail.outputTokenLimit,detail.inputTokenLimit,65536),inputModalities:detail.supportedInputModalities.includes('image')?['text','image']:['text'],supportsTools:true,...reasoningCapabilities(row.id,metadata.get(row.id)),preserveOpaqueReasoning:true});
  }
  // Quota cooldown can hide an available model; registry membership remains authoritative for retirement.
  for(const id of ids)if(ID.test(id)&&!seen.has(id))pending.push({id,reason:'上游暂未开放调用，稍后自动检查'});
  return {candidates,pending,registeredIds:ids};
}

function createToolProbe({requestUpstream,readBody,events}){
  return async({model,target,accountIdentity,signal})=>{
    const port=/^http:\/\/127\.0\.0\.1:(\d+)\/v1$/.exec(target?.baseUrl||'')?.[1];
    if(!port||Number(port)<1||Number(port)>65535)throw fail('gemini_probe_endpoint_invalid');
    const slug=`custom/${PROVIDER}/${encodeURIComponent(model.id)}`;
    const scope=hash([ADAPTER,accountIdentity,model.id,fingerprint(model)]);
    const candidate={...target,model,modelId:model.id,url:new URL(target.baseUrl+'/responses'),preserveOpaqueReasoning:true,historyScope:scope,...(/^claude-/.test(model.id)?{opaqueReasoningFormat:'antigravity-claude-responses-v1'}:{})};
    // The credentials are deliberately non-enumerable on the production target.
    Object.defineProperty(candidate,'headers',{value:target.headers});
    const runner=createProviderRunner({providers:{upstreamForSlug:id=>{if(id!==slug)throw fail('gemini_probe_model_mismatch');return candidate;}},deepseekBase:'',getDeepseekKey:()=>'',secret:crypto.randomBytes(32).toString('hex'),requestUpstream,readBody,events});
    const history=createHistoryStore({historyMaxEntries:4,historyMaxBytes:2*1024*1024});
    const context={namespace:'probe:'+crypto.randomUUID(),provider:'custom:'+PROVIDER,preserveOpaqueReasoning:true,historyScope:scope};
    const tools=[{type:'custom',name:'apply_patch',namespace:'transport_check',description:'A non-executing protocol check that returns a marker; it does not modify any file.'}];
    const firstRequest={model:slug,input:'Call transport_check.apply_patch once with input exactly "*** Begin Patch\\n*** End Patch". This is a non-executing transport check. Do not answer in text yet.',tools,tool_choice:{type:'custom',name:'apply_patch',namespace:'transport_check'},max_output_tokens:4096,reasoning:{effort:model.defaultReasoningEffort}};
    const firstResolved=history.resolve(firstRequest,context);
    const first=await runner.run({route:{provider:'custom:'+PROVIDER},request:firstResolved.request,historyScope:firstResolved.opaqueReasoningScope,signal});
    const calls=first.output?.filter(item=>item.type==='custom_tool_call')||[];
    if(first.status!=='completed'||calls.length!==1||calls[0].name!=='apply_patch'||calls[0].namespace!=='transport_check'||typeof calls[0].input!=='string')throw fail('gemini_probe_tool_incompatible',400);
    const reasoning=(first.output||[]).filter(item=>item.type==='reasoning'),claude=/^claude-/.test(model.id);
    // Adaptive Claude can legitimately skip thinking for a forced tool call.
    // Once it emits thinking, every issued block must carry its signed text.
    if(claude?reasoning.some(item=>decodeAntigravityClaudeReasoningCarrier(item)===undefined):!reasoning.some(isGeminiReasoningCarrier))throw fail('gemini_probe_signature_missing',400);
    const signatureCarrier=reasoning.some(isGeminiReasoningCarrier);
    history.remember(firstResolved.request,first,{...context,resolved:firstResolved});
    const marker='gemini-auto-'+crypto.randomBytes(8).toString('hex');
    const next={model:slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:calls[0].call_id,output:'Protocol passed. Marker: '+marker},{role:'user',content:'Reply with the exact marker from the tool. Do not call any tools.'}],tools,max_output_tokens:4096,reasoning:{effort:model.defaultReasoningEffort}};
    const resolved=history.resolve(next,context);
    const second=await runner.run({route:{provider:'custom:'+PROVIDER},request:resolved.request,historyScope:resolved.opaqueReasoningScope,signal});
    const text=(second.output||[]).filter(item=>item.type==='message').flatMap(item=>item.content||[]).map(part=>part.text||'').join('');
    if(second.status!=='completed'||!text.includes(marker))throw fail('gemini_probe_continuation_failed',400);
    history.clear();
    return {toolCall:true,toolResult:true,toolContinuation:true,signatureCarrier,reasoningAbsent:reasoning.length===0};
  };
}

function createGeminiUpdater(options){
  const {providers,bridgeDirectory,directory}=options;
  if(!path.isAbsolute(bridgeDirectory)||!path.isAbsolute(directory))throw fail('gemini_directory_invalid');
  const now=options.now||Date.now;
  const intervalMs=options.intervalMs??1800000;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw fail('gemini_interval_invalid');
  const stateFile=path.join(directory,'private','gemini-model-sync.json');
  const identityFor=options.readAccount||(()=>account(bridgeDirectory));
  const getCatalogs=options.readCatalogs||((target,signal)=>readCatalogs(bridgeDirectory,target,{signal}));
  const probe=options.probe||createToolProbe(options);
  let catalogSync=options.catalogSync;
  if(!catalogSync){
    try{catalogSync=require(path.join(bridgeDirectory,'model-catalog-sync.cjs')).createCatalogSync({root:bridgeDirectory});}
    catch{catalogSync={refresh:async()=>({ok:false,error:{code:'gemini_catalog_helper_unavailable'}}),status:()=>({stale:true,errorCode:'gemini_catalog_helper_unavailable'})};}
  }
  const limit=options.maxProbesPerRefresh??2;
  let data={version:1,adapter:ADAPTER,verified:{},failed:{},missing:{}};
  try{const loaded=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(loaded.version===1&&loaded.adapter===ADAPTER&&loaded.verified&&loaded.failed&&loaded.missing)data=loaded;}catch{}
  let view={configured:true,enabled:false,busy:false,state:'idle',intervalMs,lastCheckedAt:null,lastSuccessAt:null,nextCheckAt:null,pending:[],modelCount:0,message:'等待首次检查'};
  let closed=false,timer=null,active=null,controller=null;
  function persist(){
    const next={...data,view:{...view,busy:false}};
    fs.mkdirSync(path.dirname(stateFile),{recursive:true});
    const temporary=stateFile+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(next),{mode:0o600,flag:'wx'});fs.renameSync(temporary,stateFile);}finally{try{fs.unlinkSync(temporary);}catch{}}
  }
  if(data.view?.lastSuccessAt)view={...view,...data.view,busy:false,state:'idle',message:'使用上次检查结果，等待本次检查'};
  function status(){
    let snapshot;try{snapshot=providers.getDiscoverySnapshot(PROVIDER);}catch{}
    const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
    const text=(value,limit=500)=>typeof value==='string'?value.slice(0,limit):null;
    const code=value=>typeof value==='string'&&/^[a-z0-9_]{1,100}$/.test(value)?value:null;
    const result={configured:true,enabled:!!snapshot?.enabled,busy:view.busy===true,
      state:['idle','paused','checking','validating','ok','degraded'].includes(view.state)?view.state:'idle',intervalMs,
      lastCheckedAt:date(view.lastCheckedAt),lastSuccessAt:date(view.lastSuccessAt),nextCheckAt:date(view.nextCheckAt),
      pending:(Array.isArray(view.pending)?view.pending:[]).filter(item=>ID.test(item?.id||'')).slice(0,1000).map(item=>({id:item.id,reason:text(item.reason),...(date(item.nextProbeAt)?{nextProbeAt:date(item.nextProbeAt)}:{})})),
      modelCount:snapshot?.provider.models.length||0,errorCode:code(view.errorCode),message:text(view.message),probeBackoffUntil:date(data.probeBackoffUntil)};
    let raw;try{raw=catalogSync.status?.();}catch{}
    result.catalog=null;
    if(raw&&typeof raw==='object'){
      const catalog={};
      for(const field of ['enabled','hasLastGood','cached','changed','ok','stale','sourceConfigured'])if(typeof raw[field]==='boolean')catalog[field]=raw[field];
      for(const field of ['lastAttemptAt','lastSuccessAt','lastPublishedAt'])if(date(raw[field]))catalog[field]=date(raw[field]);
      if(typeof raw.source==='string'&&raw.source.length<=2048){try{const url=new URL(raw.source);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash)catalog.source=url.href;}catch{}}
      if(/^[a-f0-9]{64}$/.test(raw.catalogHash||''))catalog.catalogHash=raw.catalogHash;
      if(/^[a-f0-9]{64}$/.test(raw.configuredHash||''))catalog.configuredHash=raw.configuredHash;
      for(const field of ['modelCount','textModelCount'])if(Number.isSafeInteger(raw[field])&&raw[field]>=0)catalog[field]=raw[field];
      if(code(raw.errorCode))catalog.errorCode=code(raw.errorCode);
      if(raw.error&&code(raw.error.code))catalog.error={code:code(raw.error.code),...(Number.isInteger(raw.error.httpStatus)&&raw.error.httpStatus>=100&&raw.error.httpStatus<600?{httpStatus:raw.error.httpStatus}:{})};
      result.catalog=catalog;
    }
    return result;
  }
  function assertAccount(expected){
    const current=identityFor();
    if(current.identity!==expected)throw fail('gemini_account_changed');
    return current;
  }
  function assertRoute(route){
    if(route?.providerId!==PROVIDER)return;
    const snapshot=providers.getDiscoverySnapshot(PROVIDER);
    if(!snapshot)throw fail('gemini_provider_removed');
    assertAccount(snapshot.provider.opaqueReasoningIdentity);
  }
  function key(identity,model){return hash([identity,fingerprint(model)]);}
  async function perform(){
    let snapshot=providers.getDiscoverySnapshot(PROVIDER);
    if(closed||!snapshot?.enabled){Object.assign(view,{enabled:false,busy:false,state:'paused',message:snapshot?'Antigravity 自动更新已暂停，现有模型保留':'Antigravity 服务商已移除，自动更新已暂停'});return status();}
    Object.assign(view,{enabled:true,busy:true,state:'checking',lastCheckedAt:stamp(now),nextCheckAt:new Date(now()+intervalMs).toISOString(),pending:[],errorCode:null,message:'正在检查 Antigravity 账号与模型目录'});
    controller=new AbortController();
    const signal=controller.signal;
    try{
      const target=providers.getDiscoveryTarget(PROVIDER);
      assertAccount(target.accountIdentity);
      const catalogResult=await abortable(()=>catalogSync.refresh({signal}),signal);
      if(closed||signal.aborted)throw fail('gemini_sync_cancelled');
      if(catalogResult?.ok===false&&catalogResult.sourceConfigured!==true)throw fail('gemini_catalog_source_unconfirmed');
      const found=discoverModels(await abortable(()=>getCatalogs(target,signal),signal));
      assertAccount(target.accountIdentity);
      const excluded=new Set(snapshot.excludedModelIds);
      const managed=new Set(snapshot.managedModelIds);
      const existing=new Map(snapshot.provider.models.map(model=>[model.id,model]));
      view.pending=found.pending.filter(item=>!excluded.has(item.id));
      const upserts=[],removeIds=[];
      let tested=0;
      for(const model of found.candidates){
        if(excluded.has(model.id)||(existing.has(model.id)&&!managed.has(model.id)))continue;
        const cacheKey=key(target.accountIdentity,model);
        const prior=existing.get(model.id);
        const priorProof=prior&&data.verified[key(target.accountIdentity,prior)];
        if(prior&&managed.has(model.id)&&protocolFingerprint(prior)===protocolFingerprint(model)&&(fingerprint(prior)===fingerprint(model)||priorProof)){
          // Migrate an existing account-bound proof across effort-only metadata changes.
          // Unchanged managed models retain the initial bootstrap validation contract.
          const existingProof=data.verified[cacheKey]||priorProof;
          data.verified[cacheKey]={...existingProof,checkedAt:existingProof?.checkedAt||stamp(now),source:fingerprint(prior)===fingerprint(model)?existingProof?.source||'already_registered':'reasoning_metadata_update',protocolFingerprint:protocolFingerprint(model)};
        }
        if(!data.verified[cacheKey]){
          if(Date.parse(data.probeBackoffUntil||'')>now()){
            view.pending.push({id:model.id,reason:'订阅额度或权限受限，等待统一退避后再验证',nextProbeAt:data.probeBackoffUntil});continue;
          }
          const previous=data.failed[cacheKey];
          if(previous&&Date.parse(previous.nextProbeAt)>now()){view.pending.push({id:model.id,reason:previous.reason,nextProbeAt:previous.nextProbeAt});continue;}
          if(tested>=limit){view.pending.push({id:model.id,reason:'等待下次兼容性验证'});continue;}
          tested++;view.state='validating';view.message='正在验证新发现的 Antigravity 模型';
          const probeController=new AbortController();
          const abortProbe=()=>probeController.abort();signal.addEventListener('abort',abortProbe,{once:true});
          const timeout=setTimeout(()=>probeController.abort(),options.probeTimeoutMs??180000);
          try{
            assertAccount(target.accountIdentity);
            const proof=await abortable(()=>probe({model,target,accountIdentity:target.accountIdentity,signal:probeController.signal}),probeController.signal);
            if(probeController.signal.aborted&&!signal.aborted)throw fail('gemini_probe_timeout',504);
            assertAccount(target.accountIdentity);
            if(closed||signal.aborted)throw fail('gemini_sync_cancelled');
            const withoutReasoning=/^claude-/.test(model.id)&&proof?.signatureCarrier===false&&proof?.reasoningAbsent===true;
            data.verified[cacheKey]={checkedAt:stamp(now),source:withoutReasoning?'tool_continuation_without_reasoning':'tool_round_trip',...(typeof proof?.signatureCarrier==='boolean'?{signatureCarrier:proof.signatureCarrier}:{}),...(proof?.toolContinuation===true?{toolContinuation:true}:{}),...(withoutReasoning?{reasoningAbsent:true}:{})};delete data.failed[cacheKey];
          }catch(error){
            if(closed||signal.aborted||error.code==='gemini_account_changed')throw error;
            const probeError=probeController.signal.aborted?fail('gemini_probe_timeout',504):error;
            const reason=probeError.status===429?'订阅额度或频率受限，稍后自动重试':probeError.status===401||probeError.status===403?'当前账号暂时无权调用':probeError.code==='gemini_probe_timeout'?'模型验证超时，稍后自动重试':'工具兼容性验证未通过，保留待支持状态';
            const delay=probeError.status===429||probeError.status===401||probeError.status===403?6*3600000:probeError.status>=500?3600000:24*3600000;
            const failed={reason,nextProbeAt:new Date(now()+delay).toISOString()};data.failed[cacheKey]=failed;view.pending.push({id:model.id,...failed});
            if([401,403,429].includes(probeError.status)){data.probeBackoffUntil=failed.nextProbeAt;break;}
            continue;
          }finally{clearTimeout(timeout);signal.removeEventListener('abort',abortProbe);}
        }
        upserts.push({...model,...(prior?.displayName?{displayName:prior.displayName}:{})});
      }
      for(const id of snapshot.managedModelIds){
        if(found.registeredIds.has(id)){delete data.missing[id];continue;}
        if(catalogResult?.ok===false){view.pending.push({id,reason:'上游资料暂未更新，继续保留上次可用型号'});continue;}
        const prior=data.missing[id];
        const separated=!prior||now()-Date.parse(prior.lastSeenMissingAt)>=Math.min(intervalMs,60000);
        const missing=prior||{count:0,firstMissingAt:stamp(now)};
        if(separated){missing.count++;missing.lastSeenMissingAt=stamp(now);}
        data.missing[id]=missing;
        if(missing.count>=3&&now()-Date.parse(missing.firstMissingAt)>=2*intervalMs)removeIds.push(id);
        else view.pending.push({id,reason:'账号目录暂未列出，继续保留并复核'});
      }
      if(closed||signal.aborted)throw fail('gemini_sync_cancelled');
      assertAccount(target.accountIdentity);
      const result=await providers.reconcileDiscoveredModels(PROVIDER,{expectedRevision:snapshot.revision,accountIdentity:target.accountIdentity,upserts,removeIds,observedAt:stamp(now)});
      if(result.changed)options.onUpdate?.();
      const catalogStale=catalogResult?.ok===false;
      Object.assign(view,{state:catalogStale?'degraded':'ok',lastSuccessAt:stamp(now),errorCode:catalogStale?'gemini_source_stale':null,message:catalogStale?'上游资料更新暂时失败，使用上次验证的资料与模型列表':view.pending.length?'已检查，部分型号等待验证或支持':'模型列表已检查，无需重新验证已有型号'});
      options.log?.({event:'gemini_catalog_checked',modelCount:result.provider.models.length,pendingCount:view.pending.length,probed:tested,changed:result.changed});
    }catch(error){
      const code=/^[a-z0-9_]{1,100}$/.test(error.code||'')?error.code:'gemini_sync_failed';
      const paused=!providers.getDiscoverySnapshot(PROVIDER)?.enabled;
      Object.assign(view,{state:paused||code==='gemini_account_changed'?'paused':'degraded',errorCode:code,message:paused?'Antigravity 自动更新已暂停，现有模型保留':code==='gemini_account_changed'?'Google 登录账号已改变，请重新验证；Antigravity 请求已阻断':'本次检查未完成，已保留上次可用模型列表'});
      options.log?.({event:'gemini_catalog_check_failed',code});
    }finally{
      view.busy=false;controller=null;
      for(const name of ['verified','failed']){const keys=Object.keys(data[name]);for(const id of keys.slice(0,Math.max(0,keys.length-512)))delete data[name][id];}
      try{persist();}catch{view.state='degraded';view.errorCode='gemini_state_persist_failed';}
    }
    return status();
  }
  function refresh(){if(closed)return Promise.resolve(status());if(active)return active;active=perform().finally(()=>{active=null;});return active;}
  function start(){if(closed||timer)return;timer=setInterval(()=>refresh().catch(()=>{}),intervalMs);timer.unref?.();return refresh();}
  function close(){closed=true;clearInterval(timer);timer=null;controller?.abort();}
  async function setEnabled(enabled){
    if(typeof enabled!=='boolean')throw fail('gemini_sync_setting_invalid',400);
    if(!enabled)controller?.abort();
    const snapshot=providers.getDiscoverySnapshot(PROVIDER);
    if(!snapshot)throw fail('gemini_provider_removed',404);
    await providers.configureAutoDiscovery(PROVIDER,{enabled,managedModelIds:snapshot.managedModelIds});
    if(enabled)refresh().catch(()=>{});else Object.assign(view,{state:'paused',message:'Antigravity 自动更新已暂停，现有模型保留'});
    return status();
  }
  return {start,refresh,status,assertRoute,close,setEnabled};
}
module.exports={createGeminiUpdater,createToolProbe,discoverModels,fingerprint,protocolFingerprint,account,readCatalogs};
