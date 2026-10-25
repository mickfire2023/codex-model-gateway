'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {rescueDirectory,recoverConfigText}=require('../../gateway/rescue.cjs');
const implementation=path.resolve(__dirname,'../../gateway/rescue.cjs');
const TOKEN='synthetic_rescue_route_123456';
const owned='http://127.0.0.1:2156/'+TOKEN+'/backend-api/codex';
const plugin='[mcp_servers.synthetic]\ncommand = "keep-plugin"\nargs = ["one", "two"]\n';

function fixture(t,{config,settings={}}={}) {
  const directory=fs.mkdtempSync(path.join(__dirname,'.rescue-中文 space-'));
  fs.mkdirSync(path.join(directory,'private'));
  const configPath=path.join(directory,'config.toml');
  const value=config ?? `openai_base_url = '${owned}'\nmodel = "gpt-synthetic"\n${plugin}`;
  fs.writeFileSync(configPath,value);
  const stored={port:2156,routeToken:TOKEN,previousBaseUrlLine:null,previousCatalogLine:null,lifecycle:{configPath},...settings};
  const settingsPath=path.join(directory,'private','settings.json');
  fs.writeFileSync(settingsPath,JSON.stringify(stored));
  t.after(()=>{
    const resolved=path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(__dirname)+path.sep)&&path.basename(resolved).startsWith('.rescue-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return {directory,configPath,settingsPath,settings:stored,original:Buffer.from(value),read:()=>fs.readFileSync(configPath),saveSettings(next){fs.writeFileSync(settingsPath,JSON.stringify(next));},backups:()=>fs.readdirSync(path.join(directory,'private')).filter(name=>name.startsWith('config.before-emergency-'))};
}
test('emergency recovery removes only its owned base, preserves plugins, and makes a private exact backup',t=>{
  const f=fixture(t);
  const result=rescueDirectory(f.directory);
  assert.equal(result.changed,true);
  assert.equal(result.restoredConnection,true);
  assert.equal(f.read().toString(),`model = "gpt-synthetic"\n${plugin}`);
  assert.deepEqual(fs.readFileSync(result.backupPath),f.original);
  assert.equal(path.dirname(result.backupPath),path.join(f.directory,'private'));
});
test('restores the exact saved original base and catalog without replacing later model or plugin settings',t=>{
  const f=fixture(t,{settings:{previousBaseUrlLine:"openai_base_url = 'https://original.example.test/backend'",previousCatalogLine:"model_catalog_json = 'C:\\original\\models.json'"}});
  const result=rescueDirectory(f.directory);
  assert.equal(result.changed,true);
  assert.match(f.read().toString(),/^model_catalog_json = 'C:\\original\\models.json'\nopenai_base_url = 'https:\/\/original\.example\.test\/backend'/);
  assert.ok(f.read().toString().endsWith(`model = "gpt-synthetic"\n${plugin}`));
});
test('future connection and catalog settings are left byte-for-byte untouched without a new backup',t=>{
  const config=`openai_base_url = 'https://future.example.test/backend'\nmodel_catalog_json = 'C:\\future\\models.json'\n${plugin}`;
  const f=fixture(t,{config});
  assert.equal(rescueDirectory(f.directory).changed,false);
  assert.deepEqual(f.read(),f.original);
  assert.equal(f.backups().length,0);
});
test('an owned catalog is restored independently while a future base is retained',t=>{
  const f=fixture(t);
  const catalog=path.join(f.directory,'combined-models.json');
  fs.writeFileSync(f.configPath,`openai_base_url = 'https://future.example.test/backend'\nmodel_catalog_json = '${catalog}'\n${plugin}`);
  const result=rescueDirectory(f.directory);
  assert.equal(result.restoredConnection,false);
  assert.equal(result.restoredCatalog,true);
  assert.equal(f.read().toString(),`openai_base_url = 'https://future.example.test/backend'\n${plugin}`);
});
test('a future catalog survives recovery of an owned gateway base',t=>{
  const f=fixture(t,{config:`openai_base_url = '${owned}'\nmodel_catalog_json = 'C:\\future\\models.json'\n${plugin}`,settings:{previousCatalogLine:"model_catalog_json = 'C:\\original\\models.json'"}});
  const result=rescueDirectory(f.directory);
  assert.equal(result.restoredConnection,true);
  assert.equal(result.restoredCatalog,false);
  assert.equal(f.read().toString(),`model_catalog_json = 'C:\\future\\models.json'\n${plugin}`);
});
test('legacy physical and logical owned catalog aliases compare as Windows paths',t=>{
  const legacy='C:\\Users\\Fixture\\AppData\\Local\\Packages\\OpenAI.Codex_fixture\\LocalCache\\Local\\CodexModelGateway\\combined-models.json';
  const f=fixture(t,{config:`model_catalog_json = '${legacy.toUpperCase()}'\n${plugin}`});
  f.settings.lifecycle.ownedCatalogPaths=[legacy];f.saveSettings(f.settings);
  assert.equal(rescueDirectory(f.directory).restoredCatalog,true);
  assert.equal(f.read().toString(),plugin);
});
test('repeated emergency recovery does not rewrite the file or create repeated backups',t=>{
  const f=fixture(t);
  rescueDirectory(f.directory);
  const first=f.read();
  assert.equal(rescueDirectory(f.directory).changed,false);
  assert.deepEqual(f.read(),first);
  assert.equal(f.backups().length,1);
});
test('BOM, CRLF, unrelated comments and existing nested table bytes are preserved',t=>{
  const suffix='model = "gpt-synthetic"\r\n# preserve this comment\r\n[mcp_servers.synthetic]\r\ncommand = "keep-plugin"\r\n';
  const f=fixture(t,{config:`\uFEFF  openai_base_url = '${owned}' # gateway only\r\n${suffix}`});
  rescueDirectory(f.directory);
  assert.equal(f.read().toString(),'\uFEFF'+suffix);
});
test('multiline instruction contents are not mistaken for root settings or table headers',t=>{
  const instructions='instructions = """\n[not_a_table]\nopenai_base_url = \'private-historical-text\'\n"""\n';
  const f=fixture(t,{config:instructions+`openai_base_url = '${owned}'\n`+plugin});
  rescueDirectory(f.directory);
  assert.equal(f.read().toString(),instructions+plugin);
});
test('nested table connection-looking keys do not count as owned root settings',t=>{
  const f=fixture(t,{config:`model = "gpt-synthetic"\n[profiles.other]\nopenai_base_url = '${owned}'\n`});
  assert.equal(rescueDirectory(f.directory).changed,false);
  assert.deepEqual(f.read(),f.original);
});
test('invalid, duplicate, quoted and dotted root targets are rejected before any write',t=>{
  for(const config of [
    `openai_base_url = '${owned}'\nopenai_base_url = '${owned}'\n`,
    'openai_base_url = 17\n',
    `"openai_base_url" = '${owned}'\n`,
    `"openai_base_url".child = '${owned}'\n`,
    `openai_base_url.child = '${owned}'\n`,
    "openai_base_url = 'unterminated\n",
    'openai_base_url = "bad\\qescape"\n',
    'model ??? sensitive-config-body\n',
    'args = ["unfinished"\n',
    'instructions = """unfinished\n'
  ]) {
    const f=fixture(t,{config});
    assert.throws(()=>rescueDirectory(f.directory),error=>['invalid_config','unsupported_config'].includes(error.code)&&!error.message.includes('sensitive-config-body'));
    assert.deepEqual(f.read(),f.original);
    assert.equal(f.backups().length,0);
  }
});
test('malformed saved original settings cannot inject additional TOML keys',t=>{
  for(const previousBaseUrlLine of ["model = 'changed'", "openai_base_url = 'https://original.example.test'\nmodel = 'changed'",'openai_base_url = 42']) {
    const f=fixture(t,{settings:{previousBaseUrlLine}});
    assert.throws(()=>rescueDirectory(f.directory),error=>['invalid_backup','invalid_config'].includes(error.code));
    assert.deepEqual(f.read(),f.original);
  }
});
test('a failed atomic rename leaves the original configuration usable and cleans temporary files',t=>{
  const f=fixture(t);
  const io={...fs,renameSync(){throw Object.assign(new Error('synthetic failure'),{code:'EPERM'});}};
  assert.throws(()=>rescueDirectory(f.directory,{fs:io}),{code:'recovery_write_failed'});
  assert.deepEqual(f.read(),f.original);
  assert.equal(fs.readdirSync(f.directory).some(name=>name.includes('.rescue-')&&name.endsWith('.tmp')),false);
});
test('a concurrent settings edit is preserved instead of overwritten',t=>{
  const f=fixture(t);let reads=0;
  const future=Buffer.from(`openai_base_url = 'https://future.example.test/backend'\n${plugin}`);
  const io={...fs,readFileSync(file,...args){if(file===f.configPath&&++reads===2)fs.writeFileSync(file,future);return fs.readFileSync(file,...args);}};
  assert.throws(()=>rescueDirectory(f.directory,{fs:io}),{code:'config_changed'});
  assert.deepEqual(f.read(),future);
});
test('recovery never reads auth, key or PID files and never sends a process signal',t=>{
  const f=fixture(t),reads=[];
  for(const name of ['auth.json','deepseek-key.dpapi','gateway.pid'])fs.writeFileSync(path.join(f.directory,'private',name),'do-not-read');
  const io={...fs,readFileSync(file,...args){reads.push(file);return fs.readFileSync(file,...args);}};
  const originalKill=process.kill;let signals=0;
  process.kill=()=>{signals++;throw new Error('No signal expected');};
  try{rescueDirectory(f.directory,{fs:io});}finally{process.kill=originalKill;}
  assert.equal(signals,0);
  assert.ok(reads.every(file=>file===f.configPath||file===f.settingsPath));
});
test('relative paths, non-TOML config paths, malformed JSON and invalid gateway identities fail closed',t=>{
  assert.throws(()=>rescueDirectory('relative'),{code:'invalid_path'});
  for(const mutate of [s=>{s.lifecycle.configPath='relative/config.toml';},s=>{s.lifecycle.configPath=path.join(__dirname,'auth.json');},s=>{s.port=0;},s=>{s.routeToken='bad';}]){
    const f=fixture(t);mutate(f.settings);f.saveSettings(f.settings);
    assert.throws(()=>rescueDirectory(f.directory),error=>['invalid_path','invalid_settings'].includes(error.code));
    assert.deepEqual(f.read(),f.original);
  }
  const f=fixture(t);fs.writeFileSync(f.settingsPath,'broken-json');
  assert.throws(()=>rescueDirectory(f.directory),{code:'settings_unavailable'});
  assert.deepEqual(f.read(),f.original);
});
test('the CLI works from another working directory with Unicode/spaces and does not print private config',t=>{
  const f=fixture(t,{config:`openai_base_url = '${owned}'\nprivate_fixture = "not-for-console"\n${plugin}`});
  const result=spawnSync(process.execPath,[implementation,'--directory',f.directory],{cwd:path.dirname(__dirname),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Original GPT connection restored/);
  assert.equal((result.stdout+result.stderr).includes(TOKEN),false);
  assert.equal((result.stdout+result.stderr).includes('not-for-console'),false);
  assert.equal(f.read().toString(),`private_fixture = "not-for-console"\n${plugin}`);
});
test('the CLI rejects missing, duplicate and unsupported arguments without changing config',t=>{
  const f=fixture(t);
  for(const args of [[],['--directory'],['--directory',f.directory,'--directory',f.directory],['--config',f.configPath]]){
    const result=spawnSync(process.execPath,[implementation,...args],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);
    assert.deepEqual(f.read(),f.original);
  }
});
