'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');

async function catalogs(root,{sourceDirectory=path.resolve(__dirname,'../gateway'),read,discover}={}){
  if(!path.isAbsolute(root)||!path.isAbsolute(sourceDirectory))throw new Error('Absolute installation paths are required.');
  const {account,readCatalogs,discoverModels}=require(path.join(sourceDirectory,'gemini-updater.cjs'));
  const identity=account(root).identity;
  const control=JSON.parse(fs.readFileSync(path.join(root,'private','control.json'),'utf8'));
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));
  if(metadata.product!=='CodexGeminiBridge'||!Number.isSafeInteger(metadata.port)||metadata.port<1024||metadata.port>65535||!/^[a-f0-9]{64}$/.test(control.apiKey||''))throw new Error('Invalid local bridge metadata.');
  const baseUrl='http://127.0.0.1:'+metadata.port+'/v1';
  const target={baseUrl,accountIdentity:identity};
  Object.defineProperty(target,'headers',{value:{authorization:'Bearer '+control.apiKey}});
  const details=await (read||readCatalogs)(root,target);
  const selected=(discover||discoverModels)(details).candidates.sort((a,b)=>Number(b.defaultReasoningEffort==='high')-Number(a.defaultReasoningEffort==='high')||a.id.localeCompare(b.id)).slice(0,2);
  if(!selected.length)throw new Error('No compatible text Gemini model is currently available to this account.');
  return {provider:{id:'gemini-subscription',name:'Gemini 订阅',baseUrl,protocol:'responses',opaqueReasoningIdentity:identity,models:selected},apiKey:control.apiKey};
}

async function validate(root,{sourceDirectory,fixtureDirectory}={}){
  if(!path.isAbsolute(root)||!path.isAbsolute(sourceDirectory)||!path.isAbsolute(fixtureDirectory))throw new Error('Absolute validation paths are required.');
  const candidate=await catalogs(root,{sourceDirectory});
  const directory=fs.mkdtempSync(path.join(fixtureDirectory,'live-validation-'));
  fs.mkdirSync(path.join(directory,'private'));
  for(const name of ['openai-models.json','deepseek-models.json'])fs.writeFileSync(path.join(directory,name),'{"models":[]}');
  const keys=new Map();
  const {createGateway}=require(path.join(sourceDirectory,'gateway.cjs'));
  const token=crypto.randomBytes(32).toString('hex');
  const gateway=createGateway({directory,routeToken:token,stagingValidation:true,catalogSyncEnabled:false},{deepseekKey:'',credentialStore:{get:id=>keys.get(id)||'',set:(id,key)=>keys.set(id,key),delete:id=>keys.delete(id)}});
  const results=[];
  try{
    const saved=await gateway.providers.saveProvider({...candidate.provider,apiKey:candidate.apiKey});
    gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');
    const url=`http://127.0.0.1:${gateway.server.address().port}/${token}/backend-api/codex/responses`;
    async function send(body,session){
      const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic-subscription-validation','content-type':'application/json',session_id:session},body:JSON.stringify({...body,stream:false,max_output_tokens:4096}),signal:AbortSignal.timeout(180000)});
      const data=await response.json();
      if(!response.ok)throw new Error('Gateway validation HTTP '+response.status+' ('+(data.error?.code||'unknown')+').');
      if(data.status!=='completed')throw new Error('Gemini did not complete the protocol check.');
      return data;
    }
    for(const model of saved.models){
      const session='gemini-protocol-check-'+crypto.randomUUID();
      const marker='gemini-bridge-'+crypto.randomBytes(8).toString('hex');
      const tools=[{type:'custom',name:'apply_patch',namespace:'workspace',description:'Non-executing transport check. Returns a marker; it never modifies a file.'}];
      const first=await send({model:model.slug,input:'Call workspace.apply_patch once with input exactly "*** Begin Patch\\n*** End Patch". This is a non-executing gateway transport check. Do not answer in text yet.',tools,tool_choice:{type:'custom',name:'apply_patch',namespace:'workspace'},reasoning:{effort:model.defaultReasoningEffort}},session);
      const calls=(first.output||[]).filter(x=>x.type==='custom_tool_call');
      if(calls.length!==1||calls[0].name!=='apply_patch'||calls[0].namespace!=='workspace'||typeof calls[0].input!=='string')throw new Error('Gemini did not return a valid wrapped custom tool call.');
      const {isGeminiReasoningCarrier,decodeAntigravityClaudeReasoningCarrier}=require(path.join(sourceDirectory,'deepseek-adapter.cjs'));
      const reasoning=(first.output||[]).filter(x=>x.type==='reasoning'),claude=/^claude-/.test(model.id);
      if(claude?reasoning.some(item=>decodeAntigravityClaudeReasoningCarrier(item)===undefined):!reasoning.some(isGeminiReasoningCarrier))throw new Error('Issued subscription thinking must include a valid tool signature carrier and signed text.');
      const signatureCarrier=reasoning.some(isGeminiReasoningCarrier);
      const second=await send({model:model.slug,previous_response_id:first.id,input:[{type:'custom_tool_call_output',call_id:calls[0].call_id,output:'Protocol check succeeded. Marker: '+marker},{role:'user',content:'Reply with the exact marker supplied by the tool. Do not call any more tools.'}],tools,reasoning:{effort:model.defaultReasoningEffort}},session);
      const text=(second.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
      if(!text.includes(marker))throw new Error('Gemini did not preserve the tool result across the second turn.');
      results.push({id:model.id,toolCall:true,customToolWrapper:true,signatureContinuation:signatureCarrier,signatureCarrier,reasoningAbsent:reasoning.length===0,toolContinuation:true,toolResult:true});
      console.log(JSON.stringify({validated:model.id,toolRoundTrip:true}));
    }
    const report={validatedAt:new Date().toISOString(),proxyRelease:'8.0.43',models:results,provider:candidate.provider};
    fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify(report,null,2));
    return {validated:true,models:results};
  }finally{gateway.socketRouter.close();gateway.server.closeAllConnections();if(gateway.server.listening)await new Promise(resolve=>gateway.server.close(resolve));keys.clear();}
}
if(require.main===module){const [root,sourceDirectory,fixtureDirectory]=process.argv.slice(2);validate(root,{sourceDirectory,fixtureDirectory}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={catalogs,validate};
