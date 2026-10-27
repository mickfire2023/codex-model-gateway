'use strict';
// Synthetic protocol envelopes only. No live credentials or inference calls.
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAdapter}=require('../../gateway/deepseek-adapter.cjs');
const {createHistoryStore}=require('../../gateway/socket-router.cjs');
const {createProviderRunner}=require('../../gateway/provider-runner.cjs');
const {ANTIGRAVITY_CLAUDE_REASONING_FORMAT:FORMAT,isGeminiReasoningCarrier,isAntigravityClaudeReasoningCarrier,decodeAntigravityClaudeReasoningCarrier,opaqueReasoningKey}=require('../../gateway/reasoning-carriers.cjs');

const user=text=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const varint=number=>{const bytes=[];do{const next=number%128;number=Math.floor(number/128);bytes.push(next+(number?128:0));}while(number);return Buffer.from(bytes);};
const bytes=(number,value)=>Buffer.concat([varint(number*8+2),varint(value.length),value]);
const integer=(number,value)=>Buffer.concat([varint(number*8),varint(value)]);
function signature(form='R',overrides={}){
  const channel=Buffer.concat([integer(1,overrides.channel??(form==='Q'?18:12)),integer(2,overrides.infra??2),
    form==='Q'?bytes(8,Buffer.from(overrides.blockKind??'thinking')):bytes(6,Buffer.from('claude-synthetic'))]);
  const container=Buffer.concat([bytes(1,channel),...(overrides.duplicateChannel?[bytes(1,channel)]:[]),...(form==='Q'?[bytes(5,Buffer.alloc(overrides.signatureLength??64,7))]:[])]);
  const payload=Buffer.concat([...(form==='Q'?[integer(1,overrides.envelopeVersion??4)]:[]),bytes(2,container),...(overrides.duplicateContainer?[bytes(2,container)]:[]),integer(3,1)]);
  const inner=payload.toString('base64');
  return form==='E'?inner:Buffer.from(inner).toString('base64');
}
function carrier(raw=signature(),extra={}){
  return {type:'reasoning',id:'rs_synthetic',encrypted_content:'cpa-gemini-responses-carrier-v1:standalone:text:'+Buffer.from(raw).toString('base64').replace(/=+$/,''),summary:[{type:'summary_text',text:'Synthetic signed thinking.'}],...extra};
}
const opts={preserveOpaqueReasoning:true,opaqueReasoningFormat:FORMAT,preserveApplyPatch:false,normalizeReasoning:false,strictCustomWrappers:true};
const serialized=value=>JSON.stringify(value);
const scope='a'.repeat(64),slug='custom/gemini-subscription/claude-synthetic';
const context=extra=>({provider:'custom:gemini-subscription',preserveOpaqueReasoning:true,historyScope:scope,lane:'one',headers:{authorization:'Bearer synthetic-login','x-codex-session-id':'synthetic-session'},...extra});

for(const form of ['E','R','Q'])test('Claude '+form+' carrier unwraps only in the explicit Claude dispatch adapter',()=>{
  const raw=signature(form),item=carrier(raw,{content:[{type:'reasoning_text',text:'Synthetic signed content.'}]}),input={model:slug,input:[item,user('next')]};
  assert.ok(isGeminiReasoningCarrier(item));assert.ok(isAntigravityClaudeReasoningCarrier(item));
  assert.equal(decodeAntigravityClaudeReasoningCarrier(item),raw);
  const adapted=createAdapter(input,opts).body;
  assert.deepEqual(adapted.input[0],{...item,encrypted_content:raw});
  assert.equal(input.input[0].encrypted_content,item.encrypted_content,'client history keeps its marked carrier');
  for(const options of [{},{preserveOpaqueReasoning:true},{...opts,preserveOpaqueReasoning:false}]){
    const result=createAdapter(input,options).body;
    assert.ok(!serialized(result).includes(item.encrypted_content));
    assert.ok(!serialized(result).includes('Synthetic signed thinking.'));
    assert.ok(!serialized(result).includes('Synthetic signed content.'));
  }
  assert.equal(createAdapter({...input,input:[{...item,encrypted_content:raw}]},opts).body.input.length,0,'raw signatures never grant provenance');
});

