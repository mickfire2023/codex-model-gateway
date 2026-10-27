'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

test('Windows runner allocates no child console and drains both diagnostic pipes',{
  skip:process.platform!=='win32',timeout:90000,
},async()=>{
  const binary=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const result=await run(binary,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'runner-console.test.ps1')],{windowsHide:true,timeout:80000,maxBuffer:2*1024*1024});
  assert.match(result.stdout,/PASS: \d+ isolated runner checks/);
  assert.doesNotMatch(result.stderr,/Exception|ErrorRecord|CategoryInfo/);
});
