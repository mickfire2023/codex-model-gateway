'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {validateThinkingWire,CASES}=require('../../scripts/validate-antigravity-thinking.cjs');

// This optional integration check never uses the installed bridge or account.
// Supply the official pinned Windows executable to run actual binary captures:
// $env:CLIPROXYAPI_TEST_BINARY='C:\\...\\cli-proxy-api.exe'
test('pinned Antigravity binary translates selectable efforts on a local fixture only',{
  skip:!process.env.CLIPROXYAPI_TEST_BINARY&&'Set CLIPROXYAPI_TEST_BINARY to the verified 8.0.43 Windows binary.',
  timeout:60000,
},async()=>{
  const result=await validateThinkingWire(process.env.CLIPROXYAPI_TEST_BINARY);
  assert.equal(result.ok,true);
  assert.equal(result.evidence,'pinned-binary-local-wire');
  assert.equal(result.usesRealAccount,false);
  assert.equal(result.backendVariableEffortVerified,false);
  assert.equal(result.captures.length,CASES.length);
});
