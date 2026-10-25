'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {createToolProbe}=require('../../gateway/gemini-updater.cjs');
const {events}=require('../../gateway/gateway.cjs');
const KEY='synthetic-local-probe-key';
const IDENTITY='a'.repeat(64);
const CARRIER='cpa-gemini-responses-carrier-v1:next:function:c3ludGhldGlj';
const PRIVATE='synthetic-openai-private-reasoning-must-not-migrate';
const PATCH='*** Begin Patch\n*** End Patch';
const MODEL={id:'gemini-synthetic-high',displayName:'Synthetic Gemini',contextWindow:32768,maxOutputTokens:512,inputModalities:['text'],supportsTools:true,reasoningEfforts:['high'],defaultReasoningEffort:'high',preserveOpaqueReasoning:true};

async function fixture(t,{mode='valid',httpStatus=503}={}){
  const observed={requests:[],logs:[],transport:0},intervals=new Set();
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);
    observed.requests.push({headers:{...req.headers},body,raw});
    const index=observed.requests.length;
    if(mode==='http_error'){res.writeHead(httpStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:KEY+' '+PRIVATE}}));return;}
    if(mode==='hang'){
      res.writeHead(200,{'content-type':'text/event-stream'});res.write(': waiting\n\n');
      const interval=setInterval(()=>res.write(': still waiting\n\n'),10);intervals.add(interval);res.on('close',()=>{clearInterval(interval);intervals.delete(interval);});return;
    }
    let output,status='completed';
    if(index===1){
      const call={type:'function_call',id:'synthetic-call-item',call_id:'synthetic-call-id',name:mode==='wrong_tool'?'unrelated_function':body.tools[0].name,arguments:mode==='invalid_wrapper'?'{"input":42}':JSON.stringify({input:PATCH}),status:'completed'};
      const carrier={type:'reasoning',id:'synthetic-carrier',summary:[],encrypted_content:mode==='unsupported_carrier'?'cpa-gemini-responses-carrier-v1:next:function:!!!!':CARRIER};
      output=mode==='empty'?[]:mode==='missing_carrier'?[call]:[carrier,{type:'reasoning',id:'synthetic-foreign-opaque',summary:[],encrypted_content:PRIVATE},call];
      if(mode==='incomplete')status='incomplete';
      if(mode==='duplicate_tools')output.push({...call,id:'synthetic-second-call-item',call_id:'synthetic-second-call-id'});
    }else{
      const result=body.input.find(item=>item.type==='function_call_output');
      const marker=String(result?.output||'').match(/Marker: (gemini-auto-[a-f0-9]{16})/)?.[1]||'missing-marker';
      output=[{type:'message',id:'synthetic-answer',role:'assistant',status:'completed',content:[{type:'output_text',text:mode==='wrong_result'?'synthetic wrong result':'检查通过 '+marker}]}];
    }
    const response={id:'synthetic-response-'+index,object:'response',model:body.model,status,output};
    const frames=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:status==='completed'?'response.completed':'response.incomplete',response}];
    res.writeHead(200,{'content-type':'text/event-stream'});
    const payload=Buffer.from(frames.map(frame=>'event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n').join(''));
    // Deliberately split UTF-8 and JSON across small streaming writes.
    for(let offset=0;offset<payload.length;offset+=13)res.write(payload.subarray(offset,offset+13));
    res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const interval of intervals)clearInterval(interval);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const target={providerId:'gemini-subscription',baseUrl,protocol:'responses',accountIdentity:IDENTITY};
  Object.defineProperty(target,'headers',{value:Object.freeze({authorization:'Bearer '+KEY,'content-type':'application/json',accept:'text/event-stream'})});
  const probe=createToolProbe({
    requestUpstream:async(url,options,payload)=>{
      observed.transport++;
      assert.equal(url.href,baseUrl+'/responses');
      return new Promise((resolve,reject)=>{const request=http.request(url,options,resolve);request.once('error',reject);request.end(payload);});
    },
    readBody:async response=>{const chunks=[];for await(const chunk of response)chunks.push(chunk);return Buffer.concat(chunks);},events,
    log:value=>observed.logs.push(value)
  });
  return {target,observed,probe:extra=>probe({model:MODEL,target,accountIdentity:IDENTITY,...extra})};
}

