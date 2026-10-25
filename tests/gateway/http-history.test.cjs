'use strict';
// Local synthetic services and credentials only; never read real Codex auth or
// invoke a paid model. Each fixture is isolated and removed after the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {createGateway} = require('../../gateway/gateway.cjs');

const TOKEN = 'synthetic_http_history_route';
const GPT_AUTH = 'Bearer synthetic-original-gpt-authorization';
const DS_KEY = 'sk-synthetic_history_deepseek_key';
const COOKIE = 'synthetic-original-gpt-cookie';
const ENDPOINT = '/' + TOKEN + '/backend-api/codex/responses';
const input = text => ({role:'user',content:[{type:'input_text',text}]});
const output = text => ({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const texts = request => request.input.flatMap(item=>typeof item.content === 'string' ? [item.content] : (item.content || []).filter(part=>typeof part.text === 'string').map(part=>part.text));

async function exchange(base, raw) {
  return new Promise((resolve,reject)=>{
    const req = http.request(new URL(ENDPOINT,base),{method:'POST',headers:{authorization:GPT_AUTH,cookie:COOKIE,session_id:'synthetic-http-history-session','content-type':'application/json','accept-encoding':'gzip, br','content-length':raw.length}},res=>{
      const chunks = [];
      res.on('data',chunk=>chunks.push(chunk)); res.on('error',reject);
      res.on('end',()=>{
        const raw = Buffer.concat(chunks); let json;
        try { json = JSON.parse(raw.toString()); } catch {}
        resolve({status:res.statusCode,headers:res.headers,raw,json});
      });
    });
    req.on('error',reject); req.setTimeout(5000,()=>req.destroy(new Error('Synthetic HTTP test timeout'))); req.end(raw);
  });
}

async function fixture(t,mode,options={}) {
  const directory = fs.mkdtempSync(path.join(__dirname,'.http-history-mock-'));
  fs.writeFileSync(path.join(directory,'openai-models.json'),JSON.stringify({models:[{slug:'gpt-synthetic',display_name:'Synthetic GPT',visibility:'list'}]}));
  fs.writeFileSync(path.join(directory,'deepseek-models.json'),JSON.stringify({models:[{slug:'deepseek-synthetic',display_name:'Synthetic DeepSeek',visibility:'list'}]}));
  const observed = {gpt:[],deepseek:[],custom:[]},heldCustom=[];
  const gptResponse = {id:`synthetic-gpt-${mode}`,object:'response',status:'completed',model:'gpt-synthetic',output:[output('GPT 原始回答 / readable history')]};
  const dsResponse = {id:`synthetic-deepseek-${mode}`,object:'response',status:'completed',model:'deepseek-synthetic',output:[output('DeepSeek 后续回答')]};
  function serialize(response) {
    if(mode === 'json') return Buffer.from(JSON.stringify(response,null,2));
    const sse = `event: response.created\r\ndata: ${JSON.stringify({type:'response.created',response:{...response,status:'in_progress',output:[]}})}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({type:'response.completed',response})}\r\n\r\n`;
    return mode === 'gzip-sse' ? zlib.gzipSync(Buffer.from(sse)) : Buffer.from(sse);
  }
  const gptBytes = serialize(gptResponse);
  const upstream = http.createServer(async(req,res)=>{
    if(req.url === '/custom/models' && req.method === 'GET') {
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'gemini-fixture-a'},{id:'gemini-fixture-b'}]}));return;
    }
    const chunks = []; for await(const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    if(req.url === '/gpt/responses') {
      observed.gpt.push({raw,body,headers:{...req.headers}});
      const response = observed.gpt.length === 1 ? gptResponse : {...gptResponse,id:`synthetic-gpt-return-${mode}`};
      res.writeHead(200,{'content-type':mode === 'json' ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8','x-synthetic-gpt-marker':'preserve-exactly',...(mode === 'gzip-sse' ? {'content-encoding':'gzip'} : {})});
      const bytes = serialize(response);
      for(let offset=0;offset<bytes.length;offset+=11) res.write(bytes.subarray(offset,offset+11));
      res.end(); return;
    }
    if(req.url === '/ds/responses') {
      observed.deepseek.push({raw,body,headers:{...req.headers}});
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(`data: ${JSON.stringify({type:'response.completed',response:dsResponse})}\n\n`); return;
    }
    if(req.url === '/custom/responses') {
      observed.custom.push({raw,body,headers:{...req.headers}});
      const count=observed.custom.length;
      const response={id:'synthetic-custom-'+count,status:'completed',model:body.model,output:count===1 ? [
        {type:'reasoning',id:'synthetic-carrier',encrypted_content:'cpa-gemini-responses-carrier-v1:next:function:c3ludGhldGlj',summary:[]},
        {type:'function_call',id:'synthetic-function',call_id:'synthetic-native-call',name:body.tools[0].name,arguments:'{"input":"*** Begin Patch\\n*** End Patch"}',status:'completed'}
      ] : [output('Synthetic custom continuation')]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      const event=`data: ${JSON.stringify({type:'response.completed',response})}\n\n`;
      if(options.holdCustomEOF&&count===1) {res.write(event);heldCustom.push(res);return;}
      res.end(event);return;
    }
    res.writeHead(404); res.end();
  });
  upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const credentialData=new Map();
  const gateway = createGateway({directory,routeToken:TOKEN,catalogSyncEnabled:false,stagingValidation:true},{
    deepseekKey:DS_KEY,gptBase:upstreamBase+'/gpt',deepseekBase:upstreamBase+'/ds',
    credentialStore:options.custom ? {get:ref=>credentialData.get(ref)||'',set:(ref,key)=>credentialData.set(ref,key),delete:ref=>credentialData.delete(ref)} : {get:()=>'',set:()=>{ throw new Error('Unexpected credential persistence'); },delete:()=>{}},
    getCatalogCredentials:()=>({chatgptHeaders:{authorization:GPT_AUTH},deepseekKey:DS_KEY,accountId:'synthetic-account'})
  });
  gateway.server.listen(0,'127.0.0.1'); await once(gateway.server,'listening');
  t.after(async()=>{
    gateway.socketRouter.close(); gateway.server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve=>gateway.server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(__dirname)+path.sep) && path.basename(resolved).startsWith('.http-history-mock-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return {base:`http://127.0.0.1:${gateway.server.address().port}`,upstreamBase,gateway,observed,gptBytes,gptResponse,dsResponse,heldCustom};
}

for(const stream of [false,true]) test(`HTTP custom Responses stream=${stream}: signed custom tool replays only on the same model/credential`,async t=>{
  const f=await fixture(t,'json',{custom:true});
  const model=id=>({id,displayName:id,contextWindow:32768,maxOutputTokens:400,inputModalities:['text'],supportsTools:true,reasoningEfforts:['none'],preserveOpaqueReasoning:true});
  const provider={id:'subscription',name:'Synthetic subscription',baseUrl:f.upstreamBase+'/custom',protocol:'responses',apiKey:'synthetic-local-proxy-key',opaqueReasoningIdentity:'a'.repeat(64),models:[model('gemini-fixture-a'),model('gemini-fixture-b')]};
  const saved=await f.gateway.providers.saveProvider(provider),slug=saved.models[0].slug;
  const tools=[{type:'custom',name:'apply_patch',namespace:'workspace'}];
  const responseOf=exchange=>exchange.json || exchange.raw.toString().split(/\r?\n/).filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==='response.completed')?.response;
  const send=body=>exchange(f.base,Buffer.from(JSON.stringify({...body,stream})));
  const firstResult=await send({model:slug,input:[input('synthetic patch')],tools});assert.equal(firstResult.status,200,firstResult.raw.toString());
  const first=responseOf(firstResult);assert.equal(first.output[1].type,'custom_tool_call');assert.equal(first.output[1].namespace,'workspace');
  const carrier=first.output[0];
  const next={model:slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:'synthetic-native-call',output:'fixture patch applied'}],tools};
  const secondResult=await send(next);assert.equal(secondResult.status,200,secondResult.raw.toString());const second=responseOf(secondResult);
  assert.deepEqual(f.observed.custom[1].body.input[1],carrier);
  assert.equal(f.observed.custom[1].body.input.at(-1).type,'function_call_output');
  assert.equal(f.observed.custom[1].body.input.at(-1).output,'fixture patch applied');
  assert.equal(f.observed.custom[1].headers.authorization,'Bearer synthetic-local-proxy-key');
  assert.equal(f.observed.custom[1].headers.cookie,undefined);
  assert.ok(!f.observed.custom[1].raw.includes(Buffer.from(GPT_AUTH)));
  assert.ok(!JSON.stringify(f.observed.custom[1].body).includes(f.gateway.providers.routeBySlug(slug).historyScope));
  const third=await send({model:saved.models[1].slug,previous_response_id:second.id,input:[input('switch model')],tools});assert.equal(third.status,200,third.raw.toString());
  assert.ok(!f.observed.custom[2].raw.includes(Buffer.from(carrier.encrypted_content)));
  await f.gateway.providers.saveProvider(provider);
  const fourth=await send({...next,input:[input('credential replaced')]});assert.equal(fourth.status,200,fourth.raw.toString());
  assert.ok(!f.observed.custom[3].raw.includes(Buffer.from(carrier.encrypted_content)));
  const gpt=await exchange(f.base,Buffer.from(JSON.stringify({model:'gpt-synthetic',previous_response_id:second.id,input:[input('return GPT')],stream:false})));assert.equal(gpt.status,200,gpt.raw.toString());
  assert.ok(!f.observed.gpt[0].raw.includes(Buffer.from(carrier.encrypted_content)));
});

