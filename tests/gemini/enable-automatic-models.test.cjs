'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {enable}=require('../../bridge/enable-automatic-models.cjs');
const source=path.resolve(__dirname,'../../gateway/gemini-updater.cjs');
const realStoreSource=path.resolve(__dirname,'../../gateway/provider-store.cjs');
const base=path.resolve(__dirname,'enable-fixtures');fs.mkdirSync(base,{recursive:true});
const identity='a'.repeat(64);
const model=(id,extra={})=>({id,displayName:id,contextWindow:16384,maxOutputTokens:1024,inputModalities:['text'],supportsTools:true,reasoningEfforts:['high'],defaultReasoningEffort:'high',preserveOpaqueReasoning:true,...extra});
function fixture(t,{realStore=false}={}){
  const root=fs.mkdtempSync(path.join(base,'自动 更新 ')),bridge=path.join(root,'bridge'),gateway=path.join(root,'gateway'),symbol='synthetic-enable-'+crypto.randomUUID();
  fs.mkdirSync(bridge);fs.mkdirSync(path.join(gateway,'private','providers'),{recursive:true});
  const models=[model('gemini-synthetic-a'),model('gemini-synthetic-b',{preserveOpaqueReasoning:false})];
  const settings={model:'gpt-synthetic-default',nodePath:'synthetic-existing-node',plugins:{synthetic:{enabled:true}},catalogSyncEnabled:true};
  const state={account:{identity,name:'synthetic-account.json'},accountReads:0,storeCreates:0,configCalls:[],snapshot:{revision:'synthetic-before',enabled:false,managedModelIds:[],excludedModelIds:[],provider:{id:'gemini-subscription',name:'Synthetic Gemini',baseUrl:'http://127.0.0.1:8317/v1',protocol:'responses',opaqueReasoningIdentity:identity,credentialRef:'synthetic-existing-credential-reference',models}}};
  globalThis[Symbol.for(symbol)]=state;
  state.credentials=new Map([['synthetic-existing-credential-reference','synthetic-memory-only-local-key']]);state.credentialSets=0;state.credentialDeletes=0;
  fs.writeFileSync(path.join(gateway,'synthetic-state.cjs'),`module.exports=globalThis[Symbol.for(${JSON.stringify(symbol)})];`);
  fs.writeFileSync(path.join(gateway,'gemini-updater.cjs'),`const state=require('./synthetic-state.cjs');module.exports={account(){state.accountReads++;return {...state.account};},fingerprint:require(${JSON.stringify(source)}).fingerprint};`);
  const fakeStore=`const state=require('./synthetic-state.cjs'),fs=require('node:fs'),path=require('node:path');module.exports={createProviderStore(options){state.storeCreates++;return {getDiscoverySnapshot(){return state.snapshot?structuredClone(state.snapshot):null;},async configureAutoDiscovery(id,input){state.configCalls.push(structuredClone(input));if(state.onConfigure)await state.onConfigure(input);if(!state.snapshot)throw new Error('Synthetic provider disappeared');const current=state.snapshot;const previous=current.provider.autoDiscovery||{managedModelIds:[],excludedModelIds:[]};const auto={enabled:input.enabled,managedModelIds:input.managedModelIds===undefined?previous.managedModelIds:input.managedModelIds,excludedModelIds:previous.excludedModelIds};current.provider.autoDiscovery=auto;current.enabled=auto.enabled;current.managedModelIds=auto.managedModelIds;current.excludedModelIds=auto.excludedModelIds;current.revision='synthetic-configured-'+state.configCalls.length;fs.writeFileSync(path.join(options.directory,'private/providers/providers.json'),JSON.stringify({version:1,providers:[current.provider]},null,2)+'\\n');return structuredClone(current);}};}};`;
  const actualStore=`const state=require('./synthetic-state.cjs'),{createProviderStore}=require(${JSON.stringify(realStoreSource)});module.exports={createProviderStore(options){state.storeCreates++;const store=createProviderStore({...options,credentialStore:{get:ref=>state.credentials.get(ref)||'',set(ref,key){state.credentialSets++;state.credentials.set(ref,key);},delete(ref){state.credentialDeletes++;state.credentials.delete(ref);}},request:async()=>{throw new Error('Setup must not make a network request.');}});const configure=store.configureAutoDiscovery;store.configureAutoDiscovery=async(id,input)=>{state.configCalls.push(structuredClone(input));if(state.onConfigure)await state.onConfigure(input);return configure(id,input);};return store;}};`;
  fs.writeFileSync(path.join(gateway,'provider-store.cjs'),realStore?actualStore:fakeStore);
  const settingsPath=path.join(gateway,'private/settings.json'),providerPath=path.join(gateway,'private/providers/providers.json');
  fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));fs.writeFileSync(providerPath,JSON.stringify({version:1,providers:[state.snapshot.provider]},null,2)+'\n');
  const report={validatedAt:'2026-10-26T00:00:00Z',provider:structuredClone(state.snapshot.provider),models:models.map(m=>({id:m.id,toolCall:true,toolResult:true,customToolWrapper:true,signatureContinuation:true}))};
  const reportPath=path.join(bridge,'validation.json');fs.writeFileSync(reportPath,JSON.stringify(report));
  t.after(()=>{for(const name of ['provider-store.cjs','gemini-updater.cjs','synthetic-state.cjs'])delete require.cache[path.join(gateway,name)];delete globalThis[Symbol.for(symbol)];const checked=fs.realpathSync(root);assert.ok(checked.startsWith(fs.realpathSync(base)+path.sep)&&path.basename(checked).startsWith('自动 更新 '));fs.rmSync(checked,{recursive:true});});
  return {root,bridge,gateway,state,settings,settingsPath,providerPath,report,reportPath,saveReport:()=>fs.writeFileSync(reportPath,JSON.stringify(report))};
}

