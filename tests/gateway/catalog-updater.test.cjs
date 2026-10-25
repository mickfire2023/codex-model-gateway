'use strict';
// Independent updater qualification. All HTTP services, identities and credentials are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {createHash} = require('node:crypto');

const IMPLEMENTATION = process.env.GATEWAY_TEST_DIR || path.resolve(__dirname,'../../gateway');
const V2 = fs.existsSync(path.join(IMPLEMENTATION,'socket-router.cjs'));
const {createCatalogUpdater,extractDeepseekCatalog} = require(path.join(IMPLEMENTATION,'catalog-updater.cjs'));
const {createGateway} = require(path.join(IMPLEMENTATION,'gateway.cjs'));
const FIXTURES = path.join(__dirname,'test-fixtures');
const ACCOUNT_A = 'synthetic-account-a';
const ACCOUNT_B = 'synthetic-account-b';
const GPT_AUTH = 'Bearer synthetic-gpt-token';
const DS_KEY = 'sk-synthetic-deepseek-catalog-only';
let runNumber = 0;

function model(slug, overrides={}) {
  return {slug,display_name:slug,description:'Synthetic model metadata',visibility:'list',supported_in_api:true,priority:1,minimal_client_version:'0.144.0',context_window:1048576,max_context_window:1048576,effective_context_window_percent:95,default_reasoning_level:'high',supported_reasoning_levels:[{effort:'low',description:'Low'},{effort:'high',description:'High'},{effort:'max',description:'Max'}],tool_mode:null,use_responses_lite:false,prefer_websockets:false,input_modalities:['text'],apply_patch_tool_type:'freeform',shell_type:'shell_command',supports_parallel_tool_calls:true,upgrade:null,service_tiers:[],additional_speed_tiers:[],default_service_tier:null,model_messages:{instructions_template:'Continue the synthetic coding task carefully.'},...overrides};
}
function htmlCatalog(catalog) {
  const escaped = JSON.stringify(catalog).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return '<!doctype html><html><body><h1>Integrate with Codex</h1><pre><code class="language-json">'+escaped+'</code></pre></body></html>';
}
function fixtureDirectory() {
  const directory = path.join(FIXTURES,`catalog-run-${process.pid}-${++runNumber}`);
  fs.mkdirSync(directory,{recursive:true});
  return directory;
}
function writeJson(directory,filename,value) {
  fs.writeFileSync(path.join(directory,filename),JSON.stringify(value,null,2));
}
function readJson(directory,filename) {
  return JSON.parse(fs.readFileSync(path.join(directory,filename),'utf8'));
}
function fileDigest(directory,filename) {
  return createHash('sha256').update(fs.readFileSync(path.join(directory,filename))).digest('hex');
}
async function mockSources(t) {
  const state = {
    gpt:{etag:'"gpt-v1"',status:200,body:{models:[model('gpt-synthetic-one')]}},
    deepseek:{etag:'"ds-v1"',status:200,body:{object:'list',data:[{id:'deepseek-flash',object:'model',owned_by:'deepseek'},{id:'deepseek-v4-pro',object:'model',owned_by:'deepseek'}]}},
    docs:{etag:'"docs-v1"',status:200,body:htmlCatalog({models:[model('deepseek-flash',{input_modalities:['text','image']}),model('deepseek-v4-pro')]})},
  };
  const observed = [];
  const server = http.createServer(async(req,res)=>{
    const url = new URL(req.url,'http://127.0.0.1');
    if (url.pathname==='/ds/responses' || url.pathname==='/gpt/responses') {
      const chunks=[]; for await(const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const kind=url.pathname==='/ds/responses'?'ds-response':'gpt-response';
      observed.push({url:req.url,headers:{...req.headers},kind,body});
      const response={id:'synthetic-integration-response',object:'response',model:body.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'synthetic local response',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
      if(kind==='ds-response') { res.writeHead(200,{'content-type':'text/event-stream'}); return res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`); }
      res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(response));
    }
    const kind = url.pathname==='/gpt/models' ? 'gpt' : url.pathname==='/ds/models' ? 'deepseek' : url.pathname==='/docs/codex' ? 'docs' : undefined;
    observed.push({url:req.url,headers:{...req.headers},kind});
    if (!kind) { res.writeHead(404); return res.end('unknown synthetic endpoint'); }
    const source = state[kind];
    if (source.hang) return;
    if (source.status===200 && source.etag && req.headers['if-none-match']===source.etag) {
      res.writeHead(304,{etag:source.etag}); return res.end();
    }
    res.writeHead(source.status,{'content-type':kind==='docs'?'text/html; charset=utf-8':'application/json',...(source.etag?{etag:source.etag}:{}),'cache-control':'private, max-age=0'});
    const body = typeof source.body==='function' ? source.body(req,url) : source.body;
    res.end(typeof body==='string'?body:JSON.stringify(body));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{ server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve)); });
  return {state,observed,base,server};
}

async function updaterRig(t,{intervalMs=25}={}) {
  const sources = await mockSources(t);
  const directory = fixtureDirectory();
  const initialGptCatalog = {models:[model('gpt-synthetic-initial')]};
  const initialDeepseekCatalog = {models:[model('deepseek-flash'),model('deepseek-v4-pro')]};
  writeJson(directory,'openai-models.json',initialGptCatalog);
  writeJson(directory,'deepseek-models.json',initialDeepseekCatalog);
  const updates = [], logs = [];
  const credentials = {chatgptHeaders:{authorization:GPT_AUTH,'chatgpt-account-id':ACCOUNT_A},deepseekKey:DS_KEY,clientVersion:'0.164.0',accountId:ACCOUNT_A};
  const updater = createCatalogUpdater({directory,gptBase:sources.base+'/gpt',deepseekBase:sources.base+'/ds',docsUrl:sources.base+'/docs/codex',intervalMs,getCredentials:()=>({...credentials,chatgptHeaders:{...credentials.chatgptHeaders}}),initialGptCatalog,initialDeepseekCatalog,onUpdate:update=>updates.push(structuredClone(update)),log:record=>logs.push(record)});
  t.after(()=>updater.close());
  return {...sources,directory,initialGptCatalog,initialDeepseekCatalog,credentials,updates,logs,updater,refresh:overrides=>updater.refresh({force:true,...overrides})};
}
async function until(predicate,timeoutMs=1500) {
  const end = Date.now()+timeoutMs;
  while(!predicate()) {
    if(Date.now()>=end) throw new Error('Synthetic updater condition timed out');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}
function names(catalog) { return catalog?.models?.map(entry=>entry.slug); }
function counts(observed,kind) { return observed.filter(entry=>entry.kind===kind).length; }
function localRequest(base,endpoint,{method='GET',headers={},body,auth=true}={}) {
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    const req=http.request(new URL(endpoint,base),{method,headers:{...(auth?{authorization:GPT_AUTH,'chatgpt-account-id':ACCOUNT_A}:{}),...(payload?{'content-type':'application/json','content-length':payload.length}:{}),...headers}},async res=>{
      const chunks=[];for await(const chunk of res) chunks.push(chunk);
      const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text);}catch{}
      resolve({status:res.statusCode,headers:res.headers,text,json});
    });
    req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('Local gateway integration timed out')));
    if(payload)req.write(payload);req.end();
  });
}
async function gatewayRig(t) {
  const sources=await mockSources(t);
  const directory=fixtureDirectory();
  writeJson(directory,'openai-models.json',{models:[model('gpt-synthetic-initial')]});
  writeJson(directory,'deepseek-models.json',{models:[model('deepseek-flash'),model('deepseek-v4-pro')]});
  const token='synthetic-integrated-route-token';
  const credentials={chatgptHeaders:{authorization:GPT_AUTH,'chatgpt-account-id':ACCOUNT_A},deepseekKey:DS_KEY,clientVersion:'0.164.0',accountId:ACCOUNT_A};
  const gateway=createGateway({directory,routeToken:token,clientVersion:'0.164.0',catalogSyncEnabled:true,catalogRefreshIntervalMs:600000},{gptBase:sources.base+'/gpt',deepseekBase:sources.base+'/ds',deepseekDocsUrl:sources.base+'/docs/codex',deepseekKey:DS_KEY,getCatalogCredentials:()=>structuredClone(credentials)});
  gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');
  const base=`http://127.0.0.1:${gateway.server.address().port}`;
  t.after(async()=>{gateway.updater.close();gateway.server.closeAllConnections?.();await new Promise(resolve=>gateway.server.close(resolve));});
  await gateway.updater.refresh({force:true});
  return {...sources,directory,token,gateway,gatewayBase:base,root:`/${token}`};
}

test('constructing updater has no network side effects; explicit refresh isolates all source credentials', async t=>{
  const r = await updaterRig(t);
  assert.equal(r.observed.length,0);
  const result = await r.refresh();
  assert.deepEqual(names(result.gptCatalog),['gpt-synthetic-one']);
  assert.deepEqual(names(result.deepseekCatalog),['deepseek-flash','deepseek-v4-pro']);
  const gpt = r.observed.find(entry=>entry.kind==='gpt');
  const ds = r.observed.find(entry=>entry.kind==='deepseek');
  const docs = r.observed.find(entry=>entry.kind==='docs');
  assert.equal(gpt.headers.authorization,GPT_AUTH);
  assert.equal(gpt.headers['chatgpt-account-id'],ACCOUNT_A);
  assert.equal(new URL(gpt.url,r.base).searchParams.get('client_version'),'0.164.0');
  assert.equal(ds.headers.authorization,'Bearer '+DS_KEY);
  assert.equal(ds.headers['chatgpt-account-id'],undefined);
  assert.equal(docs.headers.authorization,undefined);
  assert.equal(docs.headers['chatgpt-account-id'],undefined);
  assert.deepEqual(readJson(r.directory,'openai-models.json'),result.gptCatalog);
  assert.deepEqual(readJson(r.directory,'deepseek-models.json'),result.deepseekCatalog);
  const diagnostics = JSON.stringify({status:r.updater.status(),logs:r.logs});
  for(const secret of [GPT_AUTH,DS_KEY,ACCOUNT_A]) assert.equal(diagnostics.includes(secret),false,'status/log must omit synthetic credential and identity');
});

test('ETag conditional refresh preserves catalog and does not treat 304 as empty', async t=>{
  const r = await updaterRig(t);
  const first = await r.refresh();
  const second = await r.refresh();
  assert.deepEqual(second.gptCatalog,first.gptCatalog);
  assert.deepEqual(second.deepseekCatalog,first.deepseekCatalog);
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],'"gpt-v1"');
  assert.equal(r.observed.filter(entry=>entry.kind==='deepseek').at(-1).headers['if-none-match'],'"ds-v1"');
  assert.equal(r.observed.filter(entry=>entry.kind==='docs').at(-1).headers['if-none-match'],'"docs-v1"');
  assert.deepEqual(readJson(r.directory,'openai-models.json'),first.gptCatalog);
});

test('GPT additions and removals and supported DeepSeek availability changes replace the prior lists', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  r.state.gpt.etag='"gpt-v2"';
  r.state.gpt.body={models:[model('gpt-synthetic-new'),model('gpt-synthetic-other')]};
  r.state.deepseek.etag='"ds-v2"';
  r.state.deepseek.body={object:'list',data:[{id:'deepseek-flash',object:'model'}]};
  const removed = await r.refresh();
  assert.deepEqual(names(removed.gptCatalog),['gpt-synthetic-new','gpt-synthetic-other']);
  assert.deepEqual(names(removed.deepseekCatalog),['deepseek-flash']);
  r.state.deepseek.etag='"ds-v3"';
  r.state.deepseek.body={object:'list',data:[{id:'deepseek-flash',object:'model'},{id:'deepseek-v4-pro',object:'model'}]};
  const restored = await r.refresh();
  assert.deepEqual(names(restored.deepseekCatalog),['deepseek-flash','deepseek-v4-pro']);
  assert.equal(names(restored.gptCatalog).includes('gpt-synthetic-one'),false,'retired GPT model must not linger');
});

test('unknown DeepSeek IDs are pending instead of enabled without validated official metadata', async t=>{
  const r = await updaterRig(t);
  r.state.deepseek.body.data.push({id:'deepseek-unknown-synthetic',object:'model'});
  const result = await r.refresh();
  assert.equal(names(result.deepseekCatalog).includes('deepseek-unknown-synthetic'),false);
  assert.ok(r.updater.status().deepseek.pendingModels.includes('deepseek-unknown-synthetic'));
  assert.equal(names(readJson(r.directory,'deepseek-models.json')).includes('deepseek-unknown-synthetic'),false);
});

test('GPT model catalogs and ETags are isolated by account and client version', async t=>{
  const r = await updaterRig(t);
  r.state.gpt.etag='"gpt-a-164"';
  r.state.gpt.body={models:[model('gpt-account-a-164')]};
  await r.refresh();
  r.state.gpt.etag='"gpt-b-164"';
  r.state.gpt.body={models:[model('gpt-account-b-164')]};
  const b = await r.refresh({accountId:ACCOUNT_B,chatgptHeaders:{authorization:'Bearer synthetic-gpt-b','chatgpt-account-id':ACCOUNT_B}});
  assert.deepEqual(names(b.gptCatalog),['gpt-account-b-164']);
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],undefined);
  r.state.gpt.etag='"gpt-b-165"';
  r.state.gpt.body={models:[model('gpt-account-b-165')]};
  const newer = await r.refresh({accountId:ACCOUNT_B,chatgptHeaders:{authorization:'Bearer synthetic-gpt-b','chatgpt-account-id':ACCOUNT_B},clientVersion:'0.165.0'});
  assert.deepEqual(names(newer.gptCatalog),['gpt-account-b-165']);
  const newestRequest = r.observed.filter(entry=>entry.kind==='gpt').at(-1);
  assert.equal(newestRequest.headers['if-none-match'],undefined);
  assert.equal(new URL(newestRequest.url,r.base).searchParams.get('client_version'),'0.165.0');
  r.state.gpt.etag='"gpt-a-164"';
  r.state.gpt.body={models:[model('gpt-account-a-164')]};
  const again = await r.refresh();
  assert.deepEqual(names(again.gptCatalog),['gpt-account-a-164']);
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],'"gpt-a-164"');
});