test('HTTP custom terminal event commits signed history before a client tool reply, even while upstream SSE remains open',async t=>{
  const f=await fixture(t,'json',{custom:true,holdCustomEOF:true});
  let remembers=0;const originalRemember=f.gateway.socketRouter.history.remember;
  f.gateway.socketRouter.history.remember=(...args)=>{remembers++;return originalRemember(...args);};
  const saved=await f.gateway.providers.saveProvider({id:'subscription',name:'Synthetic subscription',baseUrl:f.upstreamBase+'/custom',protocol:'responses',apiKey:'synthetic-local-proxy-key',opaqueReasoningIdentity:'a'.repeat(64),models:[{id:'gemini-fixture-a',displayName:'Synthetic Gemini',contextWindow:32768,maxOutputTokens:400,inputModalities:['text'],supportsTools:true,reasoningEfforts:['none'],preserveOpaqueReasoning:true}]});
  const slug=saved.models[0].slug,tools=[{type:'custom',name:'apply_patch',namespace:'workspace'}];
  const raw=Buffer.from(JSON.stringify({model:slug,input:[input('synthetic patch')],tools,stream:true}));
  let firstResponse;
  const first=await new Promise((resolve,reject)=>{
    const req=http.request(new URL(ENDPOINT,f.base),{method:'POST',headers:{authorization:GPT_AUTH,session_id:'synthetic-http-history-session','content-type':'application/json','content-length':raw.length}},res=>{
      firstResponse=res;let pending='';
      res.on('data',chunk=>{pending+=chunk.toString();for(const block of pending.split(/\r?\n\r?\n/)){const line=block.split(/\r?\n/).find(line=>line.startsWith('data: '));if(!line)continue;let event;try{event=JSON.parse(line.slice(6));}catch{continue;}if(event.type==='response.completed')resolve(event.response);}});
      res.on('error',reject);
    });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Synthetic delayed EOF test timeout')));req.end(raw);
  });
  assert.equal(f.heldCustom.length,1);assert.equal(f.heldCustom[0].writableEnded,false);
  const followup=await exchange(f.base,Buffer.from(JSON.stringify({model:slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:'synthetic-native-call',output:'applied before EOF'}],tools,stream:false})));
  assert.equal(followup.status,200,followup.raw.toString());
  assert.deepEqual(f.observed.custom[1].body.input[1],first.output[0]);
  assert.equal(f.observed.custom[1].body.input.at(-1).output,'applied before EOF');
  assert.equal(f.gateway.socketRouter.history.size,2,'one entry for each terminal response');
  assert.equal(remembers,2,'each response is committed once before EOF');
  const firstEnded=once(firstResponse,'end');f.heldCustom[0].end();await firstEnded;
  assert.equal(f.gateway.socketRouter.history.size,2,'upstream EOF does not duplicate a completed history entry');
  assert.equal(remembers,2,'EOF does not commit terminal responses again');
});