test('Claude dispatch rejects Gemini, malformed, nested and empty-summary carriers',()=>{
  const gemini='EjQKMgEMOdbHO0Gd+c9Mxk4ELwPGbpCEcp2mFfYYLix2UVtBH3fL8GECc4+JITVnHF4qZDsA';
  const marked=carrier();
  const rejected=[carrier(gemini),carrier('gAAAA-synthetic-openai'),carrier('skip_thought_signature_validator'),
    carrier('E!'),carrier('RA=='),carrier(signature('Q',{channel:17})),carrier(signature('Q',{channel:20})),
    ...[{channel:19,infra:1},{channel:19,envelopeVersion:3},{channel:19,blockKind:'narration'},
      {channel:19,signatureLength:0},{channel:19,duplicateContainer:true},{channel:19,duplicateChannel:true}].map(shape=>carrier(signature('Q',shape))),
    carrier(marked.encrypted_content),
    carrier(signature(),{summary:[]}),carrier(signature(),{summary:[{type:'summary_text',text:'  '}]}),
    carrier(signature(),{summary:[{type:'reasoning_text',text:'wrong summary part'}]}),
    {...marked,encrypted_content:marked.encrypted_content+'='},
    {...marked,encrypted_content:marked.encrypted_content.replace(/:standalone:text:/,':future:text:')},
    {...marked,encrypted_content:'cpa-gemini-responses-carrier-v1:standalone:text:A'},
    {...marked,encrypted_content:marked.encrypted_content+'A'.repeat(1024*1024)}];
  for(const item of rejected){
    assert.equal(decodeAntigravityClaudeReasoningCarrier(item),undefined);
    assert.deepEqual(createAdapter({model:slug,input:[item,user('visible')]},opts).body.input,[user('visible')]);
  }
  const ordinaryGemini={type:'reasoning',encrypted_content:'cpa-gemini-responses-carrier-v1:next:function:c3ludGhldGlj',summary:[]};
  assert.deepEqual(createAdapter({input:[ordinaryGemini]},{preserveOpaqueReasoning:true}).body.input,[ordinaryGemini],'existing Gemini carrier behavior is unchanged');
});

test('observed Google version-4 channel 19 stays replayable only with issued provenance',()=>{
  const raw=signature('Q',{channel:19}),item=carrier(raw),history=createHistoryStore();
  assert.ok(isAntigravityClaudeReasoningCarrier(item));
  assert.equal(decodeAntigravityClaudeReasoningCarrier(item),raw);
  const request={model:slug,input:[user('start')]},resolved=history.resolve(request,context());
  history.remember(request,{id:'channel19',output:[item]},context({resolved}));
  const trusted=history.resolve({model:slug,previous_response_id:'channel19',input:[user('continue')]},context());
  const body=createAdapter(trusted.request,opts).body;
  assert.equal(body.input.find(x=>x.type==='reasoning').encrypted_content,raw);
  for(const override of [{historyScope:'b'.repeat(64)},{provider:'deepseek',preserveOpaqueReasoning:false},{provider:'custom:other'}]){
    const foreign=history.resolve({model:slug,input:[item,user('continue')]},context(override));
    assert.deepEqual(foreign.request.input,[user('continue')]);
  }
});

test('history provenance binds encrypted content and signed summary/content while ignoring id/status and object key order',()=>{
  const item=carrier(signature(),{content:[{type:'reasoning_text',text:'Synthetic signed content.'}]}),history=createHistoryStore();
  const initial={model:slug,input:[user('start')]};
  history.remember(initial,{id:'issued',output:[item]},context());
  const normalized={...item,id:'client-normalized-id',status:'completed',summary:[{text:item.summary[0].text,type:'summary_text'}],content:[{text:item.content[0].text,type:'reasoning_text'}]};
  assert.equal(opaqueReasoningKey(normalized),opaqueReasoningKey(item));
  assert.equal(history.resolve({model:slug,input:[normalized]},context()).request.input[0].encrypted_content,item.encrypted_content);
  for(const altered of [{...item,summary:[{type:'summary_text',text:'Changed thinking.'}]},{...item,summary:[]},
    {...item,content:[{type:'reasoning_text',text:'Changed content.'}]},{...item,content:undefined}]){
    const resolved=history.resolve({model:slug,input:[altered]},context());
    assert.ok(!serialized(resolved.request).includes(item.encrypted_content));
    assert.equal(createAdapter(resolved.request,opts).body.input.length,0);
  }
  const pending=history.resolve({model:slug,input:[carrier(signature('E'))]},context());
  assert.ok(!serialized(pending.request).includes(carrier(signature('E')).encrypted_content),'unobserved signatures stay untrusted');
});

