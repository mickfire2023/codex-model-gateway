'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{once}=require('node:events');
const {WebSocket}=require('ws');const {createGateway}=require('../../gateway/gateway.cjs');
const token='synthetic_native_contract_route',model='deepseek-synthetic',endpoint='/'+token+'/backend-api/codex/responses';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(__dirname,'.native-contract-fixture-'));
  fs.writeFileSync(path.join(root,'openai-models.json'),'{"models":[]}');fs.writeFileSync(path.join(root,'deepseek-models.json'),JSON.stringify({models:[{slug:model,display_name:'Synthetic DS',visibility:'list',base_instructions:'Synthetic foreign provider instructions must not leak into custom model metadata.'}]}));
  const state={calls:[],status:200,partial:false};
  const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));state.calls.push(body);
    if(state.status!==200){res.writeHead(state.status,{'content-type':'application/json','retry-after':'91'});res.end('{"error":{"code":"model_cooldown","message":"private prompt synthetic-destination-key"}}');return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({type:'response.created',response:{id:'synthetic-current-response',object:'response',status:'in_progress',output:[]}})+'\n\n');
    res.end('data: '+JSON.stringify(state.partial?{type:'response.failed',response:{id:'synthetic-current-response',error:{message:'private prompt synthetic-destination-key'}}}:{type:'response.completed',response:{id:'synthetic-current-response',object:'response',status:'completed',output:[]}})+'\n\n');
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const credentials=new Map();const gateway=createGateway({directory:root,routeToken:token,stagingValidation:true,catalogSyncEnabled:false},{deepseekKey:'sk-synthetic-destination-key',deepseekBase:'http://127.0.0.1:'+upstream.address().port,credentialStore:{get:ref=>credentials.get(ref)||'',set:(ref,key)=>credentials.set(ref,key),delete:ref=>credentials.delete(ref)},providerRequest:async()=>({status:200,body:Buffer.from('{"object":"list","data":[{"id":"synthetic-custom"}]}')})});
  gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');const base='http://127.0.0.1:'+gateway.server.address().port;const clients=[];
  t.after(async()=>{clients.forEach(x=>x.terminate());gateway.socketRouter.close();gateway.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>gateway.server.close(r)),new Promise(r=>upstream.close(r))]);assert.ok(path.resolve(root).startsWith(path.resolve(__dirname)+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  async function client(){const ws=new WebSocket(base.replace('http:','ws:')+endpoint,{headers:{authorization:'Bearer synthetic-client-token',session_id:'synthetic-native-session'}});clients.push(ws);const queued=[],waiters=[];ws.on('message',b=>{const event=JSON.parse(b);const at=waiters.findIndex(x=>x.type===event.type);if(at<0)queued.push(event);else{const w=waiters.splice(at,1)[0];clearTimeout(w.timer);w.resolve(event);}});await once(ws,'open');return{ws,send:value=>ws.send(typeof value==='string'?value:JSON.stringify(value)),take(type){const at=queued.findIndex(x=>x.type===type);if(at>=0)return Promise.resolve(queued.splice(at,1)[0]);return new Promise((resolve,reject)=>{const w={type,resolve,timer:setTimeout(()=>reject(Error('No terminal native event')),1500)};waiters.push(w);});}};}
  const post=body=>fetch(base+endpoint,{method:'POST',headers:{authorization:'Bearer synthetic-client-token',session_id:'synthetic-native-session','content-type':'application/json'},body:JSON.stringify({model,input:'Synthetic request',stream:true,...body}),signal:AbortSignal.timeout(3000)});
  return{state,client,post,gateway};
}
test('native WebSocket prewarm completes locally and its real continuation generates exactly once',async t=>{
  const f=await fixture(t),c=await f.client(),tools=[{type:'function',name:'synthetic_check',parameters:{type:'object'}}];
  c.send({type:'response.create',model,generate:false,input:[{role:'user',content:'Synthetic warmup context'}],instructions:'Synthetic instructions',tools});
  const warm=(await c.take('response.completed')).response;assert.equal(f.state.calls.length,0);assert.match(warm.id,/^resp_gateway_warmup_/);
  c.send({type:'response.create',model,previous_response_id:warm.id,input:[{role:'user',content:'Synthetic actual request'}]});await c.take('response.completed');
  assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].input.length,2);assert.equal(f.state.calls[0].instructions,'Synthetic instructions');assert.equal(f.state.calls[0].tools[0].name,'synthetic_check');assert.equal(f.state.calls[0].generate,undefined);
});
test('WebSocket provider errors contain the HTTP status required by the real Codex parser',async t=>{
  const f=await fixture(t);f.state.status=429;const c=await f.client();c.send({type:'response.create',model,input:'Synthetic request',stream_id:'synthetic-lane'});const error=await c.take('error');
  assert.equal(error.status,429);assert.equal(error.headers['retry-after'],'91');assert.equal(error.stream_id,'synthetic-lane');assert.doesNotMatch(JSON.stringify(error),/private prompt|synthetic-destination-key|synthetic-client-token/);
  assert.equal(f.gateway.diagnostics.recentErrors[0].provider,'deepseek');assert.equal(f.gateway.diagnostics.recentErrors[0].model,model);
});
test('a malformed frame gets a terminal 400 error before a lane exists',async t=>{const f=await fixture(t),c=await f.client();c.send('{');const error=await c.take('error');assert.equal(error.status,400);assert.equal(error.error.code,'invalid_json');assert.equal(error.stream_id,undefined);});
test('HTTP streaming requests retain upstream rejection status and retry advice before any output',async t=>{
  const f=await fixture(t);f.state.status=429;const result=await f.post({});assert.equal(result.status,429);assert.equal(result.headers.get('retry-after'),'91');assert.match(result.headers.get('content-type'),/application\/json/);const body=await result.json();assert.equal(body.error.retry_after_seconds,91);assert.doesNotMatch(JSON.stringify(body),/private prompt|synthetic-destination-key/);
});
test('a failure after streaming begins is a response.failed event with the existing response ID',async t=>{
  const f=await fixture(t);f.state.partial=true;const result=await f.post({});assert.equal(result.status,200);const text=await result.text();const events=text.split(/\n\n/).flatMap(block=>{const line=block.split('\n').find(x=>x.startsWith('data: '));return line?[JSON.parse(line.slice(6))]:[];});assert.equal(events.at(-1).type,'response.failed');assert.equal(events.at(-1).response.id,'synthetic-current-response');assert.equal(events.at(-1).response.status,'failed');assert.ok(events.at(-1).sequence_number>events[0].sequence_number);assert.doesNotMatch(text,/private prompt|synthetic-destination-key/);
});
test('custom catalog instructions are provider-neutral and independent of DeepSeek metadata',async t=>{
  const f=await fixture(t);await f.gateway.providers.saveProvider({id:'synthetic-custom-provider',name:'Synthetic custom',baseUrl:'https://synthetic.invalid/v1',protocol:'responses',apiKey:'synthetic-custom-key',models:[{id:'synthetic-custom',displayName:'Synthetic custom',contextWindow:16000,maxOutputTokens:200,supportsTools:true,inputModalities:['text'],reasoningEfforts:['none']}]});const model=f.gateway.providers.catalogModels()[0];assert.match(model.base_instructions,/helpful coding assistant/);assert.equal(model.model_messages.instructions_template,model.base_instructions);assert.doesNotMatch(model.base_instructions,/foreign provider instructions/);
});

