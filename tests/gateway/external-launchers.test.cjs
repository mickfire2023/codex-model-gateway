'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'../../gateway');
const outputs=path.dirname(source);
const windows=process.env.SystemRoot || 'C:\\Windows';
const cscript=path.join(windows,'System32','cscript.exe');
const cmd=path.join(windows,'System32','cmd.exe');
const names=[['打开模型网关.vbs','Open-dashboard.ps1'],['恢复GPT直连.vbs','restore.ps1'],['重新启用模型网关.vbs','enable.ps1']];
const stub=String.raw`param([string]$Directory,[switch]$ShowMessage)
$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($Directory)) { throw 'Directory was not passed.' }
$called=[ordered]@{directory=$Directory;scriptRoot=$PSScriptRoot;showMessage=[bool]$ShowMessage}
[IO.File]::WriteAllText((Join-Path $Directory 'called.json'),($called|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
exit 0
`;
function fixture(t,{legacy=false,empty=false}={}){
  const profile=fs.mkdtempSync(path.join(__dirname,'.launcher-中文 \u{1f9ea} space-'));
  const documents=path.join(profile,'Documents','CodexModelGateway');
  const previous=path.join(profile,'AppData','Local','Packages','OpenAI.Codex_2p2nqsd0c76g0','LocalCache','Local','CodexModelGateway');
  const root=legacy?previous:documents;
  if(!empty){fs.mkdirSync(path.join(root,'private'),{recursive:true});fs.writeFileSync(path.join(root,'private','settings.json'),'{}');for(const [,name]of names)fs.writeFileSync(path.join(root,name),stub);}
  t.after(()=>{const checked=path.resolve(profile);assert.ok(checked.startsWith(path.resolve(__dirname)+path.sep)&&path.basename(checked).startsWith('.launcher-'));fs.rmSync(checked,{recursive:true,force:true});});
  const env={...process.env,USERPROFILE:profile,LOCALAPPDATA:path.join(profile,'AppData','Local')};
  const invoke=(exe,file,args=[])=>spawnSync(exe,['//B','//NoLogo',file,...args],{cwd:path.dirname(__dirname),env,encoding:'utf8',windowsHide:true,timeout:20000});
  return {profile,documents,previous,root,env,invoke,called:()=>JSON.parse(fs.readFileSync(path.join(root,'called.json'),'utf8'))};
}
test('all three output VBS entries run real PS5 from another CWD and pass the Documents directory explicitly',t=>{
  const f=fixture(t);
  for(const [name,script]of names){
    const result=f.invoke(cscript,path.join(outputs,name));
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
    assert.equal(f.called().directory,f.root);
    assert.equal(f.called().scriptRoot,f.root);
    assert.equal(f.called().showMessage,script!=='Open-dashboard.ps1');
  }
});
test('output entries find only the exact physical legacy package directory when Documents is absent',t=>{
  const f=fixture(t,{legacy:true});
  fs.mkdirSync(path.join(f.profile,'Documents','CodexModelGateway.rollback-fixture','private'),{recursive:true});
  fs.writeFileSync(path.join(f.profile,'Documents','CodexModelGateway.rollback-fixture','private','settings.json'),'{}');
  for(const [name]of names){const result=f.invoke(cscript,path.join(outputs,name));assert.equal(result.status,0,result.stderr);assert.equal(f.called().directory,f.previous);}
});
test('a partial Documents installation does not silently run an older legacy operation',t=>{
  const f=fixture(t,{legacy:true});
  fs.mkdirSync(path.join(f.documents,'private'),{recursive:true});fs.writeFileSync(path.join(f.documents,'private','settings.json'),'{}');
  for(const [name]of names){
    const result=f.invoke(cscript,path.join(outputs,name));
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/required gateway script.*missing/is);
    assert.doesNotMatch(result.stderr,/[^\x00-\x7f]/);
    assert.ok(result.stderr.includes('\\uD83E\\uDDEA'));
  }
  assert.equal(fs.existsSync(path.join(f.previous,'called.json')),false);
});

