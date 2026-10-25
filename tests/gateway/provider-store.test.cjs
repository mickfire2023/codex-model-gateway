'use strict';
// Every credential, provider and network service below is synthetic. No user
// configuration, encrypted credential, or external inference service is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {createProviderStore, createDpapiCredentialStore, normalizeBaseUrl, makeModelSlug, parseModelSlug} = require('../../gateway/provider-store.cjs');

const KEY_A = 'synthetic-provider-A-key';
const KEY_B = 'synthetic-provider-B-key';
const model = (overrides = {}) => ({id:'vendor/model-1', displayName:'Synthetic Model', contextWindow:65536, maxOutputTokens:8192, inputModalities:['text'], supportsTools:true, reasoningEfforts:['none','low','high'], defaultReasoningEffort:'low', ...overrides});
const provider = (overrides = {}) => ({id:'synthetic-a', name:'Synthetic A', baseUrl:'https://provider-a.invalid/v1', apiKey:KEY_A, protocol:'responses', models:[model()], ...overrides});

function fixture(t, options = {}) {
  const fixtureRoot = path.resolve(__dirname);
  const directory = fs.mkdtempSync(path.join(fixtureRoot, 'provider-fixture-'));
  t.after(()=>{
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(fixtureRoot + path.sep) && path.basename(resolved).startsWith('provider-fixture-'));
    fs.rmSync(resolved, {recursive:true, force:true});
  });
  const data = new Map();
  const credentialCalls = [];
  const credentialStore = {
    get(ref) { credentialCalls.push(['get',ref]); return data.get(ref) || ''; },
    set(ref, key) { credentialCalls.push(['set',ref]); data.set(ref,key); },
    delete(ref) { credentialCalls.push(['delete',ref]); data.delete(ref); }
  };
  const requests = [];
  const request = async (url, requestOptions) => {
    requests.push({url:url.href, ...structuredClone(requestOptions)});
    return {status:200, body:{data:[{id:'vendor/model-1', name:'Synthetic Model'},{id:'plain-model'},{id:'vendor/model-2'}]}};
  };
  const create = extra=>createProviderStore({directory, credentialStore, request, now:()=> '2026-10-26T00:00:00.000Z', ...options, ...extra});
  return {directory, configFile:path.join(directory,'private','providers','providers.json'), data, credentialStore, credentialCalls, requests, create, store:create()};
}

function expectCode(code, messagePattern) {
  return error=>{
    assert.equal(error.code,code);
    assert.ok(error.status >= 400);
    if (messagePattern) assert.match(error.message,messagePattern);
    assert.ok(!error.message.includes(KEY_A) && !error.message.includes(KEY_B));
    return true;
  };
}

test('save, startup load, list and catalog preserve declared capabilities without exposing credentials', async t=>{
  const f = fixture(t, {template:{model_messages:{instructions_template:'Generic official agent instructions'}, base_instructions:'Generic base instructions', context_window:1048576, supports_image_detail_original:true, supports_search_tool:true}});
  const saved = await f.store.saveProvider(provider());
  assert.equal(saved.keyConfigured,true);
  assert.equal(saved.models[0].slug,'custom/synthetic-a/vendor%2Fmodel-1');
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'https://provider-a.invalid/v1/models');
  assert.equal(f.requests[0].method,'GET');
  assert.equal(f.requests[0].redirect,'manual');
  assert.deepEqual(Object.keys(f.requests[0].headers).sort(),['accept','accept-encoding','authorization','content-type']);
  assert.equal(f.requests[0].headers.authorization,`Bearer ${KEY_A}`);
  const config = fs.readFileSync(f.configFile,'utf8');
  assert.ok(!config.includes(KEY_A));
  assert.ok(!config.includes('apiKey'));
  assert.ok(!JSON.stringify(f.store.listProviders()).includes(KEY_A));
  const catalog = f.store.catalogModels();
  assert.equal(catalog[0].context_window,65536);
  assert.equal(catalog[0].max_output_tokens,8192);
  assert.deepEqual(catalog[0].input_modalities,['text']);
  assert.equal(catalog[0].supports_image_detail_original,false);
  assert.equal(catalog[0].supports_search_tool,false);
  assert.equal(catalog[0].supports_parallel_tool_calls,false);
  assert.equal(catalog[0].model_messages.instructions_template,'Generic official agent instructions');
  assert.equal(catalog[0].base_instructions,'Generic base instructions');
  assert.match(catalog[0].display_name,/Synthetic A/);
  assert.deepEqual(f.create().listProviders(),f.store.listProviders());
  const route = f.store.routeBySlug(saved.models[0].slug);
  assert.ok(!JSON.stringify(route).includes(KEY_A));
  const upstream = f.store.upstreamForSlug(saved.models[0].slug);
  assert.equal(upstream.url.href,'https://provider-a.invalid/v1/responses');
  assert.equal(upstream.modelId,'vendor/model-1');
  assert.equal(upstream.apiKey,KEY_A);
  assert.ok(!JSON.stringify({...upstream}).includes(KEY_A));
  assert.ok(!Object.keys(upstream).includes('headers'));
  assert.throws(()=>JSON.stringify(upstream),/must not be serialized/);
});

