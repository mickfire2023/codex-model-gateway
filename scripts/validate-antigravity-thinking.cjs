'use strict';
// Optional offline integration check. Only the pinned executable is read;
// accounts, configuration and the running subscription service are not used.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

const PINNED_SHA256='1b444cc3c91bd8f33130ec282274b088bbb6b23c6e310dd945d746ee58dbd1a4';
const CASES=[
  {model:'gemini-3.8-flash-high',effort:'low',expected:{thinkingLevel:'low'}},
  {model:'gemini-3.8-flash-high',effort:'high',expected:{thinkingLevel:'high'}},
  {model:'gemini-3.1-flash-lite',effort:'minimal',expected:{thinkingLevel:'minimal'}},
  {model:'gemini-3.1-flash-lite',effort:'high',expected:{thinkingLevel:'high'}},
  {model:'claude-sonnet-5-5-high',effort:'low',expected:{thinkingBudget:1024}},
  {model:'claude-sonnet-5-5-high',effort:'medium',expected:{thinkingBudget:8192}},
  {model:'claude-sonnet-5-5-high',effort:'high',expected:{thinkingBudget:24576}},
  {model:'claude-opus-5-5-high',effort:'low',expected:{thinkingBudget:1024}},
  {model:'claude-opus-5-5-high',effort:'medium',expected:{thinkingBudget:8192}},
  {model:'claude-opus-5-5-high',effort:'high',expected:{thinkingBudget:24576}},
  {model:'gemini-3.8-flash-high(low)',effort:'high',expected:{thinkingLevel:'low'}},
  {model:'claude-sonnet-5-5-high',effort:'high',maxOutputTokens:4096,expected:{thinkingBudget:4095}},
];
const fail=code=>Object.assign(new Error(code),{code});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};

async function readBody(req){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw fail('fixture_request_too_large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
async function request(port,route,body,key){
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6000)});
  const text=await response.text();
  let value;try{value=JSON.parse(text);}catch{}
  return {status:response.status,value};
}

