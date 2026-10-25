'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {inspect}=require('../../scripts/check-release.cjs');
test('source distribution contains empty account catalogs and an explicit install entry',()=>{
  for(const file of ['openai-models.json','deepseek-models.json'])assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'gateway',file),'utf8')),{models:[]});
  assert.ok(fs.existsSync(path.join(root,'install.ps1')));
  assert.ok(fs.existsSync(path.join(root,'package-lock.json')));
});
test('release audit rejects private data and executable runtime files',()=>{
  const rejected=inspect(['gateway/private/settings.json','bridge/private/auth/account.json','runtime/node.exe','provider.dpapi','gateway.log']);
  assert.equal(rejected.length,5);
  assert.deepEqual(inspect(['README.md','gateway/gateway.cjs']),[]);
});
test('optional subscription setup requires an explicit opt-in and a pinned binary hash',()=>{
  const script=fs.readFileSync(path.join(root,'scripts/install-gemini.ps1'),'utf8');
  assert.match(script,/if \(-not \$AcceptThirdPartyTerms\)/);
  assert.match(script,/Get-FileHash.*SHA256/);
  assert.ok(script.indexOf('Get-FileHash')<script.indexOf("'start.ps1'"));
});
