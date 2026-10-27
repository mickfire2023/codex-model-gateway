'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const manifest=require('../../bridge/binary-manifest.json');
const {initialize,resolveBinaryHash}=require('../../bridge/initialize.cjs');
const fixtures=path.join(__dirname,'fixtures');fs.mkdirSync(fixtures,{recursive:true});
function fixture(){return fs.mkdtempSync(path.join(fixtures,'binary-manifest-'));}
function cleanup(root){const actual=fs.realpathSync(root);if(!actual.startsWith(fs.realpathSync(fixtures)+path.sep))throw Error('Fixture escaped');fs.rmSync(actual,{recursive:true});}

test('only the exact official and compatibility hashes identify a supported executable',()=>{
  const official=resolveBinaryHash(manifest.official.sha256),patched=resolveBinaryHash(manifest.patched.sha256);
  assert.equal(official.claudeQ19,false);assert.equal(patched.claudeQ19,true);assert.equal(patched.release,'8.0.43-gateway.1');
  assert.throws(()=>resolveBinaryHash('f'.repeat(64)),/verified release/);
  assert.throws(()=>resolveBinaryHash(manifest.patched.sha256.toUpperCase()),/Invalid/);
  const duplicate=structuredClone(manifest);duplicate.patched.sha256=duplicate.official.sha256;
  assert.throws(()=>resolveBinaryHash(duplicate.official.sha256,duplicate),/Ambiguous/);
});

test('binary verification precedes account/control creation and metadata describes the verified build',()=>{
  const root=fixture();try{
    const data='Synthetic compatible bridge binary';fs.writeFileSync(path.join(root,'cli-proxy-api.exe'),data);
    assert.throws(()=>initialize(root),/verified release/);assert.equal(fs.existsSync(path.join(root,'private')),false);
    const synthetic=structuredClone(manifest);synthetic.patched.sha256=crypto.createHash('sha256').update(data).digest('hex');
    initialize(root,{binaryManifest:synthetic});const metadata=JSON.parse(fs.readFileSync(path.join(root,'bridge.json'),'utf8'));
    assert.equal(metadata.release,synthetic.patched.release);assert.equal(metadata.binarySha256,synthetic.patched.sha256);assert.deepEqual(metadata.claudeSignatureChannels,[18,19]);
  }finally{cleanup(root);}
});

test('the published patch is pinned and changes only the known channel allowlist plus synthetic regressions',()=>{
  const patch=fs.readFileSync(path.resolve(__dirname,'../../vendor-patches/cliproxyapi-8.0.43-q19.patch'));
  assert.equal(crypto.createHash('sha256').update(patch).digest('hex'),manifest.source.patchSha256);
  assert.match(patch.toString(),/info\.ChannelID != 18 && info\.ChannelID != 19/);
  assert.match(patch.toString(),/\[\]byte\{18, 19, 20\}/);
  assert.equal(manifest.patched.sha256==='0'.repeat(64),false);
});