test('real HTTP/SSE probe completes two native turns, preserving a known Gemini carrier and wrapped tool result',async t=>{
  const f=await fixture(t);assert.equal(Object.keys(f.target).includes('headers'),false);
  const result=await f.probe();assert.deepEqual(result,{toolCall:true,toolResult:true,signatureCarrier:true});
  assert.equal(f.observed.transport,2);assert.equal(f.observed.requests.length,2);
  const [first,next]=f.observed.requests;
  assert.equal(first.body.model,MODEL.id);assert.equal(first.body.tools.length,1);assert.equal(first.body.tools[0].type,'function');
  assert.equal(first.body.tools[0].parameters.properties.input.type,'string');assert.deepEqual(first.body.tools[0].parameters.required,['input']);
  assert.equal(first.body.tool_choice.type,'function');assert.equal(first.body.tool_choice.name,first.body.tools[0].name);
  assert.ok(first.body.tools[0].name.length<=64);assert.equal(first.body.max_output_tokens,512);
  assert.equal(next.body.previous_response_id,undefined);
  assert.equal(next.body.input.find(item=>item.type==='reasoning').encrypted_content,CARRIER);
  assert.equal(next.body.input.some(item=>item.encrypted_content===PRIVATE),false);
  const call=next.body.input.find(item=>item.type==='function_call');assert.equal(call.call_id,'synthetic-call-id');assert.equal(call.name,first.body.tools[0].name);assert.deepEqual(JSON.parse(call.arguments),{input:PATCH});
  const toolResult=next.body.input.find(item=>item.type==='function_call_output');assert.match(toolResult.output,/Marker: gemini-auto-[a-f0-9]{16}/);
  for(const request of f.observed.requests){assert.equal(request.headers.authorization,'Bearer '+KEY);assert.equal(request.headers.cookie,undefined);assert.equal(request.headers['chatgpt-account-id'],undefined);assert.ok(!request.raw.includes(KEY));assert.ok(!request.raw.includes(IDENTITY));assert.ok(!request.raw.includes('historyScope'));}
  assert.deepEqual(f.observed.logs,[]);assert.ok(!JSON.stringify(result).includes(KEY));assert.ok(!JSON.stringify(result).includes(CARRIER));
});
for(const mode of ['empty','wrong_tool','duplicate_tools','incomplete'])test('probe rejects '+mode+' tool output before a second generation',async t=>{const f=await fixture(t,{mode});await assert.rejects(f.probe(),error=>error.code==='gemini_probe_tool_incompatible');assert.equal(f.observed.transport,1);assert.equal(f.observed.requests.length,1);assert.deepEqual(f.observed.logs,[]);});
test('a malformed custom wrapper is rejected without another request',async t=>{const f=await fixture(t,{mode:'invalid_wrapper'});await assert.rejects(f.probe(),error=>error.code==='invalid_tool_call');assert.equal(f.observed.transport,1);});
for(const mode of ['missing_carrier','unsupported_carrier'])test('probe rejects '+mode+' instead of relying on a warm upstream signature cache',async t=>{const f=await fixture(t,{mode});await assert.rejects(f.probe(),error=>error.code==='gemini_probe_signature_missing');assert.equal(f.observed.transport,1);});
test('the second turn must actually preserve the synthetic tool marker',async t=>{const f=await fixture(t,{mode:'wrong_result'});await assert.rejects(f.probe(),error=>error.code==='gemini_probe_continuation_failed');assert.equal(f.observed.transport,2);});
for(const httpStatus of [401,429,503])test('upstream HTTP '+httpStatus+' is never retried and its private error body is not exposed',async t=>{const f=await fixture(t,{mode:'http_error',httpStatus});await assert.rejects(f.probe(),error=>{assert.equal(error.status,httpStatus);assert.ok(!error.message.includes(KEY));assert.ok(!error.message.includes(PRIVATE));return true;});assert.equal(f.observed.transport,1);assert.deepEqual(f.observed.logs,[]);});
test('an aborted hanging stream closes promptly without retry or logging the upstream content',async t=>{const f=await fixture(t,{mode:'hang'});const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),75);const began=Date.now();try{await assert.rejects(f.probe({signal:controller.signal}),error=>{assert.ok(!error.message.includes(KEY));assert.ok(!error.message.includes(PRIVATE));return true;});assert.ok(Date.now()-began<1000);assert.equal(f.observed.transport,1);assert.deepEqual(f.observed.logs,[]);}finally{clearTimeout(timer);}});
test('a remote, ambiguous, or malformed endpoint is rejected before credentials reach transport',async()=>{
  let calls=0;const probe=createToolProbe({requestUpstream:async()=>{calls++;throw new Error('Transport must not run');},readBody:async()=>Buffer.alloc(0),events:async function*(){}});
  for(const baseUrl of ['https://untrusted.invalid/v1','http://localhost:8317/v1','http://127.0.0.1:0/v1','http://127.0.0.1:65536/v1','http://127.0.0.1:8317/v1?secret=x','http://127.0.0.1:8317/v1#fragment','http://user:password@127.0.0.1:8317/v1','http://127.0.0.1:8317/not-v1'])await assert.rejects(probe({model:MODEL,target:{baseUrl,headers:{authorization:'Bearer '+KEY}},accountIdentity:IDENTITY}),error=>error.code==='gemini_probe_endpoint_invalid');
  assert.equal(calls,0);
});