test('issued Claude carriers stay isolated by model/account/credential/session/lane and never migrate to GPT or Gemini',()=>{
  const history=createHistoryStore(),item=carrier(),initial={model:slug,input:[user('start')]};
  history.remember(initial,{id:'issued',output:[item]},context());
  for(const override of [{historyScope:'b'.repeat(64)},{preserveOpaqueReasoning:false},{provider:'custom:other'},
    {provider:'deepseek'},{provider:'openai'},{lane:'other'},{headers:{authorization:'Bearer synthetic-other','x-codex-session-id':'synthetic-session'}},
    {headers:{authorization:'Bearer synthetic-login','x-codex-session-id':'other-session'}}]){
    const resolved=history.resolve({model:slug,input:[item,user('continue')]},context(override));
    assert.ok(!serialized(resolved.request).includes(item.encrypted_content));
  }
  const otherModel=history.resolve({model:'custom/gemini-subscription/gemini-synthetic',input:[item]},context({historyScope:'c'.repeat(64)}));
  assert.ok(!serialized(otherModel.request).includes(item.encrypted_content));
  assert.equal(createAdapter({input:[item]},{preserveOpaqueReasoning:true,normalizeReasoning:false}).body.input.length,0,'Gemini dispatch rejects Claude signatures even if a caller supplies the marker');
  const gpt=history.resolve({model:'gpt-synthetic',input:[item]},context({provider:'openai',preserveOpaqueReasoning:false,historyScope:undefined}));
  assert.deepEqual(gpt.request.input,[]);
});

test('history migration drops untrusted Claude thinking text with its carrier before another adapter sees it',()=>{
  const item=carrier(signature(),{content:[{type:'reasoning_text',text:'Synthetic private Claude thinking.'}]}),history=createHistoryStore();
  history.remember({model:slug,input:[user('start')]},{id:'issued-thinking',output:[item]},context());
  const migrations=[
    {model:'deepseek-chat',extra:{provider:'deepseek',preserveOpaqueReasoning:false,historyScope:undefined}},
    {model:'custom/other/response',extra:{provider:'custom:other',historyScope:'b'.repeat(64)}},
    {model:'custom/gemini-subscription/gemini-synthetic',extra:{historyScope:'c'.repeat(64)}},
    {model:slug,extra:{historyScope:'d'.repeat(64)}},
    {model:slug,extra:{headers:{authorization:'Bearer synthetic-other','x-codex-session-id':'synthetic-session'}}},
    {model:slug,extra:{headers:{authorization:'Bearer synthetic-login','x-codex-session-id':'other-session'}}},
    {model:slug,extra:{lane:'other'}}
  ];
  for(const {model,extra} of migrations){
    const resolved=history.resolve({model,input:[item,user('continue')]},context(extra));
    assert.deepEqual(resolved.request.input,[user('continue')]);
    const body=createAdapter(resolved.request,{preserveOpaqueReasoning:true,normalizeReasoning:false}).body;
    assert.deepEqual(body.input,[user('continue')]);
    assert.doesNotMatch(serialized(body),/Synthetic private Claude thinking|Synthetic signed thinking|cpa-gemini-responses-carrier/);
  }
  // DeepSeek's readable reasoning has no private carrier and remains portable.
  const readable={type:'reasoning',content:[{type:'reasoning_text',text:'Synthetic readable reasoning.'}]};
  const resolved=history.resolve({model:'deepseek-chat',input:[readable]},context({provider:'deepseek',preserveOpaqueReasoning:false,historyScope:undefined}));
  assert.deepEqual(createAdapter(resolved.request).body.input,[readable]);
});