test('validate discovers models without saving or claiming Responses/tools inference was verified', async t=>{
  const f = fixture(t);
  const result = await f.store.validateProvider(provider({models:[]}));
  assert.equal(result.ok,true);
  assert.deepEqual(result.availableModels.map(model=>model.id),['vendor/model-1','plain-model','vendor/model-2']);
  assert.equal(result.validation.modelsEndpointVerified,true);
  assert.equal(result.validation.selectedModelsVerified,false);
  assert.equal(result.validation.responsesVerified,false);
  assert.equal(result.validation.toolsVerified,false);
  assert.match(result.message,/尚未实测/);
  assert.deepEqual(f.store.listProviders(),[]);
  assert.equal(fs.existsSync(f.configFile),false);
  assert.equal(f.data.size,0);
  assert.ok(!JSON.stringify(result).includes(KEY_A));
});

test('provider identity and model IDs yield stable reversible and collision-free slugs', async t=>{
  const f = fixture(t, {request:async()=>({status:200,body:{data:[{id:'vendor/org/模型 % v1:2'}]}})});
  const id = 'vendor/org/模型 % v1:2';
  const first = await f.store.saveProvider(provider({models:[model({id})]}));
  const second = await f.store.saveProvider(provider({id:'synthetic-b',name:'Synthetic B',apiKey:KEY_B,models:[model({id})]}));
  assert.notEqual(first.models[0].slug,second.models[0].slug);
  assert.deepEqual(parseModelSlug(first.models[0].slug),{providerId:'synthetic-a',modelId:id});
  const renamed = await f.store.saveProvider(provider({name:'Renamed Provider',apiKey:'',models:[model({id,displayName:'Renamed Model'})]}));
  assert.equal(renamed.models[0].slug,first.models[0].slug);
  assert.equal(f.store.routeBySlug(first.models[0].slug).providerName,'Renamed Provider');
  for (const invalid of ['custom/synthetic-a/vendor/model','custom/synthetic-a/%zz','custom/synthetic-a/%2fmodel','custom/../model','custom/synthetic-a/%ED%A0%80']) {
    assert.equal(parseModelSlug(invalid),null);
    assert.equal(f.store.routeBySlug(invalid),null);
  }
  assert.throws(()=>makeModelSlug('../bad','x'));
});

test('protocol is explicit, defaults to Responses, and routes Chat Completions correctly', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider({protocol:undefined}));
  assert.equal(saved.protocol,'responses');
  const changed = await f.store.saveProvider(provider({protocol:'chat_completions',apiKey:''}));
  const upstream = f.store.upstreamForSlug(changed.models[0].slug);
  assert.equal(changed.protocol,'chat_completions');
  assert.equal(upstream.protocol,'chat_completions');
  assert.equal(upstream.url.href,'https://provider-a.invalid/v1/chat/completions');
  await assert.rejects(f.store.saveProvider(provider({protocol:'arbitrary'})),expectCode('invalid_provider_protocol'));
});

test('only HTTPS and exact loopback HTTP are accepted, with no credentials/query/fragment tricks', ()=>{
  assert.equal(normalizeBaseUrl('https://api.example.test/v1///'),'https://api.example.test/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1/'),'http://127.0.0.1:11434/v1');
  for (const address of [
    'http://api.example.test/v1','http://localhost:11434/v1','http://127.1:11434/v1',
    'http://2130706433/v1','http://0x7f000001/v1','http://[::1]/v1',
    'https://user:password@api.example.test/v1','https://@api.example.test/v1',
    'https://api.example.test/v1?x=1','https://api.example.test/v1?',
    'https://api.example.test/v1#hash','https://api.example.test/v1#',
    'https://api.example.test\\evil','https:/api.example.test','file:///tmp/key',
    'https://api.example.test/path with space','https://api.example.test/\npath'
  ]) assert.throws(()=>normalizeBaseUrl(address),undefined,address);
});