test('initial enable seeds only matched proven registered models and preserves credentials, default model and other settings',async t=>{
  const f=fixture(t),beforeSettings=fs.readFileSync(f.settingsPath,'utf8'),beforeProviders=fs.readFileSync(f.providerPath,'utf8');
  f.report.models.push({id:'gemini-unregistered-proof',toolCall:true,toolResult:true,customToolWrapper:true,signatureContinuation:true});f.saveReport();
  const result=await enable(f.bridge,f.gateway);
  assert.deepEqual(result,{enabled:true,intervalMinutes:30,managedModelCount:1,excludedModelCount:0});
  assert.deepEqual(f.state.configCalls,[{enabled:true,managedModelIds:['gemini-synthetic-a']}]);
  const current=JSON.parse(fs.readFileSync(f.settingsPath,'utf8'));
  assert.equal(current.model,f.settings.model);assert.deepEqual(current.plugins,f.settings.plugins);assert.equal(current.nodePath,f.settings.nodePath);assert.equal(current.catalogSyncEnabled,true);
  assert.deepEqual(current.geminiSubscription,{enabled:true,bridgeDirectory:f.bridge,intervalMs:1800000});
  assert.equal(f.state.snapshot.provider.credentialRef,'synthetic-existing-credential-reference');
  const privateProvider=JSON.parse(fs.readFileSync(f.providerPath,'utf8')).providers[0],{autoDiscovery,...unchanged}=privateProvider;
  assert.deepEqual(unchanged,JSON.parse(beforeProviders).providers[0]);assert.deepEqual(autoDiscovery,{enabled:true,managedModelIds:['gemini-synthetic-a'],excludedModelIds:[]});
  assert.equal(fs.readFileSync(path.join(f.gateway,'private/settings.before-gemini-automatic.json'),'utf8'),beforeSettings);
  assert.equal(fs.readFileSync(path.join(f.gateway,'private/providers.before-gemini-automatic.json'),'utf8'),beforeProviders);
});

test('an existing discovery policy is not reseeded and exclusions survive repeated setup without replacing original backups',async t=>{
  const f=fixture(t);const auto={enabled:false,managedModelIds:['gemini-synthetic-a'],excludedModelIds:['gemini-manually-removed']};
  f.state.snapshot.provider.autoDiscovery=auto;f.state.snapshot.managedModelIds=[...auto.managedModelIds];f.state.snapshot.excludedModelIds=[...auto.excludedModelIds];
  fs.unlinkSync(f.reportPath);
  const first=await enable(f.bridge,f.gateway);const backup=fs.readFileSync(path.join(f.gateway,'private/settings.before-gemini-automatic.json'),'utf8');
  const second=await enable(f.bridge,f.gateway);
  assert.equal(first.managedModelCount,1);assert.equal(second.excludedModelCount,1);
  assert.deepEqual(f.state.configCalls,[{enabled:true},{enabled:true}]);
  assert.deepEqual(f.state.snapshot.provider.autoDiscovery.managedModelIds,['gemini-synthetic-a']);
  assert.deepEqual(f.state.snapshot.provider.autoDiscovery.excludedModelIds,['gemini-manually-removed']);
  assert.equal(fs.readFileSync(path.join(f.gateway,'private/settings.before-gemini-automatic.json'),'utf8'),backup);
});

test('account mismatch or missing subscription provider rejects before mutation',async t=>{
  for(const missing of [false,true]){
    const f=fixture(t),before=fs.readFileSync(f.settingsPath,'utf8');
    if(missing)f.state.snapshot=null;else f.state.account.identity='b'.repeat(64);
    await assert.rejects(enable(f.bridge,f.gateway));assert.deepEqual(f.state.configCalls,[]);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),before);
    assert.equal(fs.existsSync(path.join(f.gateway,'private/settings.before-gemini-automatic.json')),false);
  }
});