test('installed launcher reports an incomplete Unicode installation without losing its failure exit code',t=>{
  const f=fixture(t),file=path.join(f.root,'launch.vbs');
  fs.copyFileSync(path.join(source,'launch.vbs'),file);
  fs.unlinkSync(path.join(f.root,'Open-dashboard.ps1'));
  const result=f.invoke(cscript,file,['dashboard']);
  assert.equal(result.status,1);
  assert.match(result.stderr,/installation is incomplete/i);
  assert.doesNotMatch(result.stderr,/[^\x00-\x7f]/);
  assert.ok(result.stderr.includes('\\uD83E\\uDDEA'));
});
test('missing installs fail visibly without searching rollback, test, or source directories',t=>{
  const f=fixture(t,{empty:true});
  const result=f.invoke(cscript,path.join(outputs,'恢复GPT直连.vbs'));
  assert.equal(result.status,1);
  assert.match(result.stderr,/not found.*emergency/is);
});
test('PowerShell operation failure is propagated rather than reported as success',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'restore.ps1'),stub.replace('exit 0','exit 17'));
  const result=f.invoke(cscript,path.join(outputs,'恢复GPT直连.vbs'));
  assert.equal(result.status,17);
  assert.match(result.stderr,/operation did not complete/i);
});
test('installed shared launcher resolves its own directory and rejects unsupported operations',t=>{
  const f=fixture(t);
  const file=path.join(f.root,'launch.vbs');fs.copyFileSync(path.join(source,'launch.vbs'),file);
  for(const action of ['dashboard','restore','enable']){const result=f.invoke(cscript,file,[action]);assert.equal(result.status,0,result.stderr);assert.equal(f.called().directory,f.root);}
  for(const args of [[],['untrusted'],['restore','extra']]){const result=f.invoke(cscript,file,args);assert.equal(result.status,1);}
});
test('published launchers contain concrete script names and the dashboard wrapper forwards to the installed helper',()=>{
  for(const [name,script]of names){const value=fs.readFileSync(path.join(outputs,name),'utf8');assert.equal(value.includes('${'),false);assert.ok(value.includes('\\'+script+'"'));assert.ok(value.includes('-Directory'));}
  const value=fs.readFileSync(path.join(source,'Open-dashboard.vbs'),'utf8');
  assert.ok(value.includes('\\launch.vbs'));
  assert.ok(value.includes('dashboard'));
});
function installRescue(f,{code=true}={}){
  fs.mkdirSync(path.join(f.root,'runtime'),{recursive:true});
  try{fs.linkSync(process.execPath,path.join(f.root,'runtime','node.exe'));}catch{fs.copyFileSync(process.execPath,path.join(f.root,'runtime','node.exe'));}
  if(code)fs.copyFileSync(path.join(source,'rescue.cjs'),path.join(f.root,'rescue.cjs'));
  const config=path.join(f.profile,'config.toml');
  fs.writeFileSync(config,"openai_base_url = 'http://127.0.0.1:2156/synthetic_rescue_route_123456/backend-api/codex'\nmodel = 'gpt-synthetic'\n[plugins.fixture]\nenabled = true\n");
  fs.writeFileSync(path.join(f.root,'private','settings.json'),JSON.stringify({port:2156,routeToken:'synthetic_rescue_route_123456',previousBaseUrlLine:null,previousCatalogLine:null,lifecycle:{configPath:config}}));
  return config;
}
function invokeCmd(f,file){return spawnSync(cmd,['/d','/s','/c','""'+file+'""'],{windowsVerbatimArguments:true,cwd:path.dirname(__dirname),env:{...f.env,PATH:''},input:'\r\n',encoding:'utf8',windowsHide:true,timeout:15000});}
test('output emergency CMD restores GPT using only its own Node runtime with PowerShell absent from PATH',t=>{
  const f=fixture(t),config=installRescue(f);
  const result=invokeCmd(f,path.join(outputs,'紧急恢复GPT.cmd'));
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/Original GPT connection restored/i);
  assert.equal(fs.readFileSync(config,'utf8'),"model = 'gpt-synthetic'\n[plugins.fixture]\nenabled = true\n");
});
test('the installed emergency CMD works from another CWD without VBS or PowerShell',t=>{
  const f=fixture(t),config=installRescue(f);
  const file=path.join(f.root,'Emergency-restore-GPT.cmd');fs.copyFileSync(path.join(source,'Emergency-restore-GPT.cmd'),file);
  const result=invokeCmd(f,file);
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/Original GPT connection restored/i);
  assert.doesNotMatch(fs.readFileSync(config,'utf8'),/openai_base_url/);
});
test('legacy emergency CMD can use the adjacent release rescue code before migration is installed',t=>{
  const f=fixture(t,{legacy:true}),config=installRescue(f,{code:false});
  const result=invokeCmd(f,path.join(outputs,'紧急恢复GPT.cmd'));
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.doesNotMatch(fs.readFileSync(config,'utf8'),/openai_base_url/);
});
test('emergency CMD reports malformed settings and keeps the existing file',t=>{
  const f=fixture(t),config=installRescue(f),before=fs.readFileSync(config);
  fs.writeFileSync(path.join(f.root,'private','settings.json'),'malformed-json');
  const result=invokeCmd(f,path.join(outputs,'紧急恢复GPT.cmd'));
  assert.equal(result.status,1);
  assert.match(result.stdout,/Recovery did not complete/i);
  assert.deepEqual(fs.readFileSync(config),before);
});
