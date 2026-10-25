'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const {createHmac}=require('node:crypto');
const {createGateway}=require('../../gateway/gateway.cjs');

const TOKEN='synthetic_gemini_admin_route',ROOT='/'+TOKEN,PREFIX=ROOT+'/backend-api/codex';
const DS_KEY='sk-synthetic-gemini-admin-ds-key';
const GEMINI_SLUG='custom/gemini-subscription/gemini-synthetic';
const GPT_MODEL={slug:'gpt-synthetic',display_name:'Synthetic GPT',visibility:'list'};
const DS_MODEL={slug:'deepseek-synthetic',display_name:'Synthetic DeepSeek',visibility:'list',base_instructions:'Synthetic only.'};
const csrf=action=>createHmac('sha256',TOKEN).update('codex-gateway:admin:'+action+':v2').digest('hex');
function exchange(base,pathname,{method='GET',headers={},body}={}){
  const payload=body==null?undefined:Buffer.from(body);
  return new Promise((resolve,reject)=>{
    const req=http.request(new URL(pathname,base),{method,headers:{...headers,...(payload?{'content-length':payload.length}:{})}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
      res.on('end',()=>{const raw=Buffer.concat(chunks),text=raw.toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,raw,text,json});});
    });
    req.setTimeout(1500,()=>req.destroy(new Error('Synthetic local request did not settle.')));req.on('error',reject);req.end(payload);
  });
}
async function fixture(t,{inject=true,invalidConfiguration=false}={}){
  const directory=fs.mkdtempSync(path.join(__dirname,'.gemini-admin-mock-'));
  fs.writeFileSync(path.join(directory,'openai-models.json'),JSON.stringify({models:[GPT_MODEL]}));
  fs.writeFileSync(path.join(directory,'deepseek-models.json'),JSON.stringify({models:[DS_MODEL]}));
  const observed={upstream:[],refresh:0,toggles:[],start:0,close:0,asserts:0};
  const state={enabled:true,busy:false,state:'ok',unavailable:false,pending:[],errorCode:null,message:'Synthetic safe metadata',lastSuccessAt:'2026-10-26T00:00:00Z'};
  const waiters=[];
  const injected={
    status:()=>({configured:true,enabled:state.enabled,busy:state.busy,state:state.state,lastSuccessAt:state.lastSuccessAt,modelCount:1,pending:state.pending,errorCode:state.errorCode,message:state.message,catalog:{stale:false}}),
    start:async()=>{observed.start++;},
    close:()=>{observed.close++;},
    assertRoute:()=>{observed.asserts++;if(state.unavailable)throw Object.assign(new Error('Gemini 登录暂时不可用。'),{status:503,code:'gemini_account_unavailable'});},
    refresh:()=>{observed.refresh++;state.busy=true;state.state='validating';return new Promise((resolve,reject)=>waiters.push({resolve:()=>{state.busy=false;state.state='ok';resolve(injected.status());},reject:()=>{state.busy=false;state.state='degraded';state.errorCode='gemini_source_unavailable';state.message='本次检查未完成，已保留上次可用模型列表';reject(new Error('synthetic-private-error-never-public'));}}));},
    setEnabled:async enabled=>{observed.toggles.push(enabled);state.enabled=enabled;state.state=enabled?'idle':'paused';return injected.status();}
  };
  const gptResponse={id:'synthetic-gpt-response',model:GPT_MODEL.slug,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic GPT preserved'}]}]};
  const gptBytes=Buffer.from('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:gptResponse})+'\n\n');
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw);}catch{}
    observed.upstream.push({path:req.url,raw,body,headers:{...req.headers}});
    res.writeHead(200,{'content-type':'text/event-stream','x-synthetic-preserved':'yes'});
    if(req.url.startsWith('/gpt/'))return res.end(gptBytes);
    const response={...gptResponse,id:'synthetic-ds-response',model:body?.model};res.end('data: '+JSON.stringify({type:'response.completed',response})+'\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamBase='http://127.0.0.1:'+upstream.address().port;
  const store={listProviders:()=>[],catalogModels:()=>[{slug:GEMINI_SLUG,display_name:'Synthetic Gemini',visibility:'list'}],routeBySlug:slug=>slug===GEMINI_SLUG?{slug,providerId:'gemini-subscription',protocol:'responses',modelId:'gemini-synthetic'}:null};
  const gateway=createGateway({directory,routeToken:TOKEN,catalogSyncEnabled:false,stagingValidation:!invalidConfiguration,...(invalidConfiguration?{geminiSubscription:{enabled:true,bridgeDirectory:'synthetic-relative-invalid'}}:{})},{deepseekKey:DS_KEY,gptBase:upstreamBase+'/gpt',deepseekBase:upstreamBase+'/ds',providerStore:store,...(inject?{geminiUpdater:injected}:{})});
  gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');const base='http://127.0.0.1:'+gateway.server.address().port;
  const form=(action,fields=[],token=csrf(action),headers={})=>exchange(base,ROOT+'/settings/'+action,{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams([...(token==null?[]:[['csrf_token',token]]),...(Array.isArray(fields)?fields:Object.entries(fields))]).toString()});
  const inference=(model)=>exchange(base,PREFIX+'/responses',{method:'POST',headers:{authorization:'Bearer synthetic-private-gpt-auth','content-type':'application/json'},body:JSON.stringify({model,input:'Synthetic prompt',stream:false})});
  const status=async()=>(await exchange(base,ROOT+'/status')).json;
  t.after(async()=>{for(const waiter of waiters)waiter.resolve();gateway.socketRouter.close();gateway.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>gateway.server.close(r)),new Promise(r=>upstream.close(r))]);const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(__dirname)+path.sep)&&path.basename(resolved).startsWith('.gemini-admin-mock-'));fs.rmSync(resolved,{recursive:true,force:true});});
  return {gateway,base,directory,observed,state,waiters,injected,gptBytes,form,status,inference};
}

