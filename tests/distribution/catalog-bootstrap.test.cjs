'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {catalogs}=require('../../bridge/validate.cjs');
const sourceDirectory=path.resolve(__dirname,'../../gateway');
function fixture(t){const root=fs.mkdtempSync(path.join(__dirname,'.bootstrap-fixture-'));fs.mkdirSync(path.join(root,'private/auth'),{recursive:true});fs.writeFileSync(path.join(root,'private/auth/synthetic.json'),JSON.stringify({type:'antigravity',email:'synthetic@example.invalid',project_id:'synthetic-project'}));fs.writeFileSync(path.join(root,'private/control.json'),JSON.stringify({apiKey:'a'.repeat(64)}));fs.writeFileSync(path.join(root,'bridge.json'),JSON.stringify({product:'CodexGeminiBridge',port:8317}));t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(__dirname)+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
const row=(id,outputs=['text'])=>({name:'models/'+id,supportedInputModalities:['text'],supportedOutputModalities:outputs,inputTokenLimit:32000,outputTokenLimit:4000});
test('initial Gemini setup discovers future model IDs and uses each declared reasoning mode',async t=>{
  const root=fixture(t),ids=['gemini-future-flash','gemini-future-pro-high','gemini-future-second','gemini-future-image'];
  const result=await catalogs(root,{sourceDirectory,read:async(_root,target)=>{
    assert.equal(target.baseUrl,'http://127.0.0.1:8317/v1');assert.equal(Object.keys(target).includes('headers'),false);
    return {available:{data:ids.map(id=>({id,owned_by:'antigravity'}))},native:{models:ids.map(id=>row(id,id.endsWith('image')?['text','image']:['text']))},registered:{models:ids.map(id=>({id}))},definitions:{channel:'antigravity',models:ids.map(id=>({id,thinking:{levels:['low','medium','high']}}))}};
  }});
  assert.equal(result.provider.models.length,2);
  assert.equal(result.provider.models[0].id,'gemini-future-pro-high');
  assert.equal(result.provider.models[0].defaultReasoningEffort,'high');
  assert.equal(result.provider.models[1].defaultReasoningEffort,'medium');
  assert.ok(result.provider.models.every(m=>!m.id.endsWith('image')));
});
test('empty account model results cannot register a provider',async t=>{
  const root=fixture(t);await assert.rejects(catalogs(root,{sourceDirectory,read:async()=>({available:{data:[]},native:{models:[]},registered:{models:[]}})}));
});

test('bootstrap discovers account Claude 5.5 IDs with safe high reasoning and full native capability metadata',async t=>{
  const root=fixture(t),ids=['claude-sonnet-5-5-high','claude-opus-5-5-high'];
  const result=await catalogs(root,{sourceDirectory,read:async()=>({available:{data:ids.map(id=>({id,owned_by:'antigravity'}))},registered:{models:ids.map(id=>({id}))},native:{models:ids.map(id=>({...row(id),inputTokenLimit:1000000,outputTokenLimit:128000,supportedInputModalities:['text','image']}))},definitions:{channel:'antigravity',models:ids.map(id=>({id,thinking:{min:1024,max:64000,zero_allowed:true,dynamic_allowed:true}}))}})});
  assert.equal(result.provider.id,'gemini-subscription');assert.deepEqual(new Set(result.provider.models.map(m=>m.id)),new Set(ids));
  for(const model of result.provider.models){assert.deepEqual(model.reasoningEfforts,['high']);assert.equal(model.defaultReasoningEffort,'high');assert.equal(model.contextWindow,1000000);assert.equal(model.maxOutputTokens,65536);assert.equal(model.preserveOpaqueReasoning,true);assert.deepEqual(model.inputModalities,['text','image']);}
});
