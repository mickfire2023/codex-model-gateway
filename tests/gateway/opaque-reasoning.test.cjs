'use strict';
// Synthetic OAuth proxy and credentials only. No live config or inference calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createProviderStore} = require('../../gateway/provider-store.cjs');
const {createHistoryStore} = require('../../gateway/socket-router.cjs');
const {createProviderRunner} = require('../../gateway/provider-runner.cjs');
const {createAdapter} = require('../../gateway/deepseek-adapter.cjs');

const carrier = {type:'reasoning',id:'rs_fixture',encrypted_content:'cpa-gemini-responses-carrier-v1:next:function:c3ludGhldGljLXNpZ25hdHVyZQ',summary:[]};
const user = text=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const model = (id='gemini-fixture')=>({id,displayName:id,contextWindow:32768,maxOutputTokens:400,inputModalities:['text'],supportsTools:true,reasoningEfforts:['none'],preserveOpaqueReasoning:true});
const config = extra=>({id:'subscription',name:'Synthetic subscription',baseUrl:'http://127.0.0.1:18317/v1',apiKey:'synthetic-local-proxy-key',protocol:'responses',opaqueReasoningIdentity:'a'.repeat(64),models:[model(),model('gemini-other')],...extra});
const fingerprint = input=>JSON.stringify(input);

async function fixture(t) {
  const root=path.resolve(__dirname),directory=fs.mkdtempSync(path.join(root,'opaque-fixture-'));
  t.after(()=>{const resolved=path.resolve(directory);assert.ok(resolved.startsWith(root+path.sep)&&path.basename(resolved).startsWith('opaque-fixture-'));fs.rmSync(resolved,{recursive:true,force:true});});
  const credentials=new Map();
  const credentialStore={get:ref=>credentials.get(ref)||'',set:(ref,key)=>credentials.set(ref,key),delete:ref=>credentials.delete(ref)};
  const create=()=>createProviderStore({directory,credentialStore,request:async()=>({status:200,body:{data:[{id:'gemini-fixture'},{id:'gemini-other'}]}})});
  const store=create();await store.saveProvider(config());
  const slug=store.listProviders()[0].models[0].slug;
  const route=()=>({provider:'custom:subscription',...store.routeBySlug(slug)});
  const context=overrides=>({headers:{authorization:'Bearer synthetic-codex-login','x-codex-session-id':'session-one'},lane:'a',provider:'custom:subscription',preserveOpaqueReasoning:true,historyScope:route().historyScope,...overrides});
  return {store,create,slug,route,context};
}

test('opt-in requires Responses and a verified account fingerprint and survives save/reload',async t=>{
  const f=await fixture(t),saved=f.store.listProviders()[0];
  assert.equal(saved.models[0].preserveOpaqueReasoning,true);
  assert.equal(saved.opaqueReasoningIdentity,'a'.repeat(64));
  assert.deepEqual(f.create().listProviders(),f.store.listProviders());
  assert.match(f.route().historyScope,/^[a-f0-9]{64}$/);
  await assert.rejects(f.store.saveProvider(config({protocol:'chat_completions'})),{code:'invalid_opaque_reasoning_configuration'});
  await assert.rejects(f.store.saveProvider(config({opaqueReasoningIdentity:undefined})),{code:'invalid_opaque_reasoning_configuration'});
  await assert.rejects(f.store.saveProvider(config({models:[{...model(),preserveOpaqueReasoning:'true'}]})),{code:'invalid_model_capabilities'});
  assert.equal(f.store.listProviders()[0].protocol,'responses');
});

test('provider, upstream model, credential replacement and account identity each change provenance scope',async t=>{
  const f=await fixture(t);const original=f.route().historyScope;
  assert.notEqual(f.store.routeBySlug(f.store.listProviders()[0].models[1].slug).historyScope,original);
  await f.store.saveProvider(config({apiKey:undefined,name:'Renamed'}));assert.equal(f.route().historyScope,original);
  await f.store.saveProvider(config());const refreshed=f.route().historyScope;assert.notEqual(refreshed,original);
  await f.store.saveProvider(config({apiKey:undefined,opaqueReasoningIdentity:'b'.repeat(64)}));assert.notEqual(f.route().historyScope,refreshed);
  const unchanged=f.route().historyScope;assert.equal(f.create().routeBySlug(f.slug).historyScope,unchanged);
});

test('only previously observed carriers from the same account/session/lane/model scope survive replay',async t=>{
  const f=await fixture(t),history=createHistoryStore({historySecret:'synthetic-history-secret'}),initial={model:f.slug,input:[user('start')]};
  const untrusted=history.resolve({...initial,input:[carrier,user('unobserved')]},f.context());
  assert.ok(!fingerprint(untrusted.request).includes(carrier.encrypted_content));
  history.remember(initial,{id:'fixture-one',output:[carrier]},f.context());
  const next={model:f.slug,previous_response_id:'fixture-one',input:[user('next')]};
  assert.deepEqual(history.resolve(next,f.context()).request.input[1],carrier);
  assert.ok(fingerprint(history.resolve({model:f.slug,input:[carrier,user('full replay')]},f.context()).request).includes(carrier.encrypted_content));
  for(const overrides of [{historyScope:'b'.repeat(64)},{preserveOpaqueReasoning:false},{provider:'deepseek'},{provider:'openai'},{lane:'other'},{headers:{authorization:'Bearer another-login','x-codex-session-id':'session-one'}}]) {
    const result=history.resolve({model:f.slug,input:[carrier,user('must strip')]},f.context(overrides));
    assert.ok(!fingerprint(result.request).includes(carrier.encrypted_content),fingerprint(overrides));
  }
  const native={type:'reasoning',encrypted_content:'opaque-openai-fixture',summary:[]};
  history.remember(initial,{id:'fixture-native',output:[native]},f.context());
  assert.ok(!fingerprint(history.resolve({...next,previous_response_id:'fixture-native'},f.context()).request).includes(native.encrypted_content));
});