for(const mode of ['json','identity-sse','gzip-sse']) {
  test(`HTTP ${mode}: GPT bytes stay unchanged and GPT → DeepSeek → GPT replays readable history`,async t=>{
    const f = await fixture(t,mode);
    // Deliberate whitespace proves that untouched GPT requests retain their
    // original wire bytes rather than being parsed and reserialized.
    const originalBytes = Buffer.from(' \r\n'+JSON.stringify({model:'gpt-synthetic',input:[input('最初的用户目标')],stream:mode !== 'json'},null,2)+'\r\n');
    const first = await exchange(f.base,originalBytes);
    assert.equal(first.status,200);
    assert.deepEqual(first.raw,f.gptBytes,'GPT response body must remain byte-for-byte identical');
    assert.deepEqual(f.observed.gpt[0].raw,originalBytes,'GPT request body must remain byte-for-byte identical');
    assert.equal(first.headers['x-synthetic-gpt-marker'],'preserve-exactly');
    assert.equal(first.headers['content-encoding'],mode === 'gzip-sse' ? 'gzip' : undefined);
    assert.equal(f.observed.gpt[0].headers.authorization,GPT_AUTH);
    assert.equal(f.observed.gpt[0].headers.cookie,COOKIE);
    assert.equal(f.gateway.socketRouter.history.size,1);

    const second = await exchange(f.base,Buffer.from(JSON.stringify({model:'deepseek-synthetic',previous_response_id:f.gptResponse.id,input:[input('切换后的用户请求')],stream:false})));
    assert.equal(second.status,200,second.raw.toString());
    assert.equal(second.json.id,f.dsResponse.id);
    assert.equal(f.observed.deepseek.length,1);
    assert.equal(f.observed.deepseek[0].body.previous_response_id,undefined);
    assert.deepEqual(texts(f.observed.deepseek[0].body),['最初的用户目标','GPT 原始回答 / readable history','切换后的用户请求']);
    assert.equal(f.observed.deepseek[0].headers.authorization,`Bearer ${DS_KEY}`);
    assert.equal(f.observed.deepseek[0].headers.cookie,undefined);
    assert.equal(f.observed.deepseek[0].headers['chatgpt-account-id'],undefined);

    const third = await exchange(f.base,Buffer.from(JSON.stringify({model:'gpt-synthetic',previous_response_id:f.dsResponse.id,input:[input('切回 GPT 后继续')],stream:mode !== 'json'})));
    assert.equal(third.status,200);
    assert.equal(f.observed.gpt.length,2);
    assert.equal(f.observed.gpt[1].body.previous_response_id,undefined);
    assert.deepEqual(texts(f.observed.gpt[1].body),['最初的用户目标','GPT 原始回答 / readable history','切换后的用户请求','DeepSeek 后续回答','切回 GPT 后继续']);
    assert.equal(f.observed.gpt[1].headers.authorization,GPT_AUTH);
    assert.equal(f.observed.gpt[1].headers.cookie,COOKIE);
    assert.equal(f.gateway.socketRouter.history.size,3);
  });
}