test('missing/invalid capability metadata cannot inherit DeepSeek defaults', async t=>{
  const f = fixture(t);
  for (const field of ['displayName','contextWindow','maxOutputTokens','inputModalities','supportsTools','reasoningEfforts']) {
    const incomplete = model(); delete incomplete[field];
    await assert.rejects(f.store.saveProvider(provider({models:[incomplete]})),error=>error.code === 'missing_model_capabilities' || error.code === 'invalid_provider_configuration');
  }
  for (const invalid of [
    model({contextWindow:'65536'}),model({maxOutputTokens:65537}),model({inputModalities:['image']}),
    model({inputModalities:['text','audio']}),model({supportsTools:'true'}),model({reasoningEfforts:['imaginary']}),
    model({defaultReasoningEffort:'max'}),model({id:'\ud800'}),model({id:' vendor/model-1 '})
  ]) await assert.rejects(f.store.saveProvider(provider({models:[invalid]})));
  assert.equal(f.requests.length,0);
  assert.equal(f.data.size,0);
  const saved = await f.store.saveProvider(provider({models:[model({supportsTools:false,reasoningEfforts:[],defaultReasoningEffort:undefined})]}));
  assert.deepEqual(saved.models[0].reasoningEfforts,['none']);
  const catalog = f.store.catalogModels()[0];
  assert.equal(catalog.supports_tools,false);
  assert.equal(catalog.supports_tool_calls,false);
  assert.equal(catalog.default_reasoning_level,'none');
  assert.deepEqual(catalog.supported_reasoning_levels.map(item=>item.effort),['none']);
});

test('a selected model absent from /models is rejected before any credential/config mutation', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider());
  const before = fs.readFileSync(f.configFile,'utf8');
  const calls = f.credentialCalls.length;
  await assert.rejects(f.store.saveProvider(provider({apiKey:KEY_B,models:[model({id:'missing-model'})]})),expectCode('provider_model_not_available'));
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
  assert.equal(f.credentialCalls.length,calls);
  assert.equal(f.store.upstreamForSlug(saved.models[0].slug).apiKey,KEY_A);
});

test('authentication, quota, redirect and upstream errors are translated without echoing upstream bodies', async t=>{
  const cases = [[401,'provider_authentication_failed',/密钥/],[403,'provider_authentication_failed',/权限/],
    [402,'provider_quota_exceeded',/余额/],[429,'provider_rate_limited',/限流/],
    [302,'provider_redirect_blocked',/重定向/],[307,'provider_redirect_blocked',/重定向/],
    [404,'provider_models_unsupported',/GET \/models/],[405,'provider_models_unsupported',/GET \/models/],
    [503,'provider_validation_failed',/503/]];
  for (const [status,code,pattern] of cases) {
    const f = fixture(t,{request:async()=>({status,body:JSON.stringify({error:{message:`secret: ${KEY_A}`}})})});
    await assert.rejects(f.store.saveProvider(provider()),expectCode(code,pattern));
    assert.equal(f.data.size,0);
    assert.equal(fs.existsSync(f.configFile),false);
  }
});

test('network errors and malformed model lists expose only safe Chinese messages', async t=>{
  const f = fixture(t,{request:async()=>{ throw new Error(`network failure with ${KEY_A}`); }});
  await assert.rejects(f.store.validateProvider(provider()),expectCode('provider_network_error',/网络/));
  for (const body of ['broken-json',{models:[{id:'vendor/model-1'}]},{data:null},'x'.repeat(2*1024*1024+1)]) {
    const store = f.create({request:async()=>({status:200,body})});
    await assert.rejects(store.validateProvider(provider()),expectCode('invalid_models_response'));
  }
});

test('failed configuration replacement retains the old credential, config and live route', async t=>{
  let failWrite = false;
  const f = fixture(t,{writeConfig:(file,contents)=>{
    if (failWrite) throw new Error(`disk full ${KEY_B}`);
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,contents);
  }});
  const saved = await f.store.saveProvider(provider());
  const before = fs.readFileSync(f.configFile,'utf8');
  const oldReference = JSON.parse(before).providers[0].credentialRef;
  failWrite = true;
  await assert.rejects(f.store.saveProvider(provider({name:'Changed',apiKey:KEY_B})),expectCode('provider_save_failed',/原配置与密钥已保留/));
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
  assert.equal(f.data.size,1);
  assert.equal(f.data.get(oldReference),KEY_A);
  assert.equal(f.store.listProviders()[0].name,'Synthetic A');
  assert.equal(f.store.upstreamForSlug(saved.models[0].slug).apiKey,KEY_A);
  assert.equal(f.create().upstreamForSlug(saved.models[0].slug).apiKey,KEY_A);
});