test('HTTP 401 never republishes another account or a rejected account catalog and preserves disk bytes', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  const before = fileDigest(r.directory,'openai-models.json');
  r.state.gpt.status=401;
  r.state.gpt.body={error:{message:'synthetic rejected credential'}};
  const rejectedKnown = await r.refresh();
  assert.equal(rejectedKnown.gptCatalog,null);
  assert.equal(fileDigest(r.directory,'openai-models.json'),before);
  const rejectedNew = await r.refresh({accountId:ACCOUNT_B,chatgptHeaders:{authorization:'Bearer synthetic-gpt-b','chatgpt-account-id':ACCOUNT_B}});
  assert.equal(rejectedNew.gptCatalog,null);
  assert.equal(fileDigest(r.directory,'openai-models.json'),before);
  assert.equal(r.updater.status().gpt.errorStatus,401);
});

test('invalid HTML, empty documentation and invalid context metadata keep the previous validated DS file intact', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  const before = fileDigest(r.directory,'deepseek-models.json');
  const invalidDocs = [
    '<!doctype html><html><title>Temporary upstream error</title><body>not a catalog</body></html>',
    htmlCatalog({models:[]}),
    htmlCatalog({models:[model('deepseek-flash',{context_window:0})]}),
  ];
  for(let index=0;index<invalidDocs.length;index++) {
    r.state.docs.etag=`"invalid-docs-${index}"`; r.state.docs.body=invalidDocs[index];
    await r.refresh();
    assert.equal(fileDigest(r.directory,'deepseek-models.json'),before);
    assert.ok(r.updater.status().deepseek.errorCode,'validation failure must remain visible');
  }
});

