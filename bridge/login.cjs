'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

function same(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length>0&&x.length===y.length&&crypto.timingSafeEqual(x,y);}
function management({port,managementKey},method,endpoint,body,signal){
  return new Promise((resolve,reject)=>{
    const payload=body?Buffer.from(JSON.stringify(body)):null;
    const req=http.request({host:'127.0.0.1',port,method,path:'/v8/management/oauth/'+endpoint,signal,timeout:15000,headers:{authorization:'Bearer '+managementKey,...(payload?{'content-type':'application/json','content-length':payload.length}:{})}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',c=>{bytes+=c.length;if(bytes>1048576){res.destroy();reject(new Error('Management response exceeded limit.'));}else chunks.push(c);});
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error('Local authentication service returned HTTP '+res.statusCode+'.'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('Invalid local authentication response.'));}});
      res.on('error',()=>reject(new Error('Local authentication response was interrupted.')));
    });
    req.on('timeout',()=>req.destroy());
    req.on('error',()=>reject(new Error('Local authentication service is not available.')));
    req.end(payload);
  });
}
function loadControl(root){
  if(!path.isAbsolute(root))throw new Error('Absolute bridge directory required.');
  const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));
  const control=JSON.parse(fs.readFileSync(path.join(root,'private','control.json'),'utf8'));
  if(metadata.product!=='CodexGeminiBridge'||!Number.isInteger(metadata.port)||metadata.port<1024||metadata.port>65535||!/^[a-f0-9]{64}$/.test(control.managementKey))throw new Error('Invalid bridge control file.');
  return {...control,port:metadata.port};
}
function defaultOpen(url){
  // The URL is a separate process argument, never shell command text.
  const script="Start-Process -FilePath $env:CODEX_GEMINI_AUTH_URL";
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_GEMINI_AUTH_URL:url}});
    child.once('error',()=>reject(new Error('Unable to open the Google login page.')));
    child.once('exit',code=>code===0?resolve():reject(new Error('Unable to open the Google login page.')));
  });
}
async function login(root,{open=defaultOpen,call=management,callbackPort=51121,timeoutMs=600000,notify=()=>{}}={}) {
  const control=loadControl(root);
  if(fs.readdirSync(path.join(root,'private','auth')).some(name=>name.endsWith('.json')))throw new Error('An existing Google login is already present. Validate or disconnect it before adding another account.');
  let state='',received=false,authorizationURL='';
  let finish;
  const result=new Promise((resolve,reject)=>{finish={resolve,reject};});
  // Register a rejection handler before browser/process callbacks can reject it.
  result.catch(()=>{});
  const controller=new AbortController();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'");
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&url.pathname==='/login'){
      if(received||!authorizationURL){res.statusCode=409;return res.end('This login is not available. Return to Codex.');}
      res.statusCode=302;res.setHeader('location',authorizationURL);return res.end();
    }
    if(req.method!=='GET'||url.pathname!=='/oauth-callback'){res.statusCode=404;return res.end('Not found.');}
    if(!same(url.searchParams.get('state'),state)){res.statusCode=403;return res.end('Login session mismatch. Reopen login from the gateway.');}
    if(received){res.statusCode=409;return res.end('This login callback has already been received.');}
    if(url.searchParams.get('error')){received=true;res.statusCode=400;res.end('Google login was cancelled. You may close this page.');return finish.reject(new Error('Google login was cancelled.'));}
    const code=url.searchParams.get('code');
    if(!code||code.length>16384){res.statusCode=400;return res.end('Missing Google authorization code.');}
    received=true;
    try {
      await call(control,'POST','callback',{provider:'antigravity',state,code},controller.signal);
      res.end('<!doctype html><meta charset="utf-8"><title>Gemini 登录</title><p>已收到 Google 授权。请回到 Codex，正在检查登录结果。</p>');
      finish.resolve();
    }catch(error){res.statusCode=502;res.end('The local login service could not accept this callback. Return to Codex.');finish.reject(error);}
  });
  await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error('The local Google login callback port is already in use.')));server.listen(callbackPort,'127.0.0.1',resolve);});
  const timer=setTimeout(()=>finish.reject(new Error('Google login timed out. Start login again.')),timeoutMs);
  try {
    const auth=await call(control,'POST','auth-url',{provider:'antigravity',is_webui:false},controller.signal);
    const target=new URL(auth.url);
    if(target.protocol!=='https:'||target.hostname!=='accounts.google.com'||typeof auth.state!=='string'||auth.state.length<16)throw new Error('The local service returned an unexpected Google login address.');
    state=auth.state;
    if(!same(target.searchParams.get('state'),state))throw new Error('Google login state did not match.');
    const redirect=new URL(target.searchParams.get('redirect_uri'));
    if(redirect.protocol!=='http:'||!['localhost','127.0.0.1'].includes(redirect.hostname)||redirect.port!==String(callbackPort)||redirect.pathname!=='/oauth-callback')throw new Error('Unexpected Google callback address.');
    authorizationURL=target.href;
    await open(target.href);
    notify({stage:'waiting_for_google_login',callbackHost:'127.0.0.1',callbackPort});
    await result;
    for(let attempt=0;attempt<90;attempt++){
      const status=await call(control,'GET','status?state='+encodeURIComponent(state),null,controller.signal);
      if(status.status==='ok'||status.status==='success')return {authenticated:true};
      if(status.status==='error'||status.error)throw new Error('Google authorization was not accepted. Check the account eligibility in the browser.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('Google login processing did not finish in time.');
  } finally {
    clearTimeout(timer);
    if(state)await call(control,'DELETE','session?state='+encodeURIComponent(state),null).catch(()=>{});
    controller.abort();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
if(require.main===module){login(process.argv[2]||'',{notify:value=>console.log(JSON.stringify(value))}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={login,management,loadControl,same};