test('failed key encryption preserves existing state even when credentialStore partially wrote a new ref', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider());
  const before = fs.readFileSync(f.configFile,'utf8');
  const normalSet = f.credentialStore.set;
  f.credentialStore.set = (ref,key)=>{ normalSet(ref,key); throw new Error(`failed ${KEY_B}`); };
  await assert.rejects(f.store.saveProvider(provider({apiKey:KEY_B})),expectCode('provider_credential_save_failed'));
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
  assert.equal(f.data.size,1);
  assert.equal(f.store.upstreamForSlug(saved.models[0].slug).apiKey,KEY_A);
});

test('new credentials use a fresh file reference; old reference is removed after commit', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider());
  const oldReference = JSON.parse(fs.readFileSync(f.configFile,'utf8')).providers[0].credentialRef;
  await f.store.saveProvider(provider({apiKey:KEY_B}));
  const nextReference = JSON.parse(fs.readFileSync(f.configFile,'utf8')).providers[0].credentialRef;
  assert.notEqual(nextReference,oldReference);
  assert.equal(f.data.has(oldReference),false);
  assert.equal(f.data.get(nextReference),KEY_B);
  assert.equal(f.data.size,1);
  assert.equal(f.store.upstreamForSlug(saved.models[0].slug).apiKey,KEY_B);
});

test('reusing a saved key at a changed API address requires explicit reentry', async t=>{
  const f = fixture(t);
  await f.store.saveProvider(provider());
  const count = f.requests.length;
  await assert.rejects(f.store.saveProvider(provider({baseUrl:'https://provider-b.invalid/v1',apiKey:''})),expectCode('provider_key_confirmation_required'));
  assert.equal(f.requests.length,count);
  await f.store.saveProvider(provider({baseUrl:'https://provider-b.invalid/v1',apiKey:KEY_B}));
  assert.equal(f.requests.at(-1).url,'https://provider-b.invalid/v1/models');
  assert.equal(f.requests.at(-1).headers.authorization,`Bearer ${KEY_B}`);
});

test('multiple providers isolate credentials and public routes remain secret-free', async t=>{
  const f = fixture(t);
  const a = await f.store.saveProvider(provider());
  const b = await f.store.saveProvider(provider({id:'synthetic-b',name:'Synthetic B',baseUrl:'https://provider-b.invalid/api',apiKey:KEY_B}));
  const first = f.store.upstreamForSlug(a.models[0].slug);
  const second = f.store.upstreamForSlug(b.models[0].slug);
  assert.equal(first.headers.authorization,`Bearer ${KEY_A}`);
  assert.equal(second.headers.authorization,`Bearer ${KEY_B}`);
  assert.equal(new URL(first.url).host,'provider-a.invalid');
  assert.equal(new URL(second.url).host,'provider-b.invalid');
  for (const upstream of [first,second]) {
    assert.equal(upstream.headers.cookie,undefined);
    assert.equal(upstream.headers['chatgpt-account-id'],undefined);
    assert.equal(upstream.headers['x-api-key'],undefined);
  }
  assert.ok(!JSON.stringify([f.store.listProviders(),f.store.getCatalog(),f.store.routeBySlug(a.models[0].slug)]).includes(KEY_A));
  assert.ok(!JSON.stringify([f.store.listProviders(),f.store.getCatalog(),f.store.routeBySlug(b.models[0].slug)]).includes(KEY_B));
});

test('manual model removal and provider deletion persist and immediately disable routing', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider({models:[model(),model({id:'vendor/model-2'})]}));
  await f.store.removeModel(saved.id,'vendor/model-1');
  assert.equal(f.store.routeBySlug(saved.models[0].slug),null);
  assert.throws(()=>f.store.upstreamForSlug(saved.models[0].slug),expectCode('provider_model_not_found'));
  assert.equal(f.create().catalogModels().length,1);
  await f.store.removeModel(saved.id,'vendor/model-2');
  assert.equal(f.create().listProviders()[0].models.length,0);
  assert.equal(f.data.size,1);
  assert.deepEqual(await f.store.removeProvider(saved.id),{removed:true,providerId:saved.id});
  assert.equal(f.data.size,0);
  assert.deepEqual(f.create().listProviders(),[]);
  await assert.rejects(f.store.removeProvider(saved.id),expectCode('provider_not_found'));
});