test('Gemini management actions reject missing, duplicate, wrong and cross-action CSRF and non-local origin/host',async t=>{
  const f=await fixture(t);
  for(const action of ['gemini-refresh','gemini-toggle']){
    const fields=action==='gemini-toggle'?[['enabled','true']]:[];
    for(const token of [null,'0'.repeat(64),csrf(action==='gemini-refresh'?'gemini-toggle':'gemini-refresh')])assert.equal((await f.form(action,fields,token)).status,403);
    assert.equal((await f.form(action,[...fields,['csrf_token',csrf(action)]])).status,403);
    assert.equal((await f.form(action,fields,csrf(action),{origin:'https://synthetic-external.invalid'})).status,403);
    assert.equal((await f.form(action,fields,csrf(action),{host:'localhost:'+new URL(f.base).port})).status,403);
  }
  assert.equal(f.observed.refresh,0);assert.deepEqual(f.observed.toggles,[]);
});

test('Gemini toggle accepts only one exact true or false value and preserves the existing model catalog',async t=>{
  const f=await fixture(t);const before=(await f.status()).models;
  for(const fields of [[],[['enabled','']], [['enabled','TRUE']],[['enabled','1']],[['enabled','false\0']],[['enabled','true'],['enabled','false']]])assert.equal((await f.form('gemini-toggle',fields)).status,400);
  assert.deepEqual(f.observed.toggles,[]);
  assert.equal((await f.form('gemini-toggle',{enabled:'false'})).status,303);
  assert.equal((await f.status()).geminiSync.enabled,false);assert.deepEqual((await f.status()).models,before);
  assert.equal((await f.form('gemini-toggle',{enabled:'true'})).status,303);
  assert.equal((await f.status()).geminiSync.enabled,true);assert.deepEqual(f.observed.toggles,[false,true]);
});