test('a different configured bridge directory is left unchanged',async t=>{
  const f=fixture(t),settings={...f.settings,geminiSubscription:{enabled:false,bridgeDirectory:path.join(f.root,'other-bridge')}};
  fs.writeFileSync(f.settingsPath,JSON.stringify(settings));const before=fs.readFileSync(f.settingsPath,'utf8');
  await assert.rejects(enable(f.bridge,f.gateway),/Another subscription bridge/);assert.deepEqual(f.state.configCalls,[]);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),before);
});

test('initial proof from another account, missing passing tools, or unmatched IDs cannot seed managed models',async t=>{
  for(const kind of ['account','flags','ids']){
    const f=fixture(t),before=fs.readFileSync(f.settingsPath,'utf8');
    if(kind==='account')f.report.provider.opaqueReasoningIdentity='b'.repeat(64);
    if(kind==='flags')for(const m of f.report.models)m.signatureContinuation=false;
    if(kind==='ids')for(const m of f.report.models)m.id='gemini-proof-not-registered';
    f.saveReport();await assert.rejects(enable(f.bridge,f.gateway));assert.deepEqual(f.state.configCalls,[]);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),before);
  }
});

test('initial proof cannot certify a model whose capabilities changed after validation',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.settingsPath,'utf8');f.state.snapshot.provider.models[0].contextWindow*=2;
  await assert.rejects(enable(f.bridge,f.gateway));assert.deepEqual(f.state.configCalls,[]);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),before);
});

test('concurrent settings edits abort setup without overwriting the newer configuration',async t=>{
  const f=fixture(t),beforeProviders=fs.readFileSync(f.providerPath,'utf8');const concurrent={...f.settings,model:'gpt-synthetic-new-default',concurrentEdit:'keep this update'};const text=JSON.stringify(concurrent,null,2);
  f.state.onConfigure=async()=>{fs.writeFileSync(f.settingsPath,text);};
  await assert.rejects(enable(f.bridge,f.gateway),/settings changed during setup/);
  assert.equal(fs.readFileSync(f.settingsPath,'utf8'),text);assert.equal(JSON.parse(fs.readFileSync(f.settingsPath,'utf8')).geminiSubscription,undefined);
  assert.equal(fs.readFileSync(f.providerPath,'utf8'),beforeProviders);
});

test('a provider update made after setup writes its policy is not overwritten during settings-conflict rollback',async t=>{
  const f=fixture(t),read=fs.readFileSync;const concurrentSettings=JSON.stringify({...f.settings,concurrentEdit:'settings keep'});
  const concurrentProvider=JSON.stringify({version:1,providers:[{...f.state.snapshot.provider,name:'Synthetic concurrent provider edit'}]});
  f.state.onConfigure=async()=>{fs.writeFileSync(f.settingsPath,concurrentSettings);};
  let changed=false;
  fs.readFileSync=function(file,...args){
    if(file===f.settingsPath&&f.state.configCalls.length&&!changed){changed=true;fs.writeFileSync(f.providerPath,concurrentProvider);}
    return read.call(this,file,...args);
  };
  try{await assert.rejects(enable(f.bridge,f.gateway),/settings changed during setup/);}finally{fs.readFileSync=read;}
  assert.equal(changed,true);assert.equal(fs.readFileSync(f.providerPath,'utf8'),concurrentProvider);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),concurrentSettings);
});

test('atomic settings-save failure restores only the provider policy written by this setup',async t=>{
  const f=fixture(t),beforeSettings=fs.readFileSync(f.settingsPath,'utf8'),beforeProviders=fs.readFileSync(f.providerPath,'utf8'),rename=fs.renameSync;
  fs.renameSync=function(from,to){if(to===f.settingsPath)throw Object.assign(new Error('Synthetic settings save failure'),{code:'EACCES'});return rename.call(this,from,to);};
  try{await assert.rejects(enable(f.bridge,f.gateway),/Synthetic settings save failure/);}finally{fs.renameSync=rename;}
  assert.equal(fs.readFileSync(f.settingsPath,'utf8'),beforeSettings);assert.equal(fs.readFileSync(f.providerPath,'utf8'),beforeProviders);
  assert.deepEqual(fs.readdirSync(path.join(f.gateway,'private')).filter(name=>name.endsWith('.tmp')),[]);
});

test('relative installation paths are rejected before accessing an account or provider module',async t=>{
  const f=fixture(t);await assert.rejects(enable('relative-bridge',f.gateway),/Absolute/);await assert.rejects(enable(f.bridge,'relative-gateway'),/Absolute/);
  assert.equal(f.state.accountReads,0);assert.equal(f.state.storeCreates,0);assert.deepEqual(f.state.configCalls,[]);
});