test('extractor rejects structurally unusable catalogs without executing HTML scripts', ()=>{
  const invalid = ['<script>throw new Error("must never execute")</script>',htmlCatalog({models:[]}),htmlCatalog({models:[model('deepseek-flash',{context_window:-1})]}),htmlCatalog({models:[model('deepseek-flash',{supported_reasoning_levels:[]})]}),htmlCatalog({models:[model('deepseek-flash',{default_reasoning_level:'invented'})]})];
  for(const html of invalid) assert.throws(()=>extractDeepseekCatalog(html));
  assert.deepEqual(names(extractDeepseekCatalog(htmlCatalog({models:[model('deepseek-flash')]}))),['deepseek-flash']);
});

test('invalid or empty GPT catalog preserves prior validated snapshot rather than blanking it', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  const before = fileDigest(r.directory,'openai-models.json');
  for(const [index,body] of [{models:[]},{models:[model('duplicate'),model('duplicate')]},'<html>synthetic bad gateway</html>'].entries()) {
    r.state.gpt.etag=`"invalid-gpt-${index}"`; r.state.gpt.body=body;
    const result = await r.refresh();
    assert.equal(fileDigest(r.directory,'openai-models.json'),before);
    assert.ok(result.gptCatalog===null || names(result.gptCatalog).includes('gpt-synthetic-one'));
    assert.ok(r.updater.status().gpt.errorCode);
  }
});

