'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const messages={
  gemini_service_disabled:'Gemini 本机组件已被手动停用，请先启动 Gemini 组件。',
  gemini_service_missing:'Gemini 本机组件的启动任务缺失，请修复 Gemini 组件安装。',
  gemini_service_foreign_listener:'Gemini 本机端口被其他程序占用，未停止或替换该程序。',
  gemini_service_unavailable:'Gemini 本机组件尚未恢复，请稍后重试；本次请求没有发送给模型。',
  gemini_service_invalid:'Gemini 本机组件安装信息无效，请修复组件安装。',
  gemini_service_closed:'网关正在关闭，请稍后重试。'
};
const failure=code=>Object.assign(new Error(messages[code]||messages.gemini_service_unavailable),{code,status:503,retryAfterSeconds:10});
function listening(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(1000,()=>finish(false));});}
function runControl({directory,port,signal}){
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'gemini-service.ps1'),'-Directory',directory,'-Port',String(port)],{windowsHide:true,stdio:['ignore','pipe','ignore'],signal});
    let output='';child.stdout.on('data',chunk=>{if(output.length<4096)output+=chunk.toString('utf8');});
    const timeout=setTimeout(()=>{child.kill();reject(failure('gemini_service_unavailable'));},35000);
    child.once('error',()=>{clearTimeout(timeout);reject(failure('gemini_service_unavailable'));});
    child.once('close',code=>{clearTimeout(timeout);const known={20:'gemini_service_disabled',21:'gemini_service_missing',22:'gemini_service_foreign_listener',24:'gemini_service_invalid'};if(code!==0)return reject(failure(known[code]||'gemini_service_unavailable'));try{if(JSON.parse(output.trim()).ready===true)return resolve();}catch{}reject(failure('gemini_service_unavailable'));});
  });
}
function createGeminiService(options){
  const now=options.now||Date.now,probe=options.probe||listening,control=options.runControl||runControl;
  const root=path.resolve(options.directory);let port;
  try{const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));if(!path.isAbsolute(options.directory)||/[\x00-\x1f\x7f"]/.test(root)||fs.realpathSync(root).toLowerCase()!==root.toLowerCase()||metadata.product!=='CodexGeminiBridge'||!Number.isSafeInteger(metadata.port)||metadata.port<1024||metadata.port>65535)throw Error();port=metadata.port;}catch{throw failure('gemini_service_invalid');}
  const intervalMs=options.intervalMs||30000,controller=new AbortController();
  let closed=false,pending=null,timer=null,lastSuccess=-Infinity,lastFailure=-Infinity;
  const view={state:'unknown',checkedAt:null,errorCode:null,message:'Gemini 本机组件尚未检查。'};
  function set(state,code){const changed=view.state!==state||view.errorCode!==code;Object.assign(view,{state,checkedAt:new Date(now()).toISOString(),errorCode:code||null,message:code?messages[code]:state==='ready'?'Gemini 本机组件正在运行；意外停止后会自动恢复。':'正在检查 Gemini 本机组件，必要时恢复原启动任务。'});if(changed)options.log?.({event:'gemini_service_state',state,...(code?{code}:{})});}
  async function ensure({signal,force=false}={}){
    if(closed)throw failure('gemini_service_closed');
    if(signal?.aborted)throw Object.assign(new Error('请求已取消。'),{name:'AbortError'});
    if(!pending)pending=(async()=>{
      if(!force&&now()-lastSuccess<intervalMs&&await probe(port))return;
      if(!force&&view.errorCode&&now()-lastFailure<5000)throw failure(view.errorCode);
      set('recovering');
      try{await control({directory:root,port,signal:controller.signal});if(closed)throw failure('gemini_service_closed');if(!await probe(port))throw failure('gemini_service_unavailable');lastSuccess=now();set('ready');}
      catch(error){lastFailure=now();const code=Object.hasOwn(messages,error.code)?error.code:'gemini_service_unavailable';set('unavailable',code);throw failure(code);}
    })().finally(()=>{pending=null;});
    const operation=pending;
    if(!signal)return operation;
    return new Promise((resolve,reject)=>{const abort=()=>{cleanup();reject(Object.assign(new Error('请求已取消。'),{name:'AbortError'}));};const cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});operation.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});if(signal.aborted)abort();});
  }
  function start(){if(closed||timer)return;timer=setInterval(()=>{ensure().catch(()=>{});},intervalMs);timer.unref?.();return ensure();}
  function close(){closed=true;clearInterval(timer);timer=null;controller.abort();}
  return {ensure,start,close,status:()=>({...view})};
}
module.exports={createGeminiService,listening};
