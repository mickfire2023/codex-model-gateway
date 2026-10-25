'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createProviderStore}=require('../../gateway/provider-store.cjs');
const {createGeminiUpdater,discoverModels,fingerprint}=require('../../gateway/gemini-updater.cjs');
const IDENTITY='a'.repeat(64),OLD='gemini-existing-high',NEXT='gemini-next-high',OTHER='gemini-other-high',MANUAL='gemini-manual-high';
const model=(id,extra={})=>({id,displayName:id,contextWindow:32768,maxOutputTokens:4096,inputModalities:['text'],supportsTools:true,reasoningEfforts:['high'],defaultReasoningEffort:'high',preserveOpaqueReasoning:true,...extra});
function catalog(ids,{registered=ids,details={}}={}){
  return {available:{data:ids.map(id=>({id,owned_by:'antigravity'}))},native:{models:ids.map(id=>({name:'models/'+id,inputTokenLimit:32768,outputTokenLimit:4096,supportedInputModalities:['text'],supportedOutputModalities:['text'],...details[id]}))},registered:{models:registered.map(id=>({id}))}};
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const parent=path.resolve(__dirname,'updater-fixtures');fs.mkdirSync(parent,{recursive:true});const directory=fs.mkdtempSync(path.join(parent,'自动更新 '));
  const credentials=new Map(),counts={keyWrites:0,requests:0,catalog:0,probe:0,generatedRequests:0,updates:0},env={clock:Date.parse('2026-10-26T00:00:00Z'),identity:IDENTITY,raw:catalog([OLD]),catalogResult:{ok:true,sourceConfigured:true},catalogStatus:{ok:true,sourceConfigured:true},probe:null,read:null,source:null};
  const providers=createProviderStore({directory,credentialStore:{get:ref=>credentials.get(ref)||'',set:(ref,key)=>{counts.keyWrites++;credentials.set(ref,key);},delete:ref=>credentials.delete(ref)},request:async()=>{counts.requests++;return {status:200,body:{data:[OLD,NEXT,OTHER,MANUAL].map(id=>({id}))}};}});
  await providers.saveProvider({id:'gemini-subscription',name:'Synthetic Google subscription',baseUrl:'http://127.0.0.1:18317/v1',protocol:'responses',opaqueReasoningIdentity:IDENTITY,apiKey:'synthetic-local-proxy-key',models:[model(OLD),...(options.manual?[model(MANUAL)]:[])]});
  await providers.configureAutoDiscovery('gemini-subscription',{enabled:true,managedModelIds:[OLD]});
  if(options.savedView){fs.mkdirSync(path.join(directory,'private'),{recursive:true});fs.writeFileSync(path.join(directory,'private/gemini-model-sync.json'),JSON.stringify({version:1,adapter:'gemini-signed-responses-v1',verified:{},failed:{},missing:{},view:{lastSuccessAt:'2026-10-25T00:00:00Z',...options.savedView}}));}
  const settings={providers,directory,bridgeDirectory:path.join(directory,'bridge'),intervalMs:1000,probeTimeoutMs:options.probeTimeoutMs??2000,now:()=>env.clock,readAccount:()=>{if(env.identityError)throw env.identityError;return {identity:env.identity};},readCatalogs:async(target,signal)=>{counts.catalog++;if(env.read)return env.read(target,signal);if(env.catalogError)throw env.catalogError;return structuredClone(env.raw);},catalogSync:{refresh:async({signal})=>env.source?env.source(signal):structuredClone(env.catalogResult),status:()=>structuredClone(env.catalogStatus)},probe:async args=>{counts.probe++;counts.generatedRequests+=2;return env.probe?env.probe(args):{toolCall:true,toolResult:true,signatureCarrier:true};},onUpdate:()=>{counts.updates++;}};
  const updater=createGeminiUpdater(settings);
  t.after(async()=>{updater.close();await tick();const actual=fs.realpathSync(directory);assert.ok(actual.startsWith(fs.realpathSync(parent)+path.sep));fs.rmSync(actual,{recursive:true});});
  return {providers,updater,directory,env,counts,settings,advance:(ms=1000)=>{env.clock+=ms;},snapshot:()=>providers.getDiscoverySnapshot('gemini-subscription')};
}