test('DeepSeek HTTP authentication failure preserves the last validated file', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  const before = fileDigest(r.directory,'deepseek-models.json');
  r.state.deepseek.status=401; r.state.deepseek.body={error:{message:'synthetic DS auth failure'}};
  await r.refresh();
  assert.equal(fileDigest(r.directory,'deepseek-models.json'),before);
  assert.equal(r.updater.status().deepseek.errorStatus,401);
});

test('start schedules refresh and close stops subsequent timer activity', async t=>{
  const r = await updaterRig(t,{intervalMs:25});
  r.updater.start();
  await until(()=>counts(r.observed,'gpt')>=2);
  await r.updater.close();
  const stopped = r.observed.length;
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(r.observed.length,stopped,'closed updater must not perform periodic requests');
});

test('close aborts an active upstream fetch and settles refresh promptly', async t=>{
  const r = await updaterRig(t);
  r.state.gpt.hang=true;
  const active = r.refresh().then(value=>({value}),error=>({error}));
  await until(()=>counts(r.observed,'gpt')>=1);
  await r.updater.close();
  const settled = await Promise.race([active,new Promise(resolve=>setTimeout(()=>resolve('timed-out'),500))]);
  assert.notEqual(settled,'timed-out','close must abort the active fetch rather than wait for its network timeout');
});

