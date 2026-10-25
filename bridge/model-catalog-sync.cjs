'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const https=require('node:https');
const crypto=require('node:crypto');

const SOURCE_URL='https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json';
const DEFAULT_MAX_BYTES=8*1024*1024;
const iso=value=>new Date(value).toISOString();
const failure=(code,extra={})=>Object.assign(new Error(code),{code,...extra});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function bytes(value,maxBytes){
  if(!Buffer.isBuffer(value)&&typeof value!=='string')throw failure('invalid_response_body');
  const result=Buffer.from(value);
  if(result.length===0||result.length>maxBytes)throw failure('catalog_size_invalid');
  return result;
}
function validateCatalog(raw,{maxBytes=DEFAULT_MAX_BYTES}={}){
  const data=bytes(raw,maxBytes);let parsed;
  try{parsed=JSON.parse(data.toString('utf8'));}catch{throw failure('catalog_json_invalid');}
  if(!object(parsed)||!Array.isArray(parsed.antigravity)||!parsed.antigravity.length||parsed.antigravity.length>4096)throw failure('antigravity_catalog_empty');
  for(const [section,rows] of Object.entries(parsed)){
    if(!Array.isArray(rows))continue;
    if(rows.length>16384)throw failure('catalog_section_too_large');
    const seen=new Set();
    for(const row of rows){
      if(!object(row)||typeof row.id!=='string'||!row.id.trim()||row.id!==row.id.trim()||row.id.length>512||/[\x00-\x20\x7f]/.test(row.id)||seen.has(row.id))throw failure('catalog_model_id_invalid');
      seen.add(row.id);
      if(section!=='antigravity')continue;
      for(const key of ['context_length','max_completion_tokens'])if(row[key]!==undefined&&row[key]!==null&&(!Number.isSafeInteger(row[key])||row[key]<1||row[key]>100000000))throw failure('catalog_model_limits_invalid');
      for(const key of ['supportedInputModalities','supportedOutputModalities'])if(row[key]!==undefined&&(!Array.isArray(row[key])||row[key].length>16||row[key].some(x=>typeof x!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/i.test(x))))throw failure('catalog_model_modalities_invalid');
    }
  }
  const textModels=parsed.antigravity.filter(row=>/^gemini-/i.test(row.id)&&row.supportedInputModalities?.includes('text')&&row.supportedOutputModalities?.includes('text')&&row.supportedOutputModalities.every(x=>x==='text')&&Number.isSafeInteger(row.context_length)&&Number.isSafeInteger(row.max_completion_tokens)&&row.max_completion_tokens<=row.context_length);
  if(!textModels.length)throw failure('gemini_text_catalog_empty');
  return {data,hash:digest(data),modelCount:parsed.antigravity.length,textModelCount:textModels.length};
}
function defaultRequest(url,{method='GET',headers={},body,signal,timeoutMs=15000,maxBytes=DEFAULT_MAX_BYTES}={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url),payload=body===undefined?null:Buffer.from(body);
    const request=(target.protocol==='https:'?https:http).request(target,{method,signal,headers:{...headers,...(payload?{'content-length':payload.length}:{})}},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){clearTimeout(timer);response.destroy(failure('response_too_large'));reject(failure('response_too_large'));}else chunks.push(chunk);});
      response.once('end',()=>{clearTimeout(timer);resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)});});
      response.once('error',()=>{clearTimeout(timer);reject(failure('request_interrupted'));});
    });
    const timer=setTimeout(()=>request.destroy(failure('request_timeout')),timeoutMs);
    request.once('error',error=>{clearTimeout(timer);reject(failure(error?.name==='AbortError'?'request_aborted':error?.code==='request_timeout'?'request_timeout':'request_failed'));});
    request.end(payload);
  });
}
function atomicWrite(file,data){
  const temporary=file+'.'+process.pid+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  let descriptor;
  try{descriptor=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(descriptor,data);fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;fs.renameSync(temporary,file);}
  finally{if(descriptor!==undefined)fs.closeSync(descriptor);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function createCatalogSync({root,request=defaultRequest,now=Date.now,timeoutMs=15000,maxBytes=DEFAULT_MAX_BYTES}={}){
  if(typeof root!=='string'||!path.isAbsolute(root)||/[\x00-\x1f]/.test(root))throw new TypeError('An absolute bridge directory is required.');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>32*1024*1024)throw new TypeError('Invalid catalog byte limit.');
  const cache=path.join(root,'private','model-catalog'),stateFile=path.join(cache,'last-good.json');
  fs.mkdirSync(cache,{recursive:true,mode:0o700});
  const snapshotFile=hash=>path.join(cache,hash+'.json');
  let lastGood=null,inFlight=null;
  let current={enabled:true,source:SOURCE_URL,lastAttemptAt:null,lastSuccessAt:null,lastPublishedAt:null,catalogHash:null,configuredHash:null,sourceConfigured:false,modelCount:0,textModelCount:0,hasLastGood:false,cached:false,changed:false,ok:false,error:null};
  function loadLastGood(){
    try{
      const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      if(saved.version!==1||saved.source!==SOURCE_URL||!/^[a-f0-9]{64}$/.test(saved.hash))return;
      const checked=validateCatalog(fs.readFileSync(snapshotFile(saved.hash)),{maxBytes});
      if(checked.hash!==saved.hash)return;
      lastGood={...saved,modelCount:checked.modelCount,textModelCount:checked.textModelCount};
      current={...current,hasLastGood:true,catalogHash:saved.hash,modelCount:checked.modelCount,textModelCount:checked.textModelCount,lastSuccessAt:saved.lastSuccessAt||null,lastPublishedAt:saved.lastPublishedAt||null};
    }catch{}
  }
  loadLastGood();
  function readControl(){
    try{
      const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));
      const secret=JSON.parse(fs.readFileSync(path.join(root,'private','control.json'),'utf8'));
      if(metadata.product!=='CodexGeminiBridge'||!Number.isInteger(metadata.port)||metadata.port<1024||metadata.port>65535||!/^[a-f0-9]{64}$/.test(secret.managementKey))throw failure('bridge_control_invalid');
      return {port:metadata.port,key:secret.managementKey};
    }catch{throw failure('bridge_control_invalid');}
  }
  function isManagedSource(source){
    if(source==='')return true;
    if(typeof source!=='string'||!path.isAbsolute(source))return false;
    const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    return same(path.dirname(path.resolve(source)),path.resolve(cache))&&/^[a-f0-9]{64}\.json$/.test(path.basename(source));
  }
  async function management(control,method,endpoint,body,etag,signal){
    let response;
    try{response=await request(`http://127.0.0.1:${control.port}/v8/management/config/`+endpoint,{method,headers:{authorization:'Bearer '+control.key,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(etag?{'if-match':etag}:{})},body:body===undefined?undefined:JSON.stringify(body),signal,timeoutMs,maxBytes:65536});}
    catch{throw failure('catalog_management_unavailable');}
    if(response.status>=300&&response.status<400)throw failure('catalog_management_redirect');
    let parsed;
    try{parsed=JSON.parse(bytes(response.body,65536).toString('utf8'));}catch{throw failure('catalog_management_response_invalid');}
    if(response.status!==404&&!(response.status>=200&&response.status<300))throw failure(response.status===412?'catalog_config_conflict':'catalog_management_http_error',{httpStatus:response.status});
    const tag=Object.entries(response.headers||{}).find(([key])=>key.toLowerCase()==='etag')?.[1];
    return {status:response.status,value:parsed,etag:typeof tag==='string'&&tag.length<256&&!/[\r\n]/.test(tag)?tag:null};
  }
  async function configuredSource(control,signal){
    const port=await management(control,'GET','server/port',undefined,null,signal);
    if(port.status!==200||port.value!==control.port||!port.etag)throw failure('catalog_management_identity_invalid');
    const models=await management(control,'GET','models',undefined,null,signal);
    if(models.status===404)return {source:'',etag:port.etag};
    if(models.etag!==port.etag)throw failure('catalog_config_conflict');
    if(!object(models.value)||(models.value.catalog!==undefined&&typeof models.value.catalog!=='string'))throw failure('catalog_config_invalid');
    return {source:models.value.catalog||'',etag:models.etag};
  }
  async function applySource(control,target,signal){
    const previous=await configuredSource(control,signal);
    if(previous.source===target)return {changed:false,previous:previous.source};
    if(!isManagedSource(previous.source))throw failure('catalog_source_changed_externally');
    let mutated=false;
    try{
      await management(control,'PATCH','models/catalog',target,previous.etag,signal);mutated=true;
      const actual=await configuredSource(control,signal);
      if(actual.source!==target)throw failure('catalog_source_not_applied');
      return {changed:true,previous:previous.source};
    }catch(error){
      let rollbackAttempted=false,rolledBack=false;
      if(mutated)try{
        const actual=await configuredSource(control);
        if(actual.source===previous.source)rolledBack=true;
        else if(actual.source===target){rollbackAttempted=true;await management(control,'PATCH','models/catalog',previous.source,actual.etag);rolledBack=(await configuredSource(control)).source===previous.source;}
      }catch{}
      throw failure(error.code||'catalog_apply_failed',{rollbackAttempted,rolledBack,...(error.httpStatus?{httpStatus:error.httpStatus}:{})});
    }
  }
  async function useLastGood(signal){
    if(!lastGood)return null;
    const checked=validateCatalog(fs.readFileSync(snapshotFile(lastGood.hash)),{maxBytes});
    if(checked.hash!==lastGood.hash)throw failure('catalog_snapshot_corrupted');
    await applySource(readControl(),snapshotFile(lastGood.hash),signal);
    return lastGood.hash;
  }
  async function run({signal}={}){
    current={...current,lastAttemptAt:iso(now()),changed:false,cached:false,ok:false,error:null,sourceConfigured:false,configuredHash:null};
    let checked;
    try{
      let response;
      try{response=await request(SOURCE_URL,{method:'GET',headers:{accept:'application/json','user-agent':'CodexGeminiCatalogSync/1'},signal,timeoutMs,maxBytes});}
      catch{throw failure(signal?.aborted?'request_aborted':'catalog_fetch_failed');}
      if(response.status!==200)throw failure(response.status>=300&&response.status<400?'catalog_redirect_rejected':'catalog_http_error',{httpStatus:response.status});
      checked=validateCatalog(response.body,{maxBytes});
    }catch(error){
      let configuredHash=null;
      try{configuredHash=await useLastGood(signal);}catch{}
      current={...current,cached:!!configuredHash,sourceConfigured:!!configuredHash,configuredHash,error:{code:error.code||'catalog_fetch_failed',...(error.httpStatus?{httpStatus:error.httpStatus}:{})}};
      return structuredClone(current);
    }
    try{
      const control=readControl(),target=snapshotFile(checked.hash);
      if(fs.existsSync(target)){
        const existing=validateCatalog(fs.readFileSync(target),{maxBytes});
        if(existing.hash!==checked.hash)throw failure('catalog_snapshot_corrupted');
      }else atomicWrite(target,checked.data);
      const applied=await applySource(control,target,signal);
      const completedAt=iso(now());
      const state={version:1,source:SOURCE_URL,hash:checked.hash,modelCount:checked.modelCount,textModelCount:checked.textModelCount,lastSuccessAt:completedAt,lastPublishedAt:applied.changed?completedAt:lastGood?.lastPublishedAt||completedAt};
      try{atomicWrite(stateFile,JSON.stringify(state,null,2));}
      catch{
        if(applied.changed)try{
          const actual=await configuredSource(control);
          if(actual.source===target)await management(control,'PATCH','models/catalog',applied.previous,actual.etag);
        }catch{}
        throw failure('catalog_state_persistence_failed');
      }
      lastGood=state;
      current={...current,ok:true,hasLastGood:true,catalogHash:checked.hash,configuredHash:checked.hash,sourceConfigured:true,modelCount:checked.modelCount,textModelCount:checked.textModelCount,lastSuccessAt:completedAt,lastPublishedAt:state.lastPublishedAt,cached:false,changed:applied.changed,error:null};
    }catch(error){
      let configuredHash=null;
      try{configuredHash=await useLastGood(signal);}catch{}
      current={...current,ok:false,cached:!!configuredHash,sourceConfigured:!!configuredHash,configuredHash,error:{code:error.code||'catalog_apply_failed',...(error.httpStatus?{httpStatus:error.httpStatus}:{}),...(error.rollbackAttempted?{rollbackAttempted:true,rolledBack:!!error.rolledBack}:{})}};
    }
    return structuredClone(current);
  }
  function refresh(options){if(inFlight)return inFlight;inFlight=run(options).finally(()=>{inFlight=null;});return inFlight;}
  return {refresh,status:()=>structuredClone(current)};
}
module.exports={createCatalogSync,validateCatalog,defaultRequest,SOURCE_URL};