async function validateThinkingWire(binary){
  if(typeof binary!=='string'||!path.isAbsolute(binary))throw fail('absolute_pinned_binary_path_required');
  if(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')!==PINNED_SHA256)throw fail('pinned_binary_hash_mismatch');
  if(process.platform!=='win32')throw fail('pinned_windows_binary_required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-antigravity-thinking-'));
  const captures=[],blocked=[];
  const marker='offline-thinking-'+crypto.randomUUID();
  const syntheticKey='synthetic-offline-gateway-'+crypto.randomUUID();
  const ids=[...new Set(CASES.map(item=>item.model.replace(/\([^)]*\)$/,'')))];
  let child;
  const upstream=http.createServer(async(req,res)=>{
    try{
      const body=await readBody(req);
      if(req.url==='/v1internal:fetchAvailableModels')return json(res,200,{models:Object.fromEntries(ids.map(id=>[id,{displayName:id,maxTokens:1048576,maxOutputTokens:65536}]))});
      if((req.url?.startsWith('/v1internal:')&&req.url.includes('GenerateContent'))||req.url==='/v1internal:generateContent'){
        const serialized=JSON.stringify(body);
        if(serialized.includes(marker))captures.push(body);
        // Deliberately stop after capturing the translated request. There is no
        // model behind this server, and no generated result is simulated.
        return json(res,400,{error:{code:400,status:'INVALID_ARGUMENT',message:'Offline transport capture completed.'}});
      }
      if(req.url==='/v1internal:loadCodeAssist')return json(res,200,{cloudaicompanionProject:'synthetic-offline-project'});
      return json(res,404,{error:{message:'Offline fixture endpoint not implemented.'}});
    }catch{return json(res,400,{error:{message:'Invalid offline fixture request.'}});}
  });
  let upstreamPort;
  // Even if a future executable unexpectedly requests a different host, the
  // configured transport and inherited proxy environment can only reach this
  // guard. It forwards exclusively to the one local fixture origin.
  const guard=http.createServer((req,res)=>{
    let target;try{target=new URL(req.url);}catch{blocked.push('invalid-target');return json(res,403,{error:'offline_only'});}
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||Number(target.port)!==upstreamPort||target.username||target.password){blocked.push('external-http');return json(res,403,{error:'offline_only'});}
    const forwarded=http.request({hostname:'127.0.0.1',port:upstreamPort,path:target.pathname+target.search,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    forwarded.on('error',()=>json(res,502,{error:'offline_fixture_unavailable'}));req.pipe(forwarded);
  });
  guard.on('connect',(_req,socket)=>{blocked.push('external-connect');socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  let logs='';
  try{
    upstreamPort=await listen(upstream);
    const guardPort=await listen(guard);
    const reserve=http.createServer();const port=await listen(reserve);await close(reserve);
    const authDir=path.join(root,'auth');fs.mkdirSync(authDir);
    const proxy=`http://127.0.0.1:${guardPort}`;
    fs.writeFileSync(path.join(authDir,'synthetic.json'),JSON.stringify({type:'antigravity',email:'offline-fixture@example.invalid',access_token:'synthetic-offline-token',expired:'2099-01-01T00:00:00Z',project_id:'synthetic-offline-project',base_url:`http://127.0.0.1:${upstreamPort}`,proxy_url:proxy}),{mode:0o600});
    const quote=JSON.stringify;
    const config=`config-version: 8
server:
  host: "127.0.0.1"
  port: ${port}
  commercial-mode: true
  discovery:
    enabled: false
management:
  allow-remote: false
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys: [${quote(syntheticKey)}]
oauth:
  auth-dir: ${quote(authDir.replaceAll('\\','/'))}
  providers:
    antigravity:
      antigravity-credits: false
routing:
  retry:
    request-retry: 0
    max-retry-credentials: 1
    max-retry-interval: 0
requests:
  proxy-url: ${quote(proxy)}
  streaming:
    bootstrap-retries: 0
observability:
  logs:
    debug: false
    logging-to-file: false
    request-log: false
plugins:
  enabled: false
`;
    const configPath=path.join(root,'config.yaml');fs.writeFileSync(configPath,config,{mode:0o600});
    // Do not inherit storage/account/provider settings from the user's shell.
    const env={SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT,windir:process.env.windir||process.env.WINDIR,TEMP:root,TMP:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,ALL_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,all_proxy:proxy,NO_PROXY:'',no_proxy:''};
    child=spawn(binary,['-config',configPath,'-local-model'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
    child.stdout.on('data',data=>{logs=(logs+data.toString()).slice(-16000);});
    child.stderr.on('data',data=>{logs=(logs+data.toString()).slice(-16000);});
    child.once('error',()=>{});
    const deadline=Date.now()+25000;
    let ready=false;
    while(Date.now()<deadline){
      if(child.exitCode!==null)throw fail('offline_proxy_exited_before_ready');
      try{const reply=await request(port,'/v1/models',undefined,syntheticKey);if(reply.status===200&&ids.every(id=>reply.value?.data?.some(row=>row.id===id))){ready=true;break;}}catch{}
      await delay(150);
    }
    if(!ready)throw fail('offline_models_not_registered');
    const results=[];
    for(const [index,item] of CASES.entries()){
      const count=captures.length;
      const reply=await request(port,'/v1/responses',{model:item.model,input:`${marker}/${index}`,max_output_tokens:item.maxOutputTokens||65536,reasoning:{effort:item.effort},stream:false},syntheticKey);
      assert.equal(captures.length,count+1,`Expected one local capture for ${item.model}/${item.effort}; proxy status ${reply.status}`);
      const capture=captures[count];
      const thinking=capture.request?.generationConfig?.thinkingConfig;
      const observed={...('thinkingLevel' in (thinking||{})?{thinkingLevel:thinking.thinkingLevel}:{}),...('thinkingBudget' in (thinking||{})?{thinkingBudget:thinking.thinkingBudget}:{})};
      assert.deepEqual(observed,item.expected,`Unexpected pinned proxy translation for ${item.model}/${item.effort}`);
      assert.equal(capture.model,item.model.replace(/\([^)]*\)$/,''),'The literal upstream model ID must be retained.');
      results.push({model:item.model,effort:item.effort,...(item.maxOutputTokens?{maxOutputTokens:item.maxOutputTokens}:{}),observed});
    }
    return {ok:true,evidence:'pinned-binary-local-wire',version:'8.0.43',sha256:PINNED_SHA256,catalog:'embedded-pinned-binary',usesRealAccount:false,backendVariableEffortVerified:false,externalRequestsBlocked:blocked.length,captures:results};
  }catch(error){
    // Only fixture-created credentials exist in this process. Retain a small
    // startup diagnostic for callers without printing any account files.
    error.offlineProxyDiagnostic=logs.slice(-2000);throw error;
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.kill();await Promise.race([exited,delay(3000,undefined,{ref:false})]);
    }
    await Promise.all([close(upstream),close(guard)]);
    const absolute=path.resolve(root),parent=path.resolve(os.tmpdir());
    if(!absolute.startsWith(parent+path.sep)||!path.basename(absolute).startsWith('codex-antigravity-thinking-'))throw fail('offline_fixture_cleanup_path_invalid');
    fs.rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
if(require.main===module)validateThinkingWire(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.code||error.message,diagnostic:error.offlineProxyDiagnostic}));process.exitCode=1;});
module.exports={validateThinkingWire,PINNED_SHA256,CASES};