test('Gemini refresh runs in the background while page and safe metadata status remain available',async t=>{
  const f=await fixture(t);
  const response=await f.form('gemini-refresh');assert.equal(response.status,303);assert.equal(f.observed.refresh,1);
  assert.equal(f.waiters.length,1);assert.equal(f.state.busy,true);
  const html=await exchange(f.base,ROOT+'/');assert.equal(html.status,200);assert.match(html.text,/正在验证新型号/);
  const status=await f.status();assert.equal(status.geminiSync.busy,true);assert.equal(status.geminiSync.state,'validating');
  assert.doesNotMatch(JSON.stringify(status),/synthetic-private-gpt-auth|sk-synthetic-|synthetic-private-error-never-public/);
  f.waiters[0].resolve();await new Promise(r=>setImmediate(r));assert.equal((await f.status()).geminiSync.busy,false);
});

test('background Gemini failure keeps all models, reports stale state and leaves GPT bytes and DeepSeek credentials intact',async t=>{
  const f=await fixture(t);const before=(await f.status()).models;
  assert.equal((await f.form('gemini-refresh')).status,303);f.waiters[0].reject();await new Promise(r=>setImmediate(r));
  const status=await f.status();assert.equal(status.geminiSync.state,'degraded');assert.deepEqual(status.models,before);
  const page=await exchange(f.base,ROOT+'/');assert.match(page.text,/已保留上次可用模型列表/);assert.doesNotMatch(page.text,/synthetic-private-error-never-public/);
  const gpt=await f.inference(GPT_MODEL.slug);assert.equal(gpt.status,200);assert.deepEqual(gpt.raw,f.gptBytes);assert.equal(gpt.headers['x-synthetic-preserved'],'yes');
  assert.equal(f.observed.upstream.at(-1).headers.authorization,'Bearer synthetic-private-gpt-auth');
  const ds=await f.inference(DS_MODEL.slug);assert.equal(ds.status,200);assert.equal(f.observed.upstream.at(-1).headers.authorization,'Bearer '+DS_KEY);
  assert.equal(f.observed.asserts,0);
});

test('paused or unavailable Gemini does not block GPT or DeepSeek and no unconfigured action claims success',async t=>{
  const f=await fixture(t);assert.equal((await f.form('gemini-toggle',{enabled:'false'})).status,303);
  const pausedRefresh=await f.form('gemini-refresh');assert.equal(pausedRefresh.status,409);assert.equal(f.observed.refresh,0);
  f.state.unavailable=true;const rejected=await f.inference(GEMINI_SLUG);assert.equal(rejected.status,503);assert.equal(f.observed.asserts,1);
  assert.equal((await f.inference(GPT_MODEL.slug)).status,200);assert.equal((await f.inference(DS_MODEL.slug)).status,200);assert.equal(f.observed.asserts,1);
  const without=await fixture(t,{inject:false});assert.equal((await without.form('gemini-refresh')).status,409);assert.equal((await without.form('gemini-toggle',{enabled:'true'})).status,409);assert.equal((await without.status()).geminiSync,null);
});

test('Gemini initialization failure is isolated and optional lifecycle hooks safely start and close',async t=>{
  const broken=await fixture(t,{inject:false,invalidConfiguration:true});
  const status=await broken.status();assert.equal(status.geminiSync.state,'degraded');assert.equal(status.geminiSync.errorCode,'gemini_sync_initialization_failed');
  assert.equal((await broken.inference(GEMINI_SLUG)).status,503);assert.equal((await broken.inference(GPT_MODEL.slug)).status,200);assert.equal((await broken.inference(DS_MODEL.slug)).status,200);
  const live=await fixture(t);assert.equal(live.gateway.geminiUpdater,live.injected);assert.equal(live.observed.start,1);
  live.gateway.server.closeAllConnections();await new Promise(r=>live.gateway.server.close(r));assert.equal(live.observed.close,1);
});