function runnerFixture({unauthorized=false}={}){
  const requests=[],logs=[];let counter=0;
  const item=carrier(),target={providerId:'gemini-subscription',modelId:'claude-synthetic',protocol:'responses',
    url:new URL('http://127.0.0.1:18317/v1/responses'),headers:{authorization:'Bearer synthetic-upstream-key'},
    preserveOpaqueReasoning:true,historyScope:scope,model:{inputModalities:['text'],supportsTools:true,reasoningEfforts:['none','high'],defaultReasoningEffort:'high',maxOutputTokens:4096}};
  const runner=createProviderRunner({providers:{upstreamForSlug:()=>target},secret:'synthetic-secret',deepseekBase:'',getDeepseekKey:()=>'',log:entry=>logs.push(entry),
    readBody:async()=>Buffer.from('synthetic-private-error-body'),requestUpstream:async(url,options,payload)=>{
      const body=JSON.parse(payload);requests.push(body);counter++;
      const output=counter===1?[item,{type:'function_call',id:'fc_synthetic',call_id:'call_synthetic',name:body.tools[0].name,arguments:'{"input":"*** Begin Patch\\n*** End Patch"}',status:'completed'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic tool result accepted.'}]}];
      return {statusCode:unauthorized?401:200,frames:[{type:'response.completed',response:{id:'synthetic-'+counter,status:'completed',output}}]};
    },events:async function*(upstream){yield*upstream.frames;}});
  return {runner,requests,logs,item,target};
}

test('Claude Responses runner/history round trip unwraps only issued signed thinking and preserves custom tool results',async()=>{
  const f=runnerFixture(),history=createHistoryStore();
  const initial={model:slug,input:[user('Synthetic tool check.')],tools:[{type:'custom',name:'apply_patch',namespace:'synthetic'}],reasoning:{effort:'high'}};
  const firstResolved=history.resolve(initial,context());
  const first=await f.runner.run({route:{provider:'custom:gemini-subscription'},request:firstResolved.request,historyScope:firstResolved.opaqueReasoningScope});
  assert.equal(first.output[0].encrypted_content,f.item.encrypted_content,'client response keeps the CPA marker');
  assert.equal(first.output[1].type,'custom_tool_call');assert.equal(first.output[1].namespace,'synthetic');
  history.remember(initial,first,context({resolved:firstResolved}));
  const next={model:slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:'call_synthetic',output:'Synthetic tool marker.'}],tools:initial.tools,reasoning:{effort:'high'}};
  const resolved=history.resolve(next,context());
  await f.runner.run({route:{provider:'custom:gemini-subscription'},request:resolved.request,historyScope:resolved.opaqueReasoningScope});
  const signed=f.requests[1].input.find(item=>item.type==='reasoning');
  assert.deepEqual(signed,{...f.item,encrypted_content:signature()});
  assert.equal(f.requests[1].input.at(-1).type,'function_call_output');
  assert.equal(f.requests[1].input.at(-1).output,'Synthetic tool marker.');
  await f.runner.run({route:{provider:'custom:gemini-subscription'},request:resolved.request});
  assert.equal(f.requests[2].input.some(item=>item.type==='reasoning'),false,'missing provenance blocks dispatch');
  f.target.historyScope='b'.repeat(64);
  await f.runner.run({route:{provider:'custom:gemini-subscription'},request:resolved.request,historyScope:resolved.opaqueReasoningScope});
  assert.equal(f.requests[3].input.some(item=>item.type==='reasoning'),false,'credential/account/model scope changes block dispatch');
  assert.doesNotMatch(serialized(f.logs),/Synthetic signed thinking|cpa-gemini|synthetic-upstream-key|synthetic-login/);
  assert.ok(!serialized(f.requests).includes(scope));
});

test('a Claude candidate 401 makes one request, exposes no upstream body and issues no trusted history',async()=>{
  const f=runnerFixture({unauthorized:true}),history=createHistoryStore(),request={model:slug,input:[user('Synthetic request.')],tools:[{type:'function',name:'check',parameters:{type:'object'}}]};
  const resolved=history.resolve(request,context());
  await assert.rejects(f.runner.run({route:{provider:'custom:gemini-subscription'},request:resolved.request,historyScope:resolved.opaqueReasoningScope}),
    error=>error.status===401&&error.code==='provider_http_error'&&!error.message.includes('synthetic-private'));
  assert.equal(f.requests.length,1);assert.equal(history.size,0);
  assert.ok(!serialized(history.resolve({model:slug,input:[f.item]},context()).request).includes(f.item.encrypted_content));
});