test('real provider-store enables the nested private/providers/providers.json file without touching the memory credential',async t=>{
  const f=fixture(t,{realStore:true}),beforeProvider=fs.readFileSync(f.providerPath,'utf8'),beforeSettings=fs.readFileSync(f.settingsPath,'utf8');
  const result=await enable(f.bridge,f.gateway);assert.equal(result.managedModelCount,1);
  assert.equal(f.providerPath,path.join(f.gateway,'private','providers','providers.json'));
  assert.equal(fs.existsSync(path.join(f.gateway,'private','providers.json')),false);
  const current=JSON.parse(fs.readFileSync(f.providerPath,'utf8')).providers[0];
  assert.equal(current.credentialRef,'synthetic-existing-credential-reference');assert.deepEqual(current.autoDiscovery,{enabled:true,managedModelIds:['gemini-synthetic-a'],excludedModelIds:[]});
  assert.equal(f.state.credentials.get(current.credentialRef),'synthetic-memory-only-local-key');assert.equal(f.state.credentialSets,0);assert.equal(f.state.credentialDeletes,0);
  const settings=JSON.parse(fs.readFileSync(f.settingsPath,'utf8'));assert.equal(settings.model,f.settings.model);assert.deepEqual(settings.plugins,f.settings.plugins);
  assert.equal(fs.readFileSync(path.join(f.gateway,'private/providers.before-gemini-automatic.json'),'utf8'),beforeProvider);
  assert.equal(fs.readFileSync(path.join(f.gateway,'private/settings.before-gemini-automatic.json'),'utf8'),beforeSettings);
});

test('real provider-store preserves existing exclusions and skips initial proof reseeding',async t=>{
  const f=fixture(t,{realStore:true});
  f.state.snapshot.provider.autoDiscovery={enabled:false,managedModelIds:['gemini-synthetic-a'],excludedModelIds:['gemini-manually-removed']};
  fs.writeFileSync(f.providerPath,JSON.stringify({version:1,providers:[f.state.snapshot.provider]},null,2)+'\n');fs.unlinkSync(f.reportPath);
  const result=await enable(f.bridge,f.gateway);assert.equal(result.excludedModelCount,1);assert.deepEqual(f.state.configCalls,[{enabled:true}]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.providerPath,'utf8')).providers[0].autoDiscovery,{enabled:true,managedModelIds:['gemini-synthetic-a'],excludedModelIds:['gemini-manually-removed']});
  assert.equal(f.state.credentialSets,0);assert.equal(f.state.credentialDeletes,0);
});

test('real provider-store nested file bytes are restored when settings change during setup',async t=>{
  const f=fixture(t,{realStore:true}),beforeProvider=fs.readFileSync(f.providerPath,'utf8');
  const newer=JSON.stringify({...f.settings,model:'gpt-synthetic-concurrent',newerSettings:'keep'},null,2);
  f.state.onConfigure=async()=>{fs.writeFileSync(f.settingsPath,newer);};
  await assert.rejects(enable(f.bridge,f.gateway),/settings changed during setup/);
  assert.equal(fs.readFileSync(f.providerPath,'utf8'),beforeProvider);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),newer);
  const reloaded=require(path.join(f.gateway,'provider-store.cjs')).createProviderStore({directory:f.gateway});
  assert.equal(reloaded.getDiscoverySnapshot('gemini-subscription').provider.autoDiscovery,undefined);
  assert.equal(f.state.credentialSets,0);assert.equal(f.state.credentialDeletes,0);
});

test('real provider-store nested update rolls back on settings rename failure and leaves no temporary files',async t=>{
  const f=fixture(t,{realStore:true}),beforeSettings=fs.readFileSync(f.settingsPath,'utf8'),beforeProvider=fs.readFileSync(f.providerPath,'utf8'),rename=fs.renameSync;const targets=[];
  fs.renameSync=function(from,to){targets.push(to);if(to===f.settingsPath)throw Object.assign(new Error('Synthetic real-store settings failure'),{code:'EACCES'});return rename.call(this,from,to);};
  try{await assert.rejects(enable(f.bridge,f.gateway),/Synthetic real-store settings failure/);}finally{fs.renameSync=rename;}
  assert.ok(targets.filter(p=>p===f.providerPath).length>=2);assert.equal(fs.readFileSync(f.providerPath,'utf8'),beforeProvider);assert.equal(fs.readFileSync(f.settingsPath,'utf8'),beforeSettings);
  assert.deepEqual(fs.readdirSync(path.join(f.gateway,'private')).filter(name=>name.endsWith('.tmp')),[]);assert.deepEqual(fs.readdirSync(path.dirname(f.providerPath)).filter(name=>name.endsWith('.tmp')),[]);
  assert.equal(f.state.credentialSets,0);assert.equal(f.state.credentialDeletes,0);
});