test('same workspace and version with another credential cannot reuse a prior caller catalog', async t=>{
  const r = await updaterRig(t);
  r.state.gpt.etag='"caller-a"';
  await r.refresh({skipDeepseek:true});
  r.state.gpt.status=500;
  const another = await r.refresh({skipDeepseek:true,chatgptHeaders:{authorization:'Bearer synthetic-distinct-user-in-same-workspace','chatgpt-account-id':ACCOUNT_A},accountId:ACCOUNT_A});
  assert.equal(another.gptCatalog,null,'new credentials must not inherit prior-user fallback on temporary failure');
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],undefined);
  r.state.gpt.status=200;
  const again = await r.refresh({skipDeepseek:true});
  assert.deepEqual(names(again.gptCatalog),['gpt-synthetic-one']);
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],'"caller-a"','returning to the original caller may reuse only its own ETag');
});

test('GPT scope LRU is bounded and evicts the oldest of more than sixteen identities', async t=>{
  const r = await updaterRig(t);
  for(let index=0;index<17;index++) {
    await r.refresh({skipDeepseek:true,accountId:`synthetic-scope-${index}`,chatgptHeaders:{authorization:`Bearer synthetic-scope-token-${index}`,'chatgpt-account-id':`synthetic-scope-${index}`}});
  }
  await r.refresh({skipDeepseek:true,accountId:'synthetic-scope-0',chatgptHeaders:{authorization:'Bearer synthetic-scope-token-0','chatgpt-account-id':'synthetic-scope-0'}});
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers['if-none-match'],undefined,'the oldest evicted caller must fetch its catalog anew');
});

test('skipDeepseek refresh returns without waiting for or requesting DS API and documentation', async t=>{
  const r = await updaterRig(t);
  r.state.deepseek.hang=true; r.state.docs.hang=true;
  const before = r.updater.status().deepseek;
  const result = await r.refresh({skipDeepseek:true});
  assert.deepEqual(names(result.gptCatalog),['gpt-synthetic-one']);
  assert.equal(counts(r.observed,'deepseek'),0);
  assert.equal(counts(r.observed,'docs'),0);
  assert.deepEqual(r.updater.status().deepseek,before,'GPT-only refresh must not rewrite DS provider state');
});

test('DeepSeek metadata requiring a newer client stays pending until the local client is compatible', async t=>{
  const r = await updaterRig(t);
  r.state.docs.body=htmlCatalog({models:[model('deepseek-flash',{minimal_client_version:'0.165.0'}),model('deepseek-v4-pro',{minimal_client_version:'0.144.0'})]});
  const older = await r.refresh();
  assert.deepEqual(names(older.deepseekCatalog),['deepseek-v4-pro']);
  assert.ok(r.updater.status().deepseek.pendingModels.includes('deepseek-flash'));
  r.credentials.clientVersion='0.165.0';
  const newer = await r.refresh();
  assert.deepEqual(names(newer.deepseekCatalog),['deepseek-flash','deepseek-v4-pro']);
  assert.equal(r.updater.status().deepseek.pendingModels.includes('deepseek-flash'),false);
});

