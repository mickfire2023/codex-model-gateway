'use strict';
// Optional binary integration check using synthetic signatures and a local
// upstream only. Never read the installed service's config or OAuth directory.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const http=require('node:http');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const OFFICIAL_SHA256='1b444cc3c91bd8f33130ec282274b088bbb6b23c6e310dd945d746ee58dbd1a4';
const MODEL='claude-sonnet-5-5-high';
const fail=code=>Object.assign(new Error(code),{code});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const varint=value=>{const result=[];do{const byte=value%128;value=Math.floor(value/128);result.push(byte+(value?128:0));}while(value);return Buffer.from(result);};
const bytes=(number,value)=>Buffer.concat([varint(number*8+2),varint(value.length),value]);
const integer=(number,value)=>Buffer.concat([varint(number*8),varint(value)]);
function syntheticSignature(channel){
  const block=Buffer.concat([integer(1,channel),integer(2,2),integer(3,2),integer(7,1),bytes(8,Buffer.from('thinking'))]);
  const container=Buffer.concat([bytes(1,block),bytes(2,Buffer.alloc(12,1)),bytes(3,Buffer.alloc(12,2)),bytes(4,Buffer.alloc(48,3)),bytes(5,Buffer.alloc(64,7))]);
  return Buffer.from(Buffer.concat([integer(1,4),bytes(2,container),integer(3,1)]).toString('base64')).toString('base64');
}
function binaryEvidence(binary){
  if(typeof binary!=='string'||!path.isAbsolute(binary)||process.platform!=='win32')throw fail('absolute_windows_binary_required');
  const sha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if(sha256===OFFICIAL_SHA256)return {sha256,channel19Supported:false};
  let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../bridge/binary-manifest.json'),'utf8'));}catch{}
  if(!/^[a-f0-9]{64}$/.test(manifest?.patched?.sha256||'')||sha256!==manifest.patched.sha256)throw fail('known_signature_binary_required');
  return {sha256,channel19Supported:true};
}
async function readBody(req){
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw fail('signature_fixture_body_too_large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
}
async function request(port,route,body,key){
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(6000)});
  let value;try{value=await response.json();}catch{}
  return {status:response.status,value};
}
async function validateSignatureWire(binary){
  const evidence=binaryEvidence(binary),root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-antigravity-signature-'));
  const captures=[],blocked=[],marker='offline-signature-'+crypto.randomUUID(),key='synthetic-offline-key-'+crypto.randomUUID();
  let child,upstreamPort;
  const upstream=http.createServer(async(req,res)=>{
    try{
      const body=await readBody(req);
      if(req.url==='/v1internal:fetchAvailableModels')return json(res,200,{models:{[MODEL]:{displayName:MODEL,maxTokens:1048576,maxOutputTokens:65536}}});
      if((req.url?.startsWith('/v1internal:')&&req.url.includes('GenerateContent'))||req.url==='/v1internal:generateContent'){
        if(JSON.stringify(body).includes(marker))captures.push(body);
        return json(res,400,{error:{code:400,status:'INVALID_ARGUMENT',message:'Offline signature capture completed.'}});
      }
      if(req.url==='/v1internal:loadCodeAssist')return json(res,200,{cloudaicompanionProject:'synthetic-offline-project'});
      return json(res,404,{error:{message:'Offline fixture endpoint unavailable.'}});
    }catch{return json(res,400,{error:{message:'Invalid offline fixture body.'}});}
  });
  const guard=http.createServer((req,res)=>{
    let url;try{url=new URL(req.url);}catch{blocked.push('invalid-target');return json(res,403,{error:'offline_only'});}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||Number(url.port)!==upstreamPort||url.username||url.password){blocked.push('external-http');return json(res,403,{error:'offline_only'});}
    const forwarded=http.request({hostname:'127.0.0.1',port:upstreamPort,path:url.pathname+url.search,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    forwarded.on('error',()=>json(res,502,{error:'offline_upstream_unavailable'}));req.pipe(forwarded);
  });
  guard.on('connect',(_req,socket)=>{blocked.push('external-connect');socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  try{
    upstreamPort=await listen(upstream);const guardPort=await listen(guard),reserve=http.createServer(),port=await listen(reserve);await close(reserve);
    const auth=path.join(root,'auth');fs.mkdirSync(auth);const proxy=`http://127.0.0.1:${guardPort}`;
    fs.writeFileSync(path.join(auth,'synthetic.json'),JSON.stringify({type:'antigravity',email:'offline@example.invalid',access_token:'synthetic-offline-token',expired:'2099-01-01T00:00:00Z',project_id:'synthetic-offline-project',base_url:`http://127.0.0.1:${upstreamPort}`,proxy_url:proxy}),{mode:0o600});
    const config=`config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: ${port}\n  commercial-mode: true\n  discovery:\n    enabled: false\nmanagement:\n  allow-remote: false\n  disable-control-panel: true\n  disable-auto-update-panel: true\naccess:\n  api-keys: [${JSON.stringify(key)}]\noauth:\n  auth-dir: ${JSON.stringify(auth.replaceAll('\\','/'))}\n  providers:\n    antigravity:\n      antigravity-credits: false\nrouting:\n  retry:\n    request-retry: 0\n    max-retry-credentials: 1\n    max-retry-interval: 0\nrequests:\n  proxy-url: ${JSON.stringify(proxy)}\n  streaming:\n    bootstrap-retries: 0\nobservability:\n  logs:\n    debug: false\n    logging-to-file: false\n    request-log: false\nplugins:\n  enabled: false\n`;
    const configPath=path.join(root,'config.yaml');fs.writeFileSync(configPath,config,{mode:0o600});
    const env={SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT,windir:process.env.windir||process.env.WINDIR,TEMP:root,TMP:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,ALL_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,all_proxy:proxy,NO_PROXY:'',no_proxy:''};
    child=spawn(binary,['-config',configPath,'-local-model'],{cwd:root,env,windowsHide:true,stdio:'ignore'});child.once('error',()=>{});
    const deadline=Date.now()+25000;let ready=false;
    while(Date.now()<deadline){if(child.exitCode!==null)throw fail('signature_fixture_child_exited');try{const response=await request(port,'/v1/models',undefined,key);if(response.status===200&&response.value?.data?.some(row=>row.id===MODEL)){ready=true;break;}}catch{}await delay(150);}
    if(!ready)throw fail('signature_fixture_not_ready');
    const results=[];
    for(const channel of [18,19,20]){
      const signature=syntheticSignature(channel),count=captures.length;
      await request(port,'/v1/responses',{model:MODEL,input:[{role:'user',content:marker},{type:'reasoning',encrypted_content:signature,summary:[{type:'summary_text',text:'Synthetic offline thinking.'}]},{role:'assistant',content:[{type:'output_text',text:'Synthetic answer.'}]},{role:'user',content:'Continue the synthetic check.'}],max_output_tokens:65536,reasoning:{effort:'medium'},stream:false},key);
      assert.equal(captures.length,count+1,'Expected exactly one local signature capture.');
      const parts=(captures[count].request?.contents||[]).flatMap(row=>row.parts||[]).filter(part=>part.thought===true);
      const shouldPreserve=channel===18||(channel===19&&evidence.channel19Supported);
      assert.equal(parts.length,shouldPreserve?1:0,`Unexpected thinking preservation for channel ${channel}.`);
      if(shouldPreserve){assert.equal(parts[0].thoughtSignature,signature);assert.equal(parts[0].text,'Synthetic offline thinking.');}
      results.push({channel,thinkingPreserved:parts.length===1,exactSyntheticSignature:parts.length===1?parts[0].thoughtSignature===signature:null});
    }
    return {ok:true,evidence:'binary-local-signature-wire',binaryHash:evidence.sha256,usesRealAccount:false,channel19Supported:evidence.channel19Supported,externalRequestsBlocked:blocked.length,captures:results};
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([exited,delay(3000,undefined,{ref:false})]);}
    await Promise.all([close(upstream),close(guard)]);
    const absolute=path.resolve(root),parent=path.resolve(os.tmpdir());
    if(!absolute.startsWith(parent+path.sep)||!path.basename(absolute).startsWith('codex-antigravity-signature-'))throw fail('signature_fixture_cleanup_path_invalid');
    fs.rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
if(require.main===module)validateSignatureWire(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.code||'signature_wire_failed'}));process.exitCode=1;});
module.exports={validateSignatureWire,OFFICIAL_SHA256};
