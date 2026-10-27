'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {validateSignatureWire}=require('../../scripts/validate-antigravity-signature.cjs');

// Optional local-only executable check. No installed service or OAuth data.
test('known Antigravity binary preserves only its supported synthetic Claude signature channels',{
  skip:!process.env.CLIPROXYAPI_SIGNATURE_TEST_BINARY&&'Set CLIPROXYAPI_SIGNATURE_TEST_BINARY to a manifest-verified Windows binary.',
  timeout:60000,
},async()=>{
  const result=await validateSignatureWire(process.env.CLIPROXYAPI_SIGNATURE_TEST_BINARY);
  assert.equal(result.ok,true);
  assert.equal(result.usesRealAccount,false);
  assert.equal(result.evidence,'binary-local-signature-wire');
  assert.deepEqual(result.captures.map(row=>[row.channel,row.thinkingPreserved]),[[18,true],[19,result.channel19Supported],[20,false]]);
  assert.ok(result.captures.filter(row=>row.thinkingPreserved).every(row=>row.exactSyntheticSignature===true));
});