test('a missing/unreadable startup credential leaves configuration editable and blocks forwarding', async t=>{
  const f = fixture(t);
  const saved = await f.store.saveProvider(provider());
  f.data.clear();
  const loaded = f.create();
  assert.equal(loaded.listProviders()[0].keyConfigured,false);
  assert.throws(()=>loaded.upstreamForSlug(saved.models[0].slug),expectCode('provider_key_missing'));
  await loaded.saveProvider(provider({apiKey:KEY_B}));
  assert.equal(loaded.upstreamForSlug(saved.models[0].slug).apiKey,KEY_B);
});

test('save snapshots input and serializes concurrent mutations', async t=>{
  let release;
  const held = new Promise(resolve=>{ release=resolve; });
  let calls = 0;
  const f = fixture(t,{request:async()=>{ if (++calls === 1) await held; return {status:200,body:{data:[{id:'vendor/model-1'}]}}; }});
  const input = provider();
  const saving = f.store.saveProvider(input);
  input.baseUrl = 'https://unexpected.invalid'; input.apiKey = KEY_B;
  const second = f.store.saveProvider(provider({id:'synthetic-b',apiKey:KEY_B}));
  release();
  await Promise.all([saving,second]);
  assert.equal(f.store.listProviders().length,2);
  assert.equal(f.store.listProviders().find(item=>item.id === 'synthetic-a').baseUrl,'https://provider-a.invalid/v1');
  assert.equal(f.data.size,2);
});

test('real local /models requests never follow a redirect carrying Authorization', async t=>{
  const requests = [];
  const target = http.createServer((req,res)=>{ requests.push({server:'target',url:req.url,headers:req.headers}); res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({data:[{id:'vendor/model-1'}]})); });
  target.listen(0,'127.0.0.1'); await once(target,'listening');
  const source = http.createServer((req,res)=>{
    requests.push({server:'source',url:req.url,headers:req.headers});
    res.writeHead(307,{location:`http://127.0.0.1:${target.address().port}/stolen`}); res.end();
  });
  source.listen(0,'127.0.0.1'); await once(source,'listening');
  t.after(async()=>{
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve=>source.close(resolve)),new Promise(resolve=>target.close(resolve))]);
  });
  const f = fixture(t,{request:undefined});
  await assert.rejects(f.store.saveProvider(provider({baseUrl:`http://127.0.0.1:${source.address().port}/v1`})),expectCode('provider_redirect_blocked'));
  assert.equal(requests.length,1);
  assert.equal(requests[0].server,'source');
  assert.equal(requests[0].url,'/v1/models');
  assert.equal(requests[0].headers.authorization,`Bearer ${KEY_A}`);
});

test('DPAPI helper uses private files, hidden WinPS, stdin and the WinPS module path without spawning in tests', t=>{
  const f = fixture(t);
  const calls = [];
  const credentialStore = createDpapiCredentialStore({directory:path.join(f.directory,'encrypted'),platform:'win32',spawnSyncImpl:(command,args,options)=>{
    calls.push({command,args,options});
    return {status:0,stdout:args.at(-1).includes('ConvertFrom-SecureString') ? '01000000encrypted-synthetic' : KEY_A};
  }});
  credentialStore.set('safe-reference',KEY_A);
  const file = path.join(f.directory,'encrypted','safe-reference.dpapi');
  assert.equal(fs.readFileSync(file,'utf8'),'01000000encrypted-synthetic');
  assert.equal(credentialStore.get('safe-reference'),KEY_A);
  assert.equal(calls[0].options.input,KEY_A);
  assert.ok(!calls[0].args.join(' ').includes(KEY_A));
  assert.equal(calls[0].options.windowsHide,true);
  assert.match(calls[0].options.env.PSModulePath,/WindowsPowerShell[\\/]v1\.0[\\/]Modules$/);
  assert.equal(calls[1].options.input,'01000000encrypted-synthetic');
  assert.throws(()=>credentialStore.get('../escape'),expectCode('invalid_credential_reference'));
  credentialStore.delete('safe-reference');
  assert.equal(fs.existsSync(file),false);
});

test('corrupt config and unsafe stored credential references fail closed', t=>{
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.configFile),{recursive:true});
  for (const config of [
    '{bad json',JSON.stringify({version:2,providers:[]}),
    JSON.stringify({version:1,providers:[{...provider(),credentialRef:'../../secret'}]})
  ]) {
    fs.writeFileSync(f.configFile,config);
    assert.throws(()=>f.create(),expectCode('provider_store_invalid'));
    assert.equal(fs.readFileSync(f.configFile,'utf8'),config);
  }
});
