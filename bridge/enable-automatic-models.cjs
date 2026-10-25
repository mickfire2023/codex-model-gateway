'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function atomic(file,body){const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,body,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}}
async function enable(bridgeRoot,gatewayRoot){
  if(!path.isAbsolute(bridgeRoot)||!path.isAbsolute(gatewayRoot))throw new Error('Absolute installation paths are required.');
  const {account,fingerprint}=require(path.join(gatewayRoot,'gemini-updater.cjs'));
  const {createProviderStore}=require(path.join(gatewayRoot,'provider-store.cjs'));
  const current=account(bridgeRoot);
  const store=createProviderStore({directory:gatewayRoot});
  const snapshot=store.getDiscoverySnapshot('gemini-subscription');
  if(!snapshot||snapshot.provider.opaqueReasoningIdentity!==current.identity)throw new Error('The Google account must match the validated subscription provider.');
  const settingsPath=path.join(gatewayRoot,'private','settings.json');
  const before=fs.readFileSync(settingsPath,'utf8');
  const settings=JSON.parse(before.replace(/^\uFEFF/,''));
  const configured=settings.geminiSubscription;
  if(configured?.bridgeDirectory&&path.resolve(configured.bridgeDirectory)!==path.resolve(bridgeRoot))throw new Error('Another subscription bridge is configured; it was left unchanged.');
  const initial=!snapshot.provider.autoDiscovery;
  let managed;
  if(initial){
    const report=JSON.parse(fs.readFileSync(path.join(bridgeRoot,'validation.json'),'utf8'));
    if(report.provider?.opaqueReasoningIdentity!==current.identity)throw new Error('The initial validation belongs to a different account.');
    const passed=new Set(report.models.filter(m=>m.toolCall&&m.toolResult&&m.customToolWrapper&&m.signatureContinuation).map(m=>m.id));
    const proofModels=new Map((report.provider.models||[]).map(model=>[model.id,model]));
    for(const model of snapshot.provider.models)if(passed.has(model.id)&&model.preserveOpaqueReasoning&&(!proofModels.has(model.id)||fingerprint(model)!==fingerprint(proofModels.get(model.id))))throw new Error('Model capabilities changed after the initial validation; validate them again before setup.');
    managed=snapshot.provider.models.filter(m=>passed.has(m.id)&&m.preserveOpaqueReasoning).map(m=>m.id);
    if(!managed.length)throw new Error('Validate the initial subscription models before enabling automatic discovery.');
  }
  const backup=path.join(gatewayRoot,'private','settings.before-gemini-automatic.json');
  if(!fs.existsSync(backup))fs.writeFileSync(backup,before,{flag:'wx',mode:0o600});
  const providerFile=path.join(gatewayRoot,'private','providers','providers.json');
  const providerBackup=path.join(gatewayRoot,'private','providers.before-gemini-automatic.json');
  if(fs.existsSync(providerFile)&&!fs.existsSync(providerBackup))fs.copyFileSync(providerFile,providerBackup,fs.constants.COPYFILE_EXCL);
  const beforeProvider=fs.readFileSync(providerFile,'utf8');let afterProvider,result;
  try{
    if(fs.readFileSync(settingsPath,'utf8')!==before)throw new Error('Gateway settings changed before setup.');
    result=await store.configureAutoDiscovery('gemini-subscription',{enabled:true,...(initial?{managedModelIds:managed}:{})});
    afterProvider=fs.readFileSync(providerFile,'utf8');
    if(fs.readFileSync(settingsPath,'utf8')!==before)throw new Error('Gateway settings changed during setup; current settings were preserved.');
    settings.geminiSubscription={enabled:true,bridgeDirectory:bridgeRoot,intervalMs:1800000};
    atomic(settingsPath,JSON.stringify(settings,null,2));
  }catch(error){
    if(afterProvider&&fs.readFileSync(providerFile,'utf8')===afterProvider)atomic(providerFile,beforeProvider);
    throw error;
  }
  return {enabled:true,intervalMinutes:30,managedModelCount:result.managedModelIds.length,excludedModelCount:result.excludedModelIds.length};
}
if(require.main===module){enable(process.argv[2]||'',process.argv[3]||'').then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={enable};
