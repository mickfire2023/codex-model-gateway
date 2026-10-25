'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createProviderStore}=require('../../gateway/provider-store.cjs');

const identity='a'.repeat(64);
const model=(id,extra={})=>({id,displayName:id,contextWindow:32768,maxOutputTokens:4096,inputModalities:['text'],supportsTools:true,reasoningEfforts:['high'],defaultReasoningEffort:'high',preserveOpaqueReasoning:true,...extra});
const provider=(extra={})=>({id:'gemini-subscription',name:'Synthetic subscription',baseUrl:'http://127.0.0.1:18317/v1',protocol:'responses',opaqueReasoningIdentity:identity,apiKey:'synthetic-local-only-key',models:[model('gemini-existing'),model('gemini-manual')],...extra});
async function fixture(t){
  const parent=path.resolve(__dirname,'discovery-fixtures');fs.mkdirSync(parent,{recursive:true});
  const directory=fs.mkdtempSync(path.join(parent,'订阅发现 '));
  t.after(()=>{const actual=fs.realpathSync(directory);assert.ok(actual.startsWith(fs.realpathSync(parent)+path.sep));fs.rmSync(actual,{recursive:true});});
  const counters={requests:0,keySets:0,writes:0,failWrite:false},credentials=new Map();
  const options={directory,credentialStore:{get:ref=>credentials.get(ref)||'',set:(ref,key)=>{counters.keySets++;credentials.set(ref,key);},delete:ref=>credentials.delete(ref)},request:async()=>{counters.requests++;return {status:200,body:{data:['gemini-existing','gemini-manual','gemini-new'].map(id=>({id}))}};},writeConfig:(file,value)=>{counters.writes++;if(counters.failWrite)throw new Error('Synthetic persistence failure');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}};
  const create=()=>createProviderStore(options),store=create();await store.saveProvider(provider());
  return {directory,store,create,counters,credentials};
}
async function enable(f){return f.store.configureAutoDiscovery('gemini-subscription',{enabled:true,managedModelIds:['gemini-existing']});}
function reconcile(f,extra={}){const snapshot=f.store.getDiscoverySnapshot('gemini-subscription');return f.store.reconcileDiscoveredModels('gemini-subscription',{expectedRevision:snapshot.revision,accountIdentity:identity,upserts:[],removeIds:[],observedAt:new Date().toISOString(),...extra});}