test('a valid list containing only unknown DS models commits an empty resolved list and reports pending IDs', async t=>{
  const r = await updaterRig(t);
  await r.refresh();
  r.state.deepseek.etag='"unknown-only"';
  r.state.deepseek.body={object:'list',data:[{id:'deepseek-unknown-synthetic',object:'model'}]};
  const result = await r.refresh();
  assert.deepEqual(names(result.deepseekCatalog),[]);
  assert.ok(r.updater.status().deepseek.pendingModels.includes('deepseek-unknown-synthetic'));
  assert.deepEqual(readJson(r.directory,'deepseek-models.json').models,[]);
  assert.equal(r.updater.status().deepseek.modelCount,0);
  assert.equal(r.updater.status().deepseek.errorCode,null);
});

test('missing or malformed DS minimum versions are pending and an unparseable client cannot commit new models', async t=>{
  const r = await updaterRig(t);
  for(const [index,minimum] of [undefined,'invalid-minimum-version'].entries()) {
    r.state.docs.etag=`"invalid-minimum-${index}"`;
    r.state.docs.body=htmlCatalog({models:[model('deepseek-flash',{minimal_client_version:minimum}),model('deepseek-v4-pro')]});
    const result = await r.refresh();
    assert.deepEqual(names(result.deepseekCatalog),['deepseek-v4-pro']);
    assert.ok(r.updater.status().deepseek.pendingModels.includes('deepseek-flash'));
  }
  r.state.docs.etag='"valid-minimum-again"';
  r.state.docs.body=htmlCatalog({models:[model('deepseek-flash'),model('deepseek-v4-pro')]});
  r.credentials.clientVersion='invalid-client-version';
  const result = await r.refresh();
  assert.deepEqual(names(result.deepseekCatalog),[],'an unknown client version must not activate newly encountered metadata');
  assert.deepEqual(new Set(r.updater.status().deepseek.pendingModels),new Set(['deepseek-flash','deepseek-v4-pro']));
  assert.equal(r.updater.status().deepseek.stale,false);
  assert.equal(r.updater.status().deepseek.errorCode,null);
  assert.deepEqual(readJson(r.directory,'deepseek-models.json').models,[]);
});

test('all future-version DS models resolve empty and the persisted empty catalog can restart', async t=>{
  const r=await updaterRig(t);
  r.state.docs.body=htmlCatalog({models:[model('deepseek-flash',{minimal_client_version:'99.0.0'}),model('deepseek-v4-pro',{minimal_client_version:'99.0.0'})]});
  const result=await r.refresh();
  assert.deepEqual(result.deepseekCatalog.models,[]);
  assert.deepEqual(new Set(r.updater.status().deepseek.pendingModels),new Set(['deepseek-flash','deepseek-v4-pro']));
  assert.equal(r.updater.status().deepseek.modelCount,0);
  assert.equal(r.updater.status().deepseek.errorCode,null);
  const restarted=createCatalogUpdater({directory:r.directory,gptBase:r.base+'/gpt',deepseekBase:r.base+'/ds',docsUrl:r.base+'/docs/codex',getCredentials:()=>r.credentials,initialGptCatalog:readJson(r.directory,'openai-models.json'),initialDeepseekCatalog:readJson(r.directory,'deepseek-models.json')});
  t.after(()=>restarted.close());
  const resumed=await restarted.refresh({force:true,skipDeepseek:true});
  assert.deepEqual(resumed.deepseekCatalog.models,[]);
});

test('gateway model GET serves live GPT changes in the combined catalog without waiting for DS/docs', async t=>{
  const r=await gatewayRig(t);
  const first=await localRequest(r.gatewayBase,r.gateway.prefix+'/models?client_version=0.164.0');
  assert.equal(first.status,200);
  assert.deepEqual(new Set(names(first.json)),new Set(['gpt-synthetic-one','deepseek-flash','deepseek-v4-pro']));
  const dsBefore=counts(r.observed,'deepseek'),docsBefore=counts(r.observed,'docs');
  r.state.gpt.etag='"integration-gpt-v2"';
  r.state.gpt.body={models:[model('gpt-synthetic-replacement'),model('gpt-synthetic-added')]};
  r.state.deepseek.hang=true;r.state.docs.hang=true;
  const second=await localRequest(r.gatewayBase,r.gateway.prefix+'/models?client_version=0.164.0');
  assert.equal(second.status,200);
  assert.deepEqual(new Set(names(second.json)),new Set(['gpt-synthetic-replacement','gpt-synthetic-added','deepseek-flash','deepseek-v4-pro']));
  assert.equal(counts(r.observed,'deepseek'),dsBefore);
  assert.equal(counts(r.observed,'docs'),docsBefore);
  assert.equal(r.observed.filter(entry=>entry.kind==='gpt').at(-1).headers.authorization,GPT_AUTH);
});