test('new Gemini models are probed once and hot-registered without rotating existing credentials or scopes',async t=>{
  const f=await fixture(t),slug=f.snapshot().provider.models[0].slug,scope=f.providers.routeBySlug(slug).historyScope;
  f.env.raw=catalog([OLD,NEXT]);const keys=f.counts.keyWrites;const result=await f.updater.refresh();
  assert.equal(result.state,'ok');assert.deepEqual(f.snapshot().provider.models.map(m=>m.id),[OLD,NEXT]);assert.equal(f.counts.probe,1);assert.equal(f.counts.generatedRequests,2);assert.equal(f.counts.updates,1);
  assert.equal(f.counts.keyWrites,keys);assert.equal(f.providers.routeBySlug(slug).historyScope,scope);
  const revision=f.snapshot().revision;f.advance();await f.updater.refresh();await f.updater.refresh();
  assert.equal(f.counts.probe,1);assert.equal(f.counts.updates,1);assert.equal(f.snapshot().revision,revision);assert.equal(f.counts.keyWrites,keys);
});
test('manual removal persists through automatic polling and updater reload',async t=>{
  const f=await fixture(t);f.env.raw=catalog([OLD,NEXT]);await f.updater.refresh();await f.providers.removeModel('gemini-subscription',NEXT);f.advance();await f.updater.refresh();
  assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));assert.ok(f.snapshot().excludedModelIds.includes(NEXT));assert.equal(f.counts.probe,1);
  f.updater.close();const reloaded=createGeminiUpdater(f.settings);t.after(()=>reloaded.close());await reloaded.refresh();assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));assert.equal(f.counts.probe,1);
});
test('quota failure backs off all new-model probes and manual refresh cannot bypass it',async t=>{
  const f=await fixture(t);f.env.raw=catalog([OLD,NEXT,OTHER]);f.env.probe=async()=>{throw Object.assign(new Error('synthetic quota'),{status:429});};
  const first=await f.updater.refresh();assert.equal(f.counts.probe,1);assert.ok(Date.parse(first.probeBackoffUntil)>f.env.clock);
  for(let i=0;i<3;i++){f.advance();await f.updater.refresh({force:true});}assert.equal(f.counts.probe,1);assert.deepEqual(f.snapshot().provider.models.map(m=>m.id),[OLD]);
  f.advance(6*3600000);f.env.probe=null;await f.updater.refresh();assert.equal(f.counts.probe,3);assert.deepEqual(new Set(f.snapshot().provider.models.map(m=>m.id)),new Set([OLD,NEXT,OTHER]));
});
test('network, empty and malformed directories preserve all previously registered models',async t=>{
  const f=await fixture(t);const initial=f.snapshot();
  for(const raw of [null,{available:{data:[]},native:{models:[]},registered:{models:[]}},{available:{data:[{id:OLD,owned_by:'antigravity'}]},native:{models:[]},registered:{models:'invalid'}}]){
    f.env.raw=raw;const status=await f.updater.refresh();assert.equal(status.state,'degraded');assert.deepEqual(f.snapshot(),initial);
  }
  f.env.catalogError=Object.assign(new Error('synthetic private body must not leak'),{code:'ECONNREFUSED'});const status=await f.updater.refresh();assert.equal(status.state,'degraded');assert.deepEqual(f.snapshot(),initial);assert.equal(f.counts.probe,0);assert.ok(!JSON.stringify(status).includes('synthetic private body'));
});
test('unconfirmed model-source update blocks probes and retirement, while a confirmed last-good source can continue',async t=>{
  const f=await fixture(t);f.env.raw=catalog([NEXT]);f.env.catalogResult={ok:false,sourceConfigured:false};
  for(let i=0;i<4;i++){const result=await f.updater.refresh();assert.equal(result.errorCode,'gemini_catalog_source_unconfirmed');f.advance(1000);}
  assert.equal(f.counts.catalog,0);assert.equal(f.counts.probe,0);assert.deepEqual(f.snapshot().provider.models.map(m=>m.id),[OLD]);
  f.env.catalogResult={ok:false,sourceConfigured:true};const lastGood=await f.updater.refresh();assert.equal(lastGood.state,'degraded');assert.equal(f.counts.probe,1);assert.ok(f.snapshot().provider.models.some(m=>m.id===NEXT));assert.ok(f.snapshot().provider.models.some(m=>m.id===OLD));
});
test('capability changes require a fresh probe before replacing the old declaration',async t=>{
  const f=await fixture(t);await f.updater.refresh();f.env.raw=catalog([OLD],{details:{[OLD]:{inputTokenLimit:65536}}});
  f.env.probe=async()=>{throw Object.assign(new Error('synthetic tool incompatibility'),{status:400});};const failed=await f.updater.refresh();assert.equal(f.counts.probe,1);assert.equal(f.snapshot().provider.models[0].contextWindow,32768);assert.ok(failed.pending.some(p=>p.id===OLD));
  await f.updater.refresh({force:true});assert.equal(f.counts.probe,1);f.advance(24*3600000);f.env.probe=null;await f.updater.refresh();assert.equal(f.counts.probe,2);assert.equal(f.snapshot().provider.models[0].contextWindow,65536);
});
test('a concurrent manual edit invalidates the planned commit and cannot be overwritten by a successful probe',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();f.env.raw=catalog([OLD,NEXT]);f.env.probe=async()=>{entered.resolve();await release.promise;return {toolCall:true,toolResult:true,signatureCarrier:true};};
  const pending=f.updater.refresh();await entered.promise;const current=f.snapshot().provider;await f.providers.saveProvider({...current,name:'User chose this provider name'});release.resolve();const status=await pending;
  assert.equal(status.errorCode,'auto_discovery_conflict');assert.equal(f.snapshot().provider.name,'User chose this provider name');assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));
});
test('only three separated successful observations withdraw a managed model and never remove a manual model',async t=>{
  const f=await fixture(t,{manual:true});f.env.raw=catalog([NEXT]);
  await f.updater.refresh();assert.ok(f.snapshot().provider.models.some(m=>m.id===OLD));
  await f.updater.refresh();assert.ok(f.snapshot().provider.models.some(m=>m.id===OLD));
  f.advance(1000);await f.updater.refresh();assert.ok(f.snapshot().provider.models.some(m=>m.id===OLD));
  f.advance(1000);await f.updater.refresh();assert.ok(!f.snapshot().provider.models.some(m=>m.id===OLD));assert.ok(f.snapshot().provider.models.some(m=>m.id===MANUAL));assert.ok(f.snapshot().provider.models.some(m=>m.id===NEXT));
});
test('registry membership protects models hidden temporarily by quota cooldown',async t=>{
  const f=await fixture(t);f.env.raw=catalog([NEXT],{registered:[OLD,NEXT]});
  for(let i=0;i<5;i++){await f.updater.refresh();f.advance(1000);}assert.ok(f.snapshot().provider.models.some(m=>m.id===OLD));assert.ok(f.updater.status().pending.some(p=>p.id===OLD));
});
test('account changes immediately block Gemini routes alone and do not mutate registrations',async t=>{
  const f=await fixture(t);await f.updater.refresh();const before=f.snapshot();f.env.identity='b'.repeat(64);
  assert.throws(()=>f.updater.assertRoute({providerId:'gemini-subscription'}),{code:'gemini_account_changed'});assert.doesNotThrow(()=>f.updater.assertRoute({providerId:'another-provider'}));assert.doesNotThrow(()=>f.updater.assertRoute({provider:'openai'}));
  const status=await f.updater.refresh();assert.equal(status.state,'paused');assert.equal(status.errorCode,'gemini_account_changed');assert.deepEqual(f.snapshot(),before);assert.equal(f.counts.probe,0);
});
test('concurrent refresh calls share one in-flight discovery and one probe',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();f.env.raw=catalog([OLD,NEXT]);f.env.probe=async()=>{entered.resolve();await release.promise;return {toolCall:true,toolResult:true,signatureCarrier:true};};
  const first=f.updater.refresh();await entered.promise;const second=f.updater.refresh(),third=f.updater.refresh();assert.equal(first,second);assert.equal(first,third);release.resolve();await Promise.all([first,second,third]);assert.equal(f.counts.catalog,1);assert.equal(f.counts.probe,1);assert.equal(f.counts.updates,1);
});
test('pause aborts an uncooperative probe and prevents a late registration',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();f.env.raw=catalog([OLD,NEXT]);let signal;
  f.env.probe=async args=>{signal=args.signal;entered.resolve();return release.promise;};const pending=f.updater.refresh();await entered.promise;await f.updater.setEnabled(false);await pending;
  assert.equal(signal.aborted,true);assert.equal(f.snapshot().enabled,false);assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));release.resolve({toolCall:true,toolResult:true,signatureCarrier:true});await tick();assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));
});
test('close aborts an uncooperative directory operation and cannot commit after shutdown',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();let signal;
  f.env.read=async(_target,current)=>{signal=current;entered.resolve();return release.promise;};const before=f.snapshot();const pending=f.updater.refresh();await entered.promise;f.updater.close();await pending;
  assert.equal(signal.aborted,true);release.resolve(catalog([OLD,NEXT]));await tick();assert.deepEqual(f.snapshot(),before);assert.equal(f.counts.probe,0);assert.equal(f.updater.status().busy,false);
});
test('probe timeout settles even when the probe ignores cancellation and retries obey backoff',async t=>{
  const f=await fixture(t,{probeTimeoutMs:20});f.env.raw=catalog([OLD,NEXT]);f.env.probe=async()=>new Promise(()=>{});
  const begin=Date.now(),status=await f.updater.refresh();assert.ok(Date.now()-begin<1000);assert.equal(status.busy,false);assert.ok(status.pending.some(p=>p.id===NEXT&&/超时/.test(p.reason)));assert.ok(!f.snapshot().provider.models.some(m=>m.id===NEXT));
  await f.updater.refresh({force:true});assert.equal(f.counts.probe,1);f.advance(3600000);f.env.probe=null;await f.updater.refresh();assert.equal(f.counts.probe,2);assert.ok(f.snapshot().provider.models.some(m=>m.id===NEXT));
});
test('removed providers stay paused rather than being recreated',async t=>{
  const f=await fixture(t);await f.providers.removeProvider('gemini-subscription');const status=await f.updater.refresh();assert.equal(status.state,'paused');assert.equal(f.snapshot(),null);assert.equal(f.counts.catalog,0);assert.equal(f.counts.probe,0);
});
test('status whitelists loaded view, pending and helper fields and never echoes injected secrets',async t=>{
  const secret='synthetic-secret-status-must-not-leak';const f=await fixture(t,{savedView:{apiKey:secret,headers:{authorization:secret},pending:[{id:NEXT,reason:'等待验证',apiKey:secret,headers:{authorization:secret}}]}});
  f.env.catalogStatus={ok:true,source:'https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json',sourceConfigured:true,configuredHash:'b'.repeat(64),catalogHash:'c'.repeat(64),modelCount:5,apiKey:secret,headers:{authorization:secret},error:{code:'synthetic_error',body:secret}};
  const status=f.updater.status(),encoded=JSON.stringify(status);assert.ok(!encoded.includes(secret));assert.equal(status.catalog.sourceConfigured,true);assert.equal(status.catalog.configuredHash,'b'.repeat(64));assert.equal(status.pending[0].id,NEXT);assert.equal(status.apiKey,undefined);assert.equal(status.catalog.apiKey,undefined);assert.equal(status.catalog.error.body,undefined);
});
test('catalog filtering leaves image or incomplete metadata pending and rejects duplicate Gemini IDs',()=>{
  const image='gemini-image-high',missing='gemini-missing-high';const raw=catalog([OLD,image,missing],{details:{[image]:{supportedOutputModalities:['text','image']},[missing]:{inputTokenLimit:null}}});
  const found=discoverModels(raw);assert.deepEqual(found.candidates.map(m=>m.id),[OLD]);assert.deepEqual(new Set(found.pending.map(m=>m.id)),new Set([image,missing]));
  raw.available.data.push({...raw.available.data[0]});assert.throws(()=>discoverModels(raw),{code:'gemini_catalog_invalid_models'});
  assert.notEqual(fingerprint(model(OLD)),fingerprint(model(OLD,{supportsTools:false})));assert.notEqual(fingerprint(model(OLD)),fingerprint(model(OLD,{preserveOpaqueReasoning:false})));
});
