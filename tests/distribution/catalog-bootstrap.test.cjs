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
    return {available:{data:ids.map(id=>({id,owned_by:'antigravity'}))},native:{models:ids.map(id=>row(id,id.endsWith('image')?['text','image']:['text']))},registered:{models:ids.map(id=>({id}))}};
  }});
  assert.equal(result.provider.models.length,2);
  assert.equal(result.provider.models[0].id,'gemini-future-pro-high');
  assert.equal(result.provider.models[0].defaultReasoningEffort,'high');
  assert.equal(result.provider.models[1].defaultReasoningEffort,'none');
  assert.ok(result.provider.models.every(m=>!m.id.endsWith('image')));
});
test('empty account model results cannot register a provider',async t=>{
  const root=fixture(t);await assert.rejects(catalogs(root,{sourceDirectory,read:async()=>({available:{data:[]},native:{models:[]},registered:{models:[]}})}));
});