test('gateway manual null-origin refresh uses its own CSRF and activates new official DS routes with DS credentials', async t=>{
  const r=await gatewayRig(t);
  const page=await localRequest(r.gatewayBase,r.root+'/',{auth:false});
  const forms=[...page.text.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  const tokenFor=action=>forms.find(match=>match[1]===action)?.[2].match(/name="csrf_token"\s+value="([a-f0-9]{64})"/)?.[1];
  const refreshToken=tokenFor(r.root+'/settings/refresh');
  const keyToken=tokenFor(r.root+'/settings/key');
  assert.ok(refreshToken);assert.ok(keyToken);assert.notEqual(refreshToken,keyToken);
  const postForm=(csrf,origin='null')=>localRequest(r.gatewayBase,r.root+'/settings/refresh',{method:'POST',auth:false,headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:Buffer.from(new URLSearchParams({csrf_token:csrf,key:'not-a-real-key'}).toString())});
  const beforeRequests=r.observed.length;
  assert.equal((await postForm(keyToken)).status,403,'key-form token cannot authorize catalog refresh');
  assert.equal((await postForm(refreshToken,'https://attacker.invalid')).status,403);
  assert.equal(r.observed.length,beforeRequests,'rejected manual refresh must not contact an upstream');
  r.state.deepseek.etag='"integration-ds-new-model"';
  r.state.deepseek.body={object:'list',data:[{id:'deepseek-flash',object:'model'},{id:'deepseek-official-synthetic',object:'model'}]};
  r.state.docs.etag='"integration-docs-new-model"';
  r.state.docs.body=htmlCatalog({models:[model('deepseek-flash'),model('deepseek-official-synthetic')]});
  const refreshed=await postForm(refreshToken);
  assert.equal(refreshed.status,303);assert.equal(refreshed.headers.location,r.root+'/'+(V2?'':'?refreshed=1'));
  assert.equal(fs.existsSync(path.join(r.directory,'private','deepseek-key.dpapi')),false,'manual catalog refresh must never save or update a key');
  const catalog=await localRequest(r.gatewayBase,r.gateway.prefix+'/models?client_version=0.164.0');
  assert.equal(catalog.status,200);
  assert.ok(names(catalog.json).includes('deepseek-official-synthetic'));
  assert.equal(names(catalog.json).includes('deepseek-v4-pro'),false);
  const gptBefore=counts(r.observed,'gpt-response');
  const response=await localRequest(r.gatewayBase,r.gateway.prefix+'/responses',{method:'POST',body:{model:'deepseek-official-synthetic',input:'synthetic route verification',stream:false}});
  assert.equal(response.status,200);
  const dsResponse=r.observed.filter(entry=>entry.kind==='ds-response').at(-1);
  assert.equal(dsResponse.body.model,'deepseek-official-synthetic');
  assert.equal(dsResponse.headers.authorization,'Bearer '+DS_KEY);
  assert.equal(dsResponse.headers['chatgpt-account-id'],undefined);
  assert.equal(counts(r.observed,'gpt-response'),gptBefore);
  const dsBefore=counts(r.observed,'ds-response');
  for(const modelId of ['deepseek-unknown-synthetic','deepseek-v4-pro']) {
    const denied=await localRequest(r.gatewayBase,r.gateway.prefix+'/responses',{method:'POST',body:{model:modelId,input:'synthetic denied route'}});
    assert.equal(denied.status,400);
    assert.equal(denied.json.error.code,'model_not_enabled');
  }
  assert.equal(counts(r.observed,'gpt-response'),gptBefore,'unknown or removed DeepSeek must never fall through to OpenAI');
  assert.equal(counts(r.observed,'ds-response'),dsBefore);
});