test('DeepSeek catalog exposes MCP tools directly across refresh without changing source metadata or GPT capabilities',async t=>{
  const root=fs.mkdtempSync(path.join(__dirname,'.native-contract-fixture-'));
  const metadata=slug=>({slug,display_name:slug,visibility:'list',minimal_client_version:'0.144.0',context_window:32000,input_modalities:['text','image'],supports_tools:true,supports_tool_calls:true,supports_search_tool:true,supported_reasoning_levels:[{effort:'high',description:'Synthetic high'}],default_reasoning_level:'high',apply_patch_tool_type:'function',supports_parallel_tool_calls:true,prefer_websockets:false,base_instructions:'Synthetic catalog instructions'});
  const state={gpt:{models:[metadata('gpt-synthetic-native')]},deepseek:{models:[metadata(model)]}};
  const sourceBefore=structuredClone(state);
  for(const [name,value] of [['openai-models.json',state.gpt],['deepseek-models.json',state.deepseek]])fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  const rawBefore=fs.readFileSync(path.join(root,'deepseek-models.json'),'utf8');
  const upstream=http.createServer((req,res)=>{
    if(req.url.startsWith('/gpt/models')){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(state.gpt));}
    if(req.url==='/ds/models'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({object:'list',data:state.deepseek.models.map(item=>({id:item.slug}))}));}
    if(req.url==='/docs/codex'){const escaped=JSON.stringify(state.deepseek).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');res.writeHead(200,{'content-type':'text/html'});return res.end('<pre>'+escaped+'</pre>');}
    res.writeHead(404);res.end();
  });
  let gateway;
  t.after(async()=>{
    if(gateway){gateway.socketRouter.close();gateway.server.closeAllConnections();if(gateway.server.listening)await new Promise(resolve=>gateway.server.close(resolve));}
    upstream.closeAllConnections();if(upstream.listening)await new Promise(resolve=>upstream.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(__dirname)+path.sep));fs.rmSync(root,{recursive:true,force:true});
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const sourceBase='http://127.0.0.1:'+upstream.address().port;
  gateway=createGateway({directory:root,routeToken:token,catalogSyncEnabled:true,catalogRefreshIntervalMs:3600000},{deepseekKey:'sk-synthetic-native-catalog-key',gptBase:sourceBase+'/gpt',deepseekBase:sourceBase+'/ds',deepseekDocsUrl:sourceBase+'/docs/codex',getCatalogCredentials:()=>({chatgptHeaders:{authorization:'Bearer synthetic-native-catalog-token'},deepseekKey:'sk-synthetic-native-catalog-key',clientVersion:'0.164.0',accountId:'synthetic-native-catalog-account'})});
  function checkCatalog(catalog,contextWindow){
    const ds=catalog.models.find(item=>item.slug===model),gpt=catalog.models.find(item=>item.slug==='gpt-synthetic-native');
    assert.equal(ds.supports_search_tool,false);assert.equal(gpt.supports_search_tool,true);
    assert.deepEqual(ds.input_modalities,['text','image']);assert.deepEqual(gpt.input_modalities,['text','image']);
    assert.equal(ds.supports_tools,true);assert.equal(ds.supports_tool_calls,true);assert.equal(ds.context_window,contextWindow);
  }
  checkCatalog(gateway.catalog(),32000);
  assert.deepEqual(state,sourceBefore);assert.equal(fs.readFileSync(path.join(root,'deepseek-models.json'),'utf8'),rawBefore);
  gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');await gateway.updater.refresh({force:true});
  state.deepseek.models[0].context_window=48000;
  state.gpt.models[0].description='Synthetic refreshed official metadata';
  const refreshedSource=structuredClone(state);
  await gateway.updater.refresh({force:true});
  checkCatalog(gateway.catalog(),48000);
  checkCatalog(JSON.parse(fs.readFileSync(path.join(root,'combined-models.json'),'utf8')),48000);
  assert.deepEqual(state,refreshedSource);
  const cachedDeepseek=JSON.parse(fs.readFileSync(path.join(root,'deepseek-models.json'),'utf8'));
  assert.equal(cachedDeepseek.models[0].supports_search_tool,true);assert.equal(cachedDeepseek.models[0].context_window,48000);assert.deepEqual(cachedDeepseek.models[0].input_modalities,['text','image']);
  const response=await fetch('http://127.0.0.1:'+gateway.server.address().port+'/'+token+'/backend-api/codex/models',{headers:{authorization:'Bearer synthetic-native-catalog-client'},signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);checkCatalog(await response.json(),48000);
});
