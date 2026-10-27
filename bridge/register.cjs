'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {catalogs}=require('./validate.cjs');
async function register(bridgeRoot,gatewayRoot){
  if(!path.isAbsolute(bridgeRoot)||!path.isAbsolute(gatewayRoot))throw new Error('Absolute installation paths are required.');
  const report=JSON.parse(fs.readFileSync(path.join(bridgeRoot,'validation.json'),'utf8'));
  if(!Number.isFinite(Date.parse(report.validatedAt))||Date.now()-Date.parse(report.validatedAt)>24*60*60*1000)throw new Error('Run a fresh subscription tool validation before registration.');
  const candidate=await catalogs(bridgeRoot,{sourceDirectory:gatewayRoot});
  if(candidate.provider.opaqueReasoningIdentity!==report.provider?.opaqueReasoningIdentity)throw new Error('The Google account changed after validation. Start a new validation.');
  const passed=new Set(report.models.filter(m=>m.toolCall&&m.customToolWrapper&&m.toolResult&&(m.signatureContinuation||(/^claude-/.test(m.id)&&m.toolContinuation===true&&m.signatureCarrier===false&&m.reasoningAbsent===true))).map(m=>m.id));
  candidate.provider.models=candidate.provider.models.filter(m=>passed.has(m.id));
  if(!candidate.provider.models.length)throw new Error('No currently available Gemini model passed the tool validation.');
  const version=JSON.parse(fs.readFileSync(path.join(gatewayRoot,'package.json'),'utf8')).version;
  if(!/^2\.(?:[2-9]|[1-9]\d)\./.test(version))throw new Error('Install the gateway signature adapter before registering subscription models.');
  const {createProviderStore}=require(path.join(gatewayRoot,'provider-store.cjs'));
  const template=JSON.parse(fs.readFileSync(path.join(gatewayRoot,'deepseek-models.json'),'utf8')).models[0];
  const store=createProviderStore({directory:gatewayRoot,template});
  const existing=store.listProviders().find(p=>p.id===candidate.provider.id);
  if(existing&&existing.baseUrl!==candidate.provider.baseUrl)throw new Error('An unrelated provider already uses the subscription provider ID.');
  const saved=await store.saveProvider({...candidate.provider,apiKey:candidate.apiKey});
  return {registered:true,models:saved.models.map(m=>({id:m.id,slug:m.slug,displayName:m.displayName}))};
}
if(require.main===module){register(process.argv[2]||'',process.argv[3]||'').then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={register};