test('discovery configuration survives reload without replacing credentials or changing existing signature scope',async t=>{
  const f=await fixture(t),slug=f.store.listProviders()[0].models[0].slug,scope=f.store.routeBySlug(slug).historyScope;
  const before={...f.counters};const enabled=await enable(f);
  assert.equal(enabled.enabled,true);assert.deepEqual(enabled.managedModelIds,['gemini-existing']);assert.deepEqual(enabled.excludedModelIds,[]);
  assert.equal(f.store.routeBySlug(slug).historyScope,scope);assert.equal(f.counters.keySets,before.keySets);assert.equal(f.counters.requests,before.requests);
  assert.deepEqual(f.create().getDiscoverySnapshot('gemini-subscription'),f.store.getDiscoverySnapshot('gemini-subscription'));
  const writes=f.counters.writes;const again=await enable(f);assert.equal(again.changed,false);assert.equal(f.counters.writes,writes);
});
test('verified reconciliation adds or updates only managed models, with no network validation or key writes',async t=>{
  const f=await fixture(t);await enable(f);const before={...f.counters};const slug=f.store.listProviders()[0].models[0].slug,scope=f.store.routeBySlug(slug).historyScope;
  const result=await reconcile(f,{upserts:[model('gemini-existing',{contextWindow:65536}),model('gemini-new'),model('gemini-manual',{contextWindow:99999})]});
  assert.equal(result.changed,true);assert.deepEqual(result.skippedModelIds,['gemini-manual']);assert.deepEqual(new Set(result.managedModelIds),new Set(['gemini-existing','gemini-new']));
  assert.equal(result.provider.models.find(m=>m.id==='gemini-existing').contextWindow,65536);assert.equal(result.provider.models.find(m=>m.id==='gemini-manual').contextWindow,32768);
  assert.equal(f.store.routeBySlug(slug).historyScope,scope);assert.equal(f.counters.keySets,before.keySets);assert.equal(f.counters.requests,before.requests);
});
test('unchanged observations do not persist, reorder models or invalidate revision',async t=>{
  const f=await fixture(t);await enable(f);const original=f.store.getDiscoverySnapshot('gemini-subscription'),before={...f.counters};
  const result=await reconcile(f,{upserts:[model('gemini-existing')]});assert.equal(result.changed,false);assert.equal(result.revision,original.revision);
  assert.deepEqual(f.store.getDiscoverySnapshot('gemini-subscription'),original);assert.equal(f.counters.writes,before.writes);assert.equal(f.counters.requests,before.requests);assert.equal(f.counters.keySets,before.keySets);
});
test('manual removal persists an exclusion and defeats both stale and freshly planned automatic resurrection',async t=>{
  const f=await fixture(t);await enable(f);const old=f.store.getDiscoverySnapshot('gemini-subscription');await f.store.removeModel('gemini-subscription','gemini-existing');
  await assert.rejects(f.store.reconcileDiscoveredModels('gemini-subscription',{expectedRevision:old.revision,accountIdentity:identity,upserts:[model('gemini-existing')]}),{code:'auto_discovery_conflict'});
  const result=await reconcile(f,{upserts:[model('gemini-existing')]});assert.equal(result.changed,false);assert.deepEqual(result.skippedModelIds,['gemini-existing']);assert.deepEqual(result.excludedModelIds,['gemini-existing']);assert.deepEqual(result.managedModelIds,[]);
  assert.ok(!result.provider.models.some(m=>m.id==='gemini-existing'));assert.deepEqual(f.create().getDiscoverySnapshot('gemini-subscription'),f.store.getDiscoverySnapshot('gemini-subscription'));
});
test('manual model edits retain discovery settings but turn the edited model into an excluded user-owned model',async t=>{
  const f=await fixture(t);await enable(f);const previous=f.store.listProviders()[0];
  await f.store.saveProvider({...previous,autoDiscovery:undefined,models:previous.models.map(m=>m.id==='gemini-existing'?{...m,displayName:'My chosen name'}:m)});
  const state=f.store.getDiscoverySnapshot('gemini-subscription');assert.equal(state.enabled,true);assert.deepEqual(state.managedModelIds,[]);assert.deepEqual(state.excludedModelIds,['gemini-existing']);
  const result=await reconcile(f,{upserts:[model('gemini-existing')]});assert.equal(result.changed,false);assert.equal(result.provider.models.find(m=>m.id==='gemini-existing').displayName,'My chosen name');
});
test('a form carrying existing discovery metadata excludes only the model actually edited',async t=>{
  const f=await fixture(t);await f.store.configureAutoDiscovery('gemini-subscription',{enabled:true,managedModelIds:['gemini-existing','gemini-manual']});
  const previous=f.store.listProviders()[0];await f.store.saveProvider({...previous,models:previous.models.map(m=>m.id==='gemini-existing'?{...m,displayName:'User edited one model'}:m)});
  const state=f.store.getDiscoverySnapshot('gemini-subscription');assert.deepEqual(state.managedModelIds,['gemini-manual']);assert.deepEqual(state.excludedModelIds,['gemini-existing']);
  const before=state.revision;await f.store.saveProvider({...state.provider,name:'Renamed provider'});const renamed=f.store.getDiscoverySnapshot('gemini-subscription');assert.notEqual(renamed.revision,before);assert.deepEqual(renamed.managedModelIds,['gemini-manual']);assert.deepEqual(renamed.excludedModelIds,['gemini-existing']);
});
test('explicitly adding an excluded model back is retained as user-owned instead of silently resuming automatic management',async t=>{
  const f=await fixture(t);await enable(f);await f.store.removeModel('gemini-subscription','gemini-existing');const previous=f.store.listProviders()[0];
  await f.store.saveProvider({...previous,autoDiscovery:undefined,models:[...previous.models,model('gemini-existing',{displayName:'User restored model'})]});
  const state=f.store.getDiscoverySnapshot('gemini-subscription');assert.deepEqual(state.excludedModelIds,[]);assert.deepEqual(state.managedModelIds,[]);
  const result=await reconcile(f,{upserts:[model('gemini-existing')]});assert.deepEqual(result.skippedModelIds,['gemini-existing']);assert.equal(result.provider.models.find(m=>m.id==='gemini-existing').displayName,'User restored model');
});
test('automatic withdrawal removes only managed IDs and never creates a user-removal exclusion',async t=>{
  const f=await fixture(t);await enable(f);const result=await reconcile(f,{removeIds:['gemini-existing','gemini-manual']});
  assert.deepEqual(result.provider.models.map(m=>m.id),['gemini-manual']);assert.deepEqual(result.managedModelIds,[]);assert.deepEqual(result.excludedModelIds,[]);
  const restored=await reconcile(f,{upserts:[model('gemini-existing')]});assert.ok(restored.provider.models.some(m=>m.id==='gemini-existing'));assert.deepEqual(restored.managedModelIds,['gemini-existing']);
});
test('an empty registered model list still permits internal catalog discovery without exposing credentials',async t=>{
  const f=await fixture(t);await f.store.configureAutoDiscovery('gemini-subscription',{enabled:true,managedModelIds:['gemini-existing','gemini-manual']});
  await reconcile(f,{removeIds:['gemini-existing','gemini-manual']});assert.deepEqual(f.store.listProviders()[0].models,[]);
  const target=f.store.getDiscoveryTarget('gemini-subscription');assert.equal(target.headers.authorization,'Bearer synthetic-local-only-key');assert.equal(target.baseUrl,'http://127.0.0.1:18317/v1');assert.equal(target.accountIdentity,identity);assert.equal(target.enabled,true);
  assert.equal(Object.keys(target).includes('headers'),false);assert.throws(()=>JSON.stringify(target),/must not be serialized/);assert.ok(!JSON.stringify(f.store.getDiscoverySnapshot('gemini-subscription')).includes('synthetic-local-only-key'));
  assert.deepEqual(f.create().listProviders()[0].models,[]);
});
test('disabled discovery, changed accounts and changed credentials cancel planned updates',async t=>{
  const f=await fixture(t);await enable(f);const old=f.store.getDiscoverySnapshot('gemini-subscription');
  await assert.rejects(reconcile(f,{accountIdentity:'b'.repeat(64),upserts:[model('gemini-new')]}),{code:'auto_discovery_identity_changed'});
  await f.store.saveProvider({...f.store.listProviders()[0],apiKey:'synthetic-new-local-key'});
  await assert.rejects(f.store.reconcileDiscoveredModels('gemini-subscription',{expectedRevision:old.revision,accountIdentity:identity,upserts:[model('gemini-new')]}),{code:'auto_discovery_conflict'});
  await f.store.configureAutoDiscovery('gemini-subscription',{enabled:false});await assert.rejects(reconcile(f,{upserts:[model('gemini-new')]}),{code:'auto_discovery_disabled'});
});
test('removing the provider leaves no discovery object to recreate, including after reload',async t=>{
  const f=await fixture(t);await enable(f);const before=f.store.getDiscoverySnapshot('gemini-subscription');await f.store.removeProvider('gemini-subscription');
  assert.equal(f.store.getDiscoverySnapshot('gemini-subscription'),null);assert.equal(f.create().getDiscoverySnapshot('gemini-subscription'),null);
  assert.throws(()=>f.store.getDiscoveryTarget('gemini-subscription'),{code:'provider_not_found'});
  await assert.rejects(f.store.reconcileDiscoveredModels('gemini-subscription',{expectedRevision:before.revision,accountIdentity:identity,upserts:[model('gemini-new')]}),{code:'provider_not_found'});
});
test('failed atomic model persistence preserves prior provider state, revision and credential',async t=>{
  const f=await fixture(t);await enable(f);const before=f.store.getDiscoverySnapshot('gemini-subscription'),keys=f.counters.keySets;
  f.counters.failWrite=true;await assert.rejects(reconcile(f,{upserts:[model('gemini-new')]}),{code:'provider_save_failed'});f.counters.failWrite=false;
  assert.deepEqual(f.store.getDiscoverySnapshot('gemini-subscription'),before);assert.deepEqual(f.create().getDiscoverySnapshot('gemini-subscription'),before);assert.equal(f.counters.keySets,keys);
});
test('queued reconciliation snapshots caller-owned model data before its transaction executes',async t=>{
  const f=await fixture(t);await enable(f);const input={expectedRevision:f.store.getDiscoverySnapshot('gemini-subscription').revision,accountIdentity:identity,upserts:[model('gemini-new')],removeIds:[]};
  const pending=f.store.reconcileDiscoveredModels('gemini-subscription',input);input.upserts[0].id='mutated-after-call';input.upserts[0].contextWindow=99999;
  const result=await pending;assert.equal(result.provider.models.find(m=>m.id==='gemini-new').contextWindow,32768);assert.ok(!result.provider.models.some(m=>m.id==='mutated-after-call'));
});