test('a provider switch strips even a formerly known carrier and stale history cannot recreate signatures',async t=>{
  let now=0;const f=await fixture(t),history=createHistoryStore({historySecret:'secret',historyTtlMs:10,now:()=>now});
  const initial={model:f.slug,input:[user('start')]};
  history.remember(initial,{id:'fixture-google',output:[carrier]},f.context());
  history.remember({model:'gpt-fixture',input:[user('GPT turn')]},{id:'fixture-gpt',output:[user('GPT visible')]},f.context({provider:'openai',preserveOpaqueReasoning:false,historyScope:undefined}));
  const migrated=history.resolve({model:f.slug,previous_response_id:'fixture-gpt',input:[carrier,user('switch back')]},f.context());
  assert.ok(!fingerprint(migrated.request).includes(carrier.encrypted_content));
  now=11;
  assert.ok(!fingerprint(history.resolve({model:f.slug,input:[carrier,user('expired')]},f.context()).request).includes(carrier.encrypted_content));
  assert.throws(()=>history.resolve({model:f.slug,previous_response_id:'fixture-google',input:[user('expired')]},f.context()),{code:'history_not_migratable'});
});

test('adapter preserves recognized carriers only when explicitly enabled and retains custom tool validation',()=>{
  const native={type:'reasoning',encrypted_content:'opaque-openai-fixture',summary:[]};
  const input=[carrier,native,user('visible')];
  assert.ok(!fingerprint(createAdapter({model:'fixture',input}).body).includes('encrypted_content'));
  const adapter=createAdapter({model:'fixture',input,tools:[{type:'custom',name:'apply_patch'}]},{preserveOpaqueReasoning:true,preserveApplyPatch:false,normalizeReasoning:false,strictCustomWrappers:true});
  assert.deepEqual(adapter.body.input[0],carrier);
  assert.ok(!fingerprint(adapter.body).includes(native.encrypted_content));
  const name=adapter.body.tools[0].name;
  assert.throws(()=>adapter.restoreItem({type:'function_call',name,arguments:'{"input":8}'},true),{code:'invalid_tool_call'});
});

test('real Responses runner/history integration preserves a signed custom-tool round trip without leaking auth or scope',async t=>{
  const f=await fixture(t),history=createHistoryStore({historySecret:'secret'}),requests=[];let counter=0;
  const runner=createProviderRunner({providers:f.store,secret:'secret',deepseekBase:'https://synthetic.invalid',getDeepseekKey:()=>'',readBody:async()=>Buffer.from(''),log:()=>{},
    requestUpstream:async(url,options,payload)=>{const body=JSON.parse(payload);requests.push({body,headers:options.headers});const output=++counter===1?[carrier,{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:body.tools[0].name,arguments:'{"input":"*** Begin Patch\\n*** End Patch"}',status:'completed'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'tool result accepted'}]}];return{statusCode:200,frames:[{type:'response.completed',response:{id:'fixture-'+counter,status:'completed',output}}]};},
    events:async function*(upstream){yield*upstream.frames;}});
  const initial={model:f.slug,input:[user('apply a fixture patch')],tools:[{type:'custom',name:'apply_patch',namespace:'workspace'}]};
  const firstResolved=history.resolve(initial,f.context());
  const first=await runner.run({route:f.route(),request:firstResolved.request,historyScope:firstResolved.opaqueReasoningScope});
  assert.equal(first.output[1].type,'custom_tool_call');assert.equal(first.output[1].namespace,'workspace');
  history.remember(initial,first,f.context({resolved:firstResolved}));
  const followup={model:f.slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:'call_fixture',output:'fixture patch applied'}],tools:initial.tools};
  const resolved=history.resolve(followup,f.context());
  await runner.run({route:f.route(),request:resolved.request,historyScope:resolved.opaqueReasoningScope});
  assert.deepEqual(requests[1].body.input[1],carrier);
  assert.equal(requests[1].body.input.at(-1).type,'function_call_output');
  assert.ok(fingerprint(requests[1].body).includes('fixture patch applied'));
  assert.ok(!fingerprint(requests[1].body).includes('synthetic-codex-login'));
  assert.ok(!fingerprint(requests[1].body).includes(f.route().historyScope));
  await runner.run({route:f.route(),request:resolved.request});
  assert.ok(!fingerprint(requests[2].body).includes(carrier.encrypted_content),'runner without provenance strips opaque');
  await f.store.saveProvider(config());
  await runner.run({route:f.route(),request:resolved.request,historyScope:resolved.opaqueReasoningScope});
  assert.ok(!fingerprint(requests[3].body).includes(carrier.encrypted_content),'credential update invalidates prior runner scope');
});
